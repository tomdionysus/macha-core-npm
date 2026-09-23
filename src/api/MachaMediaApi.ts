import type { ArtworkSource, CatalogueApi, CatalogueArtwork, CatalogueItem } from './CatalogueApi.js';
import type { MediaApi } from './MediaApi.js';
import type {
  AlbumDetails,
  ArtistDetails,
  Artwork,
  ArtworkRef,
  Episode,
  LibraryHome,
  MediaDetails,
  MediaSummary,
  MusicHierarchyContext,
  SeasonDetails,
  SeasonSummary,
  ShowDetails,
} from '../types.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import { ArtworkHostPreference } from '../state/artworkHost.js';
import { abortError } from '../errors.js';
import { episodeSubtitle } from '../episodeLabel.js';
import { DEFAULT_SEARCH_CATEGORIES, SEARCH_CATEGORIES } from '../searchCategories.js';
import { joinSubtitle } from '../subtitleJoin.js';
import { trackSubtitle } from '../musicLabel.js';
import type { MediaSearchOptions } from './MediaApi.js';
import { isSearchable, searchTerms } from '../searchTerms.js';

/** How many hits a search returns. */
const SEARCH_PAGE_SIZE = 50;
/**
 * How many to ask the catalogue for when a category filter will discard some.
 * A guess: enough that one kind rarely runs short, well under the server's
 * cap of 1000. Moves to the server if it ever takes a kind.
 */
const SEARCH_FILTERED_FETCH_LIMIT = 200;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError('Artwork consumer cancelled.');
}

