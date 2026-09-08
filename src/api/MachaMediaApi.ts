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
  SeasonDetails,
  SeasonSummary,
  ShowDetails,
} from '../types.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Artwork consumer cancelled.', 'AbortError');
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

function optionalNumber(value: number | null): number | undefined {
  return value ?? undefined;
}

export class MachaMediaApi implements MediaApi {
  private readonly artworkCache = new Map<string, Blob>();
  private readonly artworkRequests = new Map<string, Promise<Blob>>();
  private readonly log = createClientLogger('artwork.api');

  constructor(private readonly catalogue: CatalogueApi) {}

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

  async tracks(signal?: AbortSignal): Promise<MediaSummary[]> {
    return (await this.catalogue.list('track', undefined, signal)).map((item) => this.media(item));
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
      const tracks = (await this.catalogue.list('track', item.id, signal))
        .map((track) => this.media(track))
        .sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
      return {
        ...this.media(item),
        kind: 'album',
        tracks,
      } as AlbumDetails;
    }

    return this.media(item);
  }

  async search(query: string, signal?: AbortSignal): Promise<MediaSummary[]> {
    return (await this.catalogue.search(query, 50, signal)).map((item) => this.media(item));
  }

  artworkUrls(ref: ArtworkRef): ArtworkSource[] {
    // The signed URL first when there is one: no header needed, so it is the
    // only entry usable from an image loader that cannot set them, and the
    // server owns fetching, decode and HTTP caching for it.
    return [
      ...(ref.url ? [{ url: ref.url, requiresAuthorization: false }] : []),
      ...this.catalogue.artworkUrls(ref.id),
    ];
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