function consumeArtwork(promise: Promise<Blob>, signal?: AbortSignal): Promise<Blob> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((blob) => {
      signal.removeEventListener('abort', onAbort);
      resolve(blob);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/**
 * Whether a capability URL's own `exp` has passed. The server signs the
 * expiry into the URL, so this is answerable without asking a node — and has
 * to be, since the alternative is learning it from four refusals in a row.
 *
 * **When this actually fires, as of server `0.40.0`.** The server quantises
 * the expiry — `(now / ttl + 2) * ttl`, floor to the current bucket then add
 * two — and **the bucket is the TTL**, so the invariant is a relationship
 * rather than a duration: remaining validity is always **more than one TTL and
 * at most two**, whatever the TTL is configured to be. The artwork response's
 * own `max-age` is that same TTL, so the floor is *strictly* greater than it
 * and **a cached copy can never outlive the signature that names it**, at any
 * point in the cycle, on any cluster.
 *
 * Stated as a relationship deliberately. With the default 24 h TTL it works
 * out as (24 h, 48 h] behind `max-age=86400`, and writing *that* down would
 * quietly become false the first time a cluster reconfigured the TTL — which
 * is the same trap as a stall budget written as a number instead of against
 * `SERVER_SEGMENT_HOLD_MS`.
 *
 * (The "plus two" rather than "next boundary" is the whole point: a naive
 * bucket would hand a URL minted a millisecond before the boundary a lifetime
 * of almost nothing, behind a full-TTL cache directive, invisibly to the
 * client holding it.)
 *
 * So a capability from a *freshly read* catalogue payload is never expired
 * here, and this guard exists for one case: **a payload held across a bucket
 * boundary** — persisted state, a long-lived cache, a client resuming after a
 * long idle. Worth knowing before treating a hit as a server fault.
 *
 * **`exp` is unix milliseconds, not seconds.** Earlier builds computed it as
 * `unix_ms() + ttl` per call and verified it as `unix_ms() >= expires`, where
 * `unix_ms()` is a `duration_cast<milliseconds>` of the system clock
 * (`src/types.cpp`); a capability observed on the wire carries a
 * thirteen-digit value. That is unusual — JWT's `exp` is seconds, and most
 * things that look like this are too — so it is worth stating rather than
 * inferring, because getting it wrong fails silently in the safe-looking
 * direction: seconds compared against `Date.now()` make every live
 * capability look long expired, no alternate is ever offered, and the
 * failover simply never happens while every test still passes.
 *
 * `Date.now()` is deliberate here and must not become `machaHost().now()`.
 * That clock is documented as milliseconds from an arbitrary origin, for
 * measuring durations, and is `performance.now()` wherever the host has it.
 * This is a comparison against an absolute instant chosen by another
 * machine, which is the one thing that clock cannot answer.
 */
function expiredCapability(url: string): boolean {
  const expiry = /[?&]exp=(\d+)/.exec(url);
  return expiry !== null && Number(expiry[1]) <= Date.now();
}

function optionalNumber(value: number | null): number | undefined {
  return value ?? undefined;
}

export class MachaMediaApi implements MediaApi {
  private readonly artworkCache = new Map<string, Blob>();
  private readonly artworkRequests = new Map<string, Promise<Blob>>();
  private readonly log = createClientLogger('artwork.api');
  private readonly artworkHost: ArtworkHostPreference;

  constructor(
    private readonly catalogue: CatalogueApi,
    artworkHost: ArtworkHostPreference = new ArtworkHostPreference(),
  ) {
    this.artworkHost = artworkHost;
  }

  status(signal?: AbortSignal) {
    return this.catalogue.status(signal);
  }

  mediaProfile(mediaId: string, signal?: AbortSignal) {
    return this.catalogue.mediaProfile(mediaId, signal);
  }

  async home(signal?: AbortSignal): Promise<LibraryHome> {
    const [movies, shows, albums] = await Promise.all([this.movies(signal), this.shows(signal), this.albums(signal)]);
    return { movies, shows, albums };
  }

  async movies(signal?: AbortSignal): Promise<MediaSummary[]> {
    return (await this.catalogue.list('movie', undefined, signal)).map((item) => this.media(item));
  }

  async shows(signal?: AbortSignal): Promise<MediaSummary[]> {
    return (await this.catalogue.list('show', undefined, signal)).map((item) => this.media(item));
  }

  async artists(signal?: AbortSignal): Promise<MediaSummary[]> {
    return (await this.catalogue.list('artist', undefined, signal)).map((item) => this.media(item));
  }

  async albums(signal?: AbortSignal): Promise<MediaSummary[]> {
    return (await this.catalogue.list('album', undefined, signal)).map((item) => this.media(item));
  }

  /**
   * Every track, each naming its album and artist.
   *
   * Two more list reads, albums and artists, rather than a read per album:
   * the whole library is being listed anyway. If either fails, the tracks
   * still come back, without the context that read would have supplied.
   */
  async tracks(signal?: AbortSignal): Promise<MediaSummary[]> {
    const [tracks, albums, artists] = await Promise.all([
      this.catalogue.list('track', undefined, signal),
      this.catalogue.list('album', undefined, signal).catch(() => [] as CatalogueItem[]),
      this.catalogue.list('artist', undefined, signal).catch(() => [] as CatalogueItem[]),
    ]);
    if (signal?.aborted) throw abortReason(signal);
    const known = new Map([...albums, ...artists].map((item) => [item.id, item]));
    return tracks.map((item) => this.track(item, known));
  }

  async details(id: string, signal?: AbortSignal): Promise<MediaDetails> {
    const item = await this.catalogue.get(id, signal);

    if (item.kind === 'show') {
      const seasonItems = await this.catalogue.list('season', item.id, signal);
      const seasons = seasonItems
        .map((seasonItem) => this.seasonSummary(seasonItem, item.id))
        .sort((a, b) => a.seasonNumber - b.seasonNumber);
      return {
        ...this.media(item),
        kind: 'show',
        seasons,
      } as ShowDetails;
    }

    if (item.kind === 'season') {
      const [show, episodeItems] = await Promise.all([
        this.catalogue.get(this.parentId(item), signal),
        this.catalogue.list('episode', item.id, signal),
      ]);
      const episodes = episodeItems
        .map((episode) => this.episode(episode, item, show))
        .sort((a, b) => a.episodeNumber - b.episodeNumber);
      return {
        ...this.seasonSummary(item, show.id),
        episodes,
      } as SeasonDetails;
    }

    if (item.kind === 'episode') {
      const season = await this.catalogue.get(this.parentId(item), signal);
      const show = await this.catalogue.get(this.parentId(season), signal);
      return this.episode(item, season, show);
    }

    if (item.kind === 'artist') {
      const albums = (await this.catalogue.list('album', item.id, signal))
        .map((album) => this.media(album))
        .sort((a, b) => (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title));
      return {
        ...this.media(item),
        kind: 'artist',
        albums,
      } as ArtistDetails;
    }

    if (item.kind === 'album') {
      const [trackItems, artist] = await Promise.all([
        this.catalogue.list('track', item.id, signal),
        item.parent_id ? this.catalogue.get(item.parent_id, signal).catch(() => undefined) : undefined,
      ]);
      if (signal?.aborted) throw abortReason(signal);
      const context = this.musicContext(item, artist);
      const tracks = trackItems
        .map((track) => ({ ...this.media(track), musicContext: context }))
        .sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
      return {
        ...this.media(item),
        kind: 'album',
        tracks,
      } as AlbumDetails;
    }

    return this.media(item);
  }

  /**
   * Search hits, each carrying its ancestry the way a detail page would.
   *
   * The catalogue search returns bare items holding only `parent_id`, so an
   * episode found by search could say "S01E01" and not which series, and every
   * client would otherwise walk the parents itself. Here:
   * - an episode gets `playbackContext` and a subtitle such as "Firefly · Season 1
   *   Episode 1", per `episodeLabel`;
   * - a season gets `showId` and a subtitle such as "Firefly · Season 1";
   * - a track gets `musicContext` and a subtitle such as "Björk - Homogenic (1997)".
   * Ancestry is the search's own business: a detail page's episodes keep
   * "S01E01", since the series is already on screen there.
   *
   * Each distinct parent is fetched once, in parallel, and a hit that is
   * itself an ancestor is not fetched at all. A search for a show typically
   * returns the show too. A parent that fails to load leaves its hits as they
   * were, without context, rather than failing the search.
   */
  async search(query: string, signal?: AbortSignal, options: MediaSearchOptions = {}): Promise<MediaSummary[]> {
    // Only the words a search keys on, and no request at all when too little
    // is left. Applied here as well as by the client, so a client that forgets
    // to ask `isSearchable` still gets Tom's rule.
    if (!isSearchable(query)) return [];
    const categories = options.categories ?? DEFAULT_SEARCH_CATEGORIES;
    const kinds = new Set(SEARCH_CATEGORIES.filter((category) => categories.includes(category.key)).flatMap((category) => category.kinds));
    // Nothing selected finds nothing, and asks nobody.
    if (kinds.size === 0) return [];
    // The catalogue search takes no kind, so a filter is applied to what comes
    // back. Asking for more when anything is filtered out keeps a page of
    // SEARCH_PAGE_SIZE from quietly shrinking to the few hits of one kind that
    // made the unfiltered cut. Filtered before the ancestry, so no parent is
    // fetched for a hit that is then thrown away.
    const narrowed = kinds.size < SEARCH_CATEGORIES.reduce((count, category) => count + category.kinds.length, 0);
    const found = await this.catalogue.search(searchTerms(query), narrowed ? SEARCH_FILTERED_FETCH_LIMIT : SEARCH_PAGE_SIZE, signal);
    const hits = found.filter((item) => kinds.has(item.kind)).slice(0, SEARCH_PAGE_SIZE);
    const known = new Map(hits.map((item) => [item.id, item]));
    const withAncestry = hits.filter((item) => item.kind === 'episode' || item.kind === 'season' || item.kind === 'track');
    await this.loadAncestors(known, withAncestry.map((item) => item.parent_id), signal);
    // One level further for the two kinds whose parent has a parent worth naming.
    const grandparents = withAncestry
      .filter((item) => item.kind === 'episode' || item.kind === 'track')
      .map((item) => (item.parent_id ? known.get(item.parent_id)?.parent_id : undefined));
    await this.loadAncestors(known, grandparents, signal);
    return hits.map((item) => this.searchHit(item, known));
  }

  artworkUrls(ref: ArtworkRef): ArtworkSource[] {
    const nodes = this.catalogue.artworkUrls(ref.id);
    const signed = ref.url;
    if (!signed) return nodes;
    // The signed URL first: no header needed, so it is the only kind usable
    // from an image loader that cannot set them, and the server owns
    // fetching, decode and HTTP caching for it.
    //
    // Its signature covers the artwork id and expiry and never the host. It
    // is a cluster credential, checked with the shared cluster key on every
    // node, and artwork is content-addressed, read from its DHT owner by any
    // node without a local copy. So one capability is good on every node,
    // which is what lets a loader that cannot set headers fail over from a
    // node that is down or slow instead of losing the image. It is re-hosted
    // by grafting its query onto each node's own artwork URL, so a node base
    // with a path prefix survives intact.
    //
    // An expired one is re-hosted nowhere, because every node would refuse
    // it. It still leads, since the caller's own cache may hold the image
    // under it, and the authenticated URLs behind it are the real recovery.
    const query = signed.indexOf('?');
    const elsewhere = query >= 0 && !expiredCapability(signed);
    const capability: ArtworkSource[] = [
      { url: signed, requiresAuthorization: false },
      ...(elsewhere ? nodes.map((node) => ({ url: `${node.url}${signed.slice(query)}`, requiresAuthorization: false })) : []),
    ];
    // Keyed on the full URL, so a node's capability entry and its
    // authenticated entry coexist: the query string is what separates them,
    // and a capability without one was already excluded above.
    const unique = new Map<string, ArtworkSource>();
    for (const source of [...capability, ...nodes]) {
      if (!unique.has(source.url)) unique.set(source.url, source);
    }
    // Then promote whichever node last served artwork, which is the whole of
    // the cache fix. Everything above orders by the *streaming* preferred
    // endpoint — `ClusterCatalogueApi.artworkUrls` returns candidates
    // preferred-node-first, and `signed` was absolutised against whichever
    // node answered the catalogue read — so without this a pre-emptive swap
    // renames every poster and a platform HTTP cache re-downloads bytes it
    // already holds.
    //
    // Nothing is added or removed, only reordered, so every failover candidate
    // and its relative order behind the promoted host is untouched.
    return this.artworkHost.order([...unique.values()]);
  }

  noteArtworkLoaded(url: string): void {
    this.artworkHost.noteLoaded(url);
  }

  artwork(ref: ArtworkRef, signal?: AbortSignal): Promise<Blob> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const cached = this.artworkCache.get(ref.id);
    if (cached) return Promise.resolve(cached);

    let pending = this.artworkRequests.get(ref.id);
    if (!pending) {
      this.log.debug('request-queued', { artworkId: ref.id, priority: signal ? 'foreground' : 'background' });
      // No client-side concurrency cap: the browser's own HTTP stack already
      // manages concurrent requests per origin (and multiplexes them under
      // HTTP/2), which a hand-rolled JS-side queue can only approximate and
      // risks quietly wedging (a leaked slot silently starves the rest).
      pending = this.catalogue.artwork(ref.id).then((blob) => {
        this.artworkCache.set(ref.id, blob);
        this.artworkRequests.delete(ref.id);
        this.log.debug('request-complete', { artworkId: ref.id, sizeBytes: blob.size });
        // This path does not learn the host: `CatalogueApi.artwork` walks
        // candidates internally and returns bytes, not the endpoint that
        // produced them. Recorded as a known gap rather than plumbed out — the
        // blob path is the fallback, the URL path is what renders a library
        // screen, and a caller using it reports through `noteArtworkLoaded`.
        return blob;
      }, (error) => {
        this.artworkRequests.delete(ref.id);
        this.log.warn('request-failed', { artworkId: ref.id, error });
        throw error;
      });
      this.artworkRequests.set(ref.id, pending);
    }
    // Consumer cancellation only abandons that view. Bounded shared work is
    // allowed to complete and populate the cache for subsequent screens.
    return consumeArtwork(pending, signal);
  }

  invalidateArtwork(ref: ArtworkRef): void {
    this.artworkCache.delete(ref.id);
  }

  /**
   * The single producer of episodes. The wire item carries only its season's
   * `parent_id`, so the series/season ancestry that Continue Watching cards
   * and the player heading render is resolved here, never by callers.
   */
  private episode(item: CatalogueItem, season: CatalogueItem, show: CatalogueItem): Episode {
    const seasonNumber = season.season_number ?? 0;
    return {
      ...this.media(item),
      kind: 'episode',
      seasonNumber: item.season_number ?? seasonNumber,
      episodeNumber: item.episode_number ?? 0,
      playbackContext: {
        series: { id: show.id, title: show.title },
        season: { id: season.id, title: season.title || `Season ${seasonNumber}`, seasonNumber },
      },
    };
  }

  private async loadAncestors(
    known: Map<string, CatalogueItem>,
    ids: readonly (string | null | undefined)[],
    signal?: AbortSignal,
  ): Promise<void> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id && !known.has(id)))];
    const loaded = await Promise.allSettled(wanted.map((id) => this.catalogue.get(id, signal)));
    if (signal?.aborted) throw abortReason(signal);
    for (const result of loaded) {
      if (result.status === 'fulfilled') known.set(result.value.id, result.value);
    }
  }

  private searchHit(item: CatalogueItem, known: ReadonlyMap<string, CatalogueItem>): MediaSummary {
    const parent = item.parent_id ? known.get(item.parent_id) : undefined;
    if (item.kind === 'episode' && parent?.kind === 'season') {
      const show = parent.parent_id ? known.get(parent.parent_id) : undefined;
      if (show?.kind !== 'show') return this.media(item);
      const episode = this.episode(item, parent, show);
      return { ...episode, subtitle: episodeSubtitle(episode) ?? episode.subtitle };
    }
    if (item.kind === 'season' && parent?.kind === 'show') {
      const season = this.seasonSummary(item, parent.id);
      return { ...season, subtitle: joinSubtitle(parent.title, season.subtitle ?? season.title) };
    }
    if (item.kind === 'track') {
      const track = this.track(item, known);
      return { ...track, subtitle: trackSubtitle(track) ?? track.subtitle };
    }
    return this.media(item);
  }

  private track(item: CatalogueItem, known: ReadonlyMap<string, CatalogueItem>): MediaSummary {
    const album = item.parent_id ? known.get(item.parent_id) : undefined;
    if (album?.kind !== 'album') return this.media(item);
    const artist = album.parent_id ? known.get(album.parent_id) : undefined;
    return { ...this.media(item), musicContext: this.musicContext(album, artist?.kind === 'artist' ? artist : undefined) };
  }

  /** The album's own poster, for a track that carries no artwork of its own. */
  private musicContext(album: CatalogueItem, artist: CatalogueItem | undefined): MusicHierarchyContext {
    const artwork = this.mapArtwork(album.effective_artwork ?? album.artwork);
    return {
      album: { id: album.id, title: album.title, year: optionalNumber(album.year) },
      artist: artist ? { id: artist.id, title: artist.title } : undefined,
      artwork: artwork?.poster ?? artwork?.thumbnail,
    };
  }

  private parentId(item: CatalogueItem): string {
    if (!item.parent_id) throw new Error(`Catalogue ${item.kind} ${item.id} has no parent.`);
    return item.parent_id;
  }

  private seasonSummary(item: CatalogueItem, showId: string): SeasonSummary {
    const media = this.media(item);
    const seasonNumber = item.season_number ?? 0;
    return {
      ...media,
      kind: 'season',
      showId,
      seasonNumber,
      title: item.title || `Season ${seasonNumber}`,
    };
  }

  private media(item: CatalogueItem): MediaSummary {
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      subtitle: this.subtitle(item),
      year: optionalNumber(item.year),
      synopsis: item.synopsis || undefined,
      artwork: this.mapArtwork(item.effective_artwork ?? item.artwork),
      parentId: item.parent_id ?? undefined,
      seasonNumber: optionalNumber(item.season_number),
      episodeNumber: optionalNumber(item.episode_number),
      discNumber: optionalNumber(item.disc_number),
      trackNumber: optionalNumber(item.track_number),
      mediaIds: [...item.media_ids],
      catalogueUpdatedNs: item.updated_ns,
      // Placeholder until Macha exposes a full date from the metadata provider.
      releaseDate: undefined,
    };
  }

  private mapArtwork(items: CatalogueArtwork[]): Artwork | undefined {
    if (items.length === 0) return undefined;
    const byRole = (roles: string[]): ArtworkRef | undefined => {
      const item = items.find((candidate) => roles.includes(candidate.role));
      return item ? { id: item.id, mimeType: item.mime_type, url: item.url } : undefined;
    };
    const result: Artwork = {
      poster: byRole(['poster', 'cover']),
      backdrop: byRole(['backdrop', 'background', 'fanart']),
      thumbnail: byRole(['still', 'thumbnail', 'thumb']),
    };
    return result.poster || result.backdrop || result.thumbnail ? result : undefined;
  }

  private subtitle(item: CatalogueItem): string | undefined {
    if (item.kind === 'episode' && item.episode_number !== null) {
      const episode = String(item.episode_number).padStart(2, '0');
      if (item.season_number !== null) return `S${String(item.season_number).padStart(2, '0')}E${episode}`;
      return `Episode ${item.episode_number}`;
    }
    if (item.kind === 'season' && item.season_number !== null) return `Season ${item.season_number}`;
    if (item.kind === 'track' && item.track_number !== null) {
      return item.disc_number && item.disc_number > 1
        ? `Disc ${item.disc_number} · Track ${item.track_number}`
        : `Track ${item.track_number}`;
    }
    return undefined;
  }
}
