import { describe, expect, it } from 'vitest';
import type { CatalogueApi, CatalogueArtwork, CatalogueItem, CatalogueKind, CatalogueStatus } from './CatalogueApi.js';
import { MachaMediaApi } from './MachaMediaApi.js';
import { ArtworkHostPreference } from '../state/artworkHost.js';

function catalogueItem(id: string, kind: CatalogueKind, partial: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    id,
    kind,
    title: id,
    sort_title: id,
    synopsis: '',
    parent_id: null,
    year: null,
    season_number: null,
    episode_number: null,
    disc_number: null,
    track_number: null,
    aliases: [],
    external_ids: {},
    media_ids: [],
    artwork: [],
    revision: 1,
    updated_ns: 0,
    ...partial,
  };
}

const EPISODE_1 = catalogueItem('episode-1', 'episode', {
  parent_id: 'season-1',
  season_number: 1,
  episode_number: 2,
  title: 'Episode',
  media_ids: ['file:abc'],
  artwork: [{ role: 'still', id: 'art123', mime_type: 'image/jpeg' }],
});

class FakeCatalogue implements CatalogueApi {
  artworkUrls(id: string) {
    return [{ url: `http://node/artwork/${id}`, requiresAuthorization: true }];
  }

  mediaProfile(): Promise<undefined> { return Promise.resolve(undefined); }
  status(): Promise<CatalogueStatus> { throw new Error('not used'); }
  update(item: CatalogueItem): Promise<CatalogueItem> { return Promise.resolve(item); }
  clearMetadata(): Promise<void> { return Promise.resolve(); }
  putArtwork(): Promise<CatalogueArtwork> { return Promise.resolve({ role: 'poster', id: 'artwork', mime_type: 'image/jpeg' }); }
  artwork(id: string, _signal?: AbortSignal): Promise<Blob> { return Promise.resolve(new Blob([id])); }
  search(): Promise<CatalogueItem[]> { return Promise.resolve([]); }
  get(id: string): Promise<CatalogueItem> {
    if (id === 'show') return Promise.resolve(catalogueItem('show', 'show', { title: 'Show' }));
    if (id === 'season-1') return Promise.resolve(catalogueItem('season-1', 'season', {
      parent_id: 'show',
      season_number: 1,
      title: 'Season 1',
      artwork: [{ role: 'poster', id: 'season-art', mime_type: 'image/jpeg' }],
    }));
    if (id === 'episode-1') return Promise.resolve(EPISODE_1);
    if (id === 'artist-1') return Promise.resolve(catalogueItem('artist-1', 'artist', {
      title: 'Artist',
      effective_artwork: [{ role: 'cover', id: 'artist-effective-art', mime_type: 'image/jpeg' }],
    }));
    if (id === 'album-1') return Promise.resolve(catalogueItem('album-1', 'album', { parent_id: 'artist-1', title: 'Album', year: 1999 }));
    if (id === 'movie-with-capability-url') return Promise.resolve(catalogueItem('movie-with-capability-url', 'movie', {
      title: 'Movie',
      artwork: [{ role: 'poster', id: 'signed-poster', mime_type: 'image/jpeg', url: '/api/v1/catalogue/artwork/signed-poster?exp=1&sig=abc' }],
    }));
    throw new Error('not found');
  }
  list(kind?: CatalogueKind, parent?: string): Promise<CatalogueItem[]> {
    if (kind === 'season' && parent === 'show') {
      return Promise.resolve([catalogueItem('season-1', 'season', {
        parent_id: 'show',
        season_number: 1,
        title: 'Season 1',
        artwork: [{ role: 'poster', id: 'season-art', mime_type: 'image/jpeg' }],
      })]);
    }
    if (kind === 'episode' && parent === 'season-1') return Promise.resolve([EPISODE_1]);
    if (kind === 'album' && parent === 'artist-1') {
      return Promise.resolve([catalogueItem('album-1', 'album', { parent_id: 'artist-1', title: 'Album', year: 1999 })]);
    }
    if (kind === 'track' && parent === 'album-1') {
      return Promise.resolve([
        catalogueItem('track-2', 'track', { parent_id: 'album-1', disc_number: 1, track_number: 2, title: 'Second', media_ids: ['file:2'] }),
        catalogueItem('track-1', 'track', {
          parent_id: 'album-1',
          disc_number: 1,
          track_number: 1,
          title: 'First',
          media_ids: ['file:1'],
          effective_artwork: [{ role: 'cover', id: 'album-effective-art', mime_type: 'image/jpeg' }],
        }),
      ]);
    }
    if (kind === 'track' && parent === undefined) {
      return Promise.resolve([
        catalogueItem('track-global', 'track', {
          parent_id: 'album-1',
          track_number: 3,
          title: 'Global Track',
          media_ids: ['file:3'],
          effective_artwork: [{ role: 'cover', id: 'global-effective-art', mime_type: 'image/jpeg' }],
        }),
      ]);
    }
    return Promise.resolve([]);
  }
}

describe('MachaMediaApi', () => {
  it('loads only season summaries for a series detail page', async () => {
    const api = new MachaMediaApi(new FakeCatalogue());
    const details = await api.details('show');
    expect(details.kind).toBe('show');
    if (details.kind !== 'show' || !('seasons' in details)) throw new Error('expected show details');
    expect(details.seasons[0]).toEqual(expect.objectContaining({
      id: 'season-1',
      showId: 'show',
      seasonNumber: 1,
      artwork: { poster: { id: 'season-art', mimeType: 'image/jpeg' } },
    }));
    expect('episodes' in details.seasons[0]).toBe(false);
  });

  it('threads a signed artwork capability URL through to the mapped ArtworkRef', async () => {
    const api = new MachaMediaApi(new FakeCatalogue());
    const details = await api.details('movie-with-capability-url');
    expect(details.artwork).toEqual({
      poster: { id: 'signed-poster', mimeType: 'image/jpeg', url: '/api/v1/catalogue/artwork/signed-poster?exp=1&sig=abc' },
    });
  });

  it('loads episode details only when the season page is opened', async () => {
    const api = new MachaMediaApi(new FakeCatalogue());
    const details = await api.details('season-1');
    expect(details.kind).toBe('season');
    if (details.kind !== 'season' || !('episodes' in details)) throw new Error('expected season details');
    expect(details.episodes[0]).toEqual(expect.objectContaining({
      id: 'episode-1',
      seasonNumber: 1,
      episodeNumber: 2,
      mediaIds: ['file:abc'],
      artwork: { thumbnail: { id: 'art123', mimeType: 'image/jpeg' } },
      releaseDate: undefined,
      playbackContext: {
        series: { id: 'show', title: 'Show' },
        season: { id: 'season-1', title: 'Season 1', seasonNumber: 1 },
      },
    }));
  });

  it('resolves series and season ancestry for an episode loaded directly, as a deep link does', async () => {
    const api = new MachaMediaApi(new FakeCatalogue());
    const details = await api.details('episode-1');
    expect(details.kind).toBe('episode');
    expect(details).toEqual(expect.objectContaining({
      id: 'episode-1',
      seasonNumber: 1,
      episodeNumber: 2,
      playbackContext: {
        series: { id: 'show', title: 'Show' },
        season: { id: 'season-1', title: 'Season 1', seasonNumber: 1 },
      },
    }));
  });

  it('maps artist, album and track hierarchy for the Music client', async () => {
    const api = new MachaMediaApi(new FakeCatalogue());
    const artist = await api.details('artist-1');
    expect(artist.kind).toBe('artist');
    if (artist.kind !== 'artist' || !('albums' in artist)) throw new Error('expected artist details');
    expect(artist.albums.map((item) => item.id)).toEqual(['album-1']);
    expect(artist.artwork).toEqual({ poster: { id: 'artist-effective-art', mimeType: 'image/jpeg' } });

    const album = await api.details('album-1');
    expect(album.kind).toBe('album');
    if (album.kind !== 'album' || !('tracks' in album)) throw new Error('expected album details');
    expect(album.tracks.map((item) => item.id)).toEqual(['track-1', 'track-2']);
    expect(album.tracks[0].trackNumber).toBe(1);
    expect(album.tracks[0].artwork).toEqual({ poster: { id: 'album-effective-art', mimeType: 'image/jpeg' } });
  });

  it('lists tracks directly for the top-level Music tracks grid', async () => {
    const api = new MachaMediaApi(new FakeCatalogue());
    const tracks = await api.tracks();
    expect(tracks).toEqual([expect.objectContaining({
      id: 'track-global',
      kind: 'track',
      parentId: 'album-1',
      trackNumber: 3,
      artwork: { poster: { id: 'global-effective-art', mimeType: 'image/jpeg' } },
    })]);
  });

  it('preserves catalogue updated_ns for Home recency ordering', async () => {
    const catalogue = new FakeCatalogue();
    catalogue.list = (kind?: CatalogueKind) => kind === 'movie'
      ? Promise.resolve([catalogueItem('recent', 'movie', { updated_ns: 123456789 })])
      : Promise.resolve([]);
    const api = new MachaMediaApi(catalogue);
    const movies = await api.movies();
    expect(movies[0]?.catalogueUpdatedNs).toBe(123456789);
  });

  it('coalesces non-cancellable artwork demand and caches the completed blob', async () => {
    const catalogue = new FakeCatalogue();
    let resolveArtwork!: (blob: Blob) => void;
    let requests = 0;
    catalogue.artwork = () => {
      requests += 1;
      return new Promise<Blob>((resolve) => { resolveArtwork = resolve; });
    };
    const api = new MachaMediaApi(catalogue);
    const ref = { id: 'poster-1', mimeType: 'image/jpeg' };

    const first = api.artwork(ref);
    const second = api.artwork(ref);
    expect(requests).toBe(1);

    const blob = new Blob(['poster']);
    resolveArtwork(blob);
    await expect(first).resolves.toBe(blob);
    await expect(second).resolves.toBe(blob);

    await expect(api.artwork(ref)).resolves.toBe(blob);
    expect(requests).toBe(1);
  });

  it('coalesces cancellable and grid consumers while allowing the abandoned request to fill the cache', async () => {
    const catalogue = new FakeCatalogue();
    let resolveArtwork!: (blob: Blob) => void;
    let requests = 0;
    catalogue.artwork = () => {
      requests += 1;
      return new Promise<Blob>((resolve) => { resolveArtwork = resolve; });
    };
    const api = new MachaMediaApi(catalogue);
    const ref = { id: 'poster-priority', mimeType: 'image/jpeg' };
    const consumer = new AbortController();

    const foreground = api.artwork(ref, consumer.signal);
    const grid = api.artwork(ref);
    consumer.abort(new DOMException('left detail', 'AbortError'));
    await expect(foreground).rejects.toMatchObject({ name: 'AbortError' });

    const blob = new Blob(['poster']);
    resolveArtwork(blob);
    await expect(grid).resolves.toBe(blob);
    await expect(api.artwork(ref)).resolves.toBe(blob);
    expect(requests).toBe(1);
  });

  it('evicts cached artwork rejected by the browser so it can be fetched again', async () => {
    const catalogue = new FakeCatalogue();
    let requests = 0;
    catalogue.artwork = () => Promise.resolve(new Blob([`poster-${++requests}`]));
    const api = new MachaMediaApi(catalogue);
    const ref = { id: 'poster-1', mimeType: 'image/jpeg' };

    const first = await api.artwork(ref);
    expect(await api.artwork(ref)).toBe(first);
    api.invalidateArtwork(ref);
    expect(await api.artwork(ref)).not.toBe(first);
    expect(requests).toBe(2);
  });

});

describe('where artwork can be fetched from', () => {
  it('leads with the signed URL and marks it as needing no header', () => {
    // It is the only entry an image loader that cannot set headers can use,
    // and the server owns fetching, decode and caching for it.
    const api = new MachaMediaApi(new FakeCatalogue() as unknown as CatalogueApi);

    expect(api.artworkUrls({ id: 'art-1', mimeType: 'image/jpeg', url: 'https://signed/art-1' })).toEqual([
      { url: 'https://signed/art-1', requiresAuthorization: false },
      { url: 'http://node/artwork/art-1', requiresAuthorization: true },
    ]);
  });

  it('re-hosts a signed capability on every node, because its signature is a cluster credential', () => {
    // The HMAC covers the artwork id and expiry, not the host, and any node
    // reads content-addressed artwork from its DHT owner: one capability is
    // good everywhere, which is what an <img> needs in order to fail over.
    // The node that signed it is listed once, not twice.
    const catalogue = new FakeCatalogue();
    catalogue.artworkUrls = (id: string) => [
      { url: `http://a/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true },
      { url: `http://b/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true },
    ];
    const api = new MachaMediaApi(catalogue);
    const live = `?exp=${Date.now() + 60_000}&sig=abc`;

    expect(api.artworkUrls({ id: 'art-1', mimeType: 'image/jpeg', url: `http://a/api/v1/catalogue/artwork/art-1${live}` })).toEqual([
      { url: `http://a/api/v1/catalogue/artwork/art-1${live}`, requiresAuthorization: false },
      { url: `http://b/api/v1/catalogue/artwork/art-1${live}`, requiresAuthorization: false },
      { url: 'http://a/api/v1/catalogue/artwork/art-1', requiresAuthorization: true },
      { url: 'http://b/api/v1/catalogue/artwork/art-1', requiresAuthorization: true },
    ]);
  });

  it('reads exp as unix milliseconds, which is what the server signs', () => {
    // Pins the unit, because getting it wrong fails silently and in the
    // direction that looks fine: seconds against Date.now() make every live
    // capability read as long expired, so no alternate is ever offered and
    // the failover quietly stops existing. The server signs
    // `unix_ms() + ttl` and checks `unix_ms() >= expires` (src/types.cpp),
    // and a real capability off the wire carries thirteen digits.
    const catalogue = new FakeCatalogue();
    catalogue.artworkUrls = (id: string) => [{ url: `http://b/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true }];
    const api = new MachaMediaApi(catalogue);
    const reHosted = (exp: number) => api
      .artworkUrls({ id: 'art-1', mimeType: 'image/jpeg', url: `http://a/api/v1/catalogue/artwork/art-1?exp=${exp}&sig=abc` })
      .some((source) => source.url.startsWith('http://b') && !source.requiresAuthorization);

    const anHourAway = Date.now() + 3_600_000;
    expect(reHosted(anHourAway)).toBe(true);
    // The same instant in seconds. Read as milliseconds it is 1970, so it
    // must be treated as expired rather than quietly normalised — a format
    // that ever does change units should break loudly here.
    expect(reHosted(Math.floor(anHourAway / 1000))).toBe(false);
  });

  it('re-hosts an expired capability nowhere, because every node would refuse it', () => {
    // It still leads: the caller's own cache may hold the image under it.
    // What follows is the authenticated URLs, which are the real recovery.
    const catalogue = new FakeCatalogue();
    catalogue.artworkUrls = (id: string) => [
      { url: `http://a/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true },
      { url: `http://b/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true },
    ];
    const api = new MachaMediaApi(catalogue);

    expect(api.artworkUrls({ id: 'art-1', mimeType: 'image/jpeg', url: 'http://a/api/v1/catalogue/artwork/art-1?exp=1&sig=abc' })).toEqual([
      { url: 'http://a/api/v1/catalogue/artwork/art-1?exp=1&sig=abc', requiresAuthorization: false },
      { url: 'http://a/api/v1/catalogue/artwork/art-1', requiresAuthorization: true },
      { url: 'http://b/api/v1/catalogue/artwork/art-1', requiresAuthorization: true },
    ]);
  });

  it('falls back to node URLs, and says they need the caller\'s header', () => {
    // A flat list of strings would silently 401 here. A caller that cannot
    // send a header has to be able to tell, rather than hope.
    const api = new MachaMediaApi(new FakeCatalogue() as unknown as CatalogueApi);

    expect(api.artworkUrls({ id: 'art-1', mimeType: 'image/jpeg' })).toEqual([
      { url: 'http://node/artwork/art-1', requiresAuthorization: true },
    ]);
  });
});

describe('keeping an artwork URL byte-identical across an endpoint swap', () => {
  // The URL is already a content address: the path is the SHA-256 of the bytes
  // and the signature covers the id and expiry and never the host. Every
  // component is stable except the host, and the host was varying by accident
  // — candidates are ordered by the *streaming* preferred endpoint, and the
  // capability in a catalogue payload is absolutised against whichever node
  // answered that read. So a swap renamed every poster and the platform HTTP
  // cache, which keys on the whole URL and which core neither owns nor can
  // re-key, re-downloaded bytes it already held.
  // A live capability. An expired one is deliberately not re-hosted onto other
  // nodes — every node would refuse it — so a past expiry would test the
  // fallback rather than the ordering.
  const SIGNED_QUERY = `?exp=${Date.now() + 86_400_000}&sig=abc`;
  const artworkPath = (host: string) => `${host}/api/v1/catalogue/artwork/sha-1${SIGNED_QUERY}`;

  const catalogueWithNodes = (nodes: readonly string[]): CatalogueApi => ({
    status: async () => ({ ready: true } as CatalogueStatus),
    list: async () => [],
    get: async () => catalogueItem('x', 'movie'),
    update: async (item) => item,
    clearMetadata: async () => undefined,
    search: async () => [],
    putArtwork: async () => ({} as CatalogueArtwork),
    artwork: async () => ({ size: 1, type: 'image/jpeg' } as Blob),
    artworkUrls: (id) => nodes.map((node) => ({
      url: `${node}/api/v1/catalogue/artwork/${id}`,
      requiresAuthorization: true,
    })),
    mediaProfile: async () => undefined,
  });

  const ref = (signingHost: string) => ({
    id: 'sha-1',
    mimeType: 'image/jpeg',
    url: artworkPath(signingHost),
  });

  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
  };

  it('leads with the node that last served artwork, beating the one that signed the URL', () => {
    // The property that survives a swap: the catalogue is served by one node
    // and signs the capability with its own host, but the preference wins.
    const api = new MachaMediaApi(
      catalogueWithNodes(['http://a', 'http://b']),
      new ArtworkHostPreference(storage()),
    );
    api.noteArtworkLoaded(artworkPath('http://b'));

    expect(api.artworkUrls(ref('http://a'))[0].url).toBe(artworkPath('http://b'));
  });

  it('hands back the same URL before and after the preferred endpoint moves', () => {
    // The regression itself. Node ordering is the cluster's streaming
    // preference, and it reverses on a swap; the artwork URL must not.
    const preference = new ArtworkHostPreference(storage());
    const before = new MachaMediaApi(catalogueWithNodes(['http://a', 'http://b']), preference);
    const first = before.artworkUrls(ref('http://a'))[0].url;
    before.noteArtworkLoaded(first);

    const after = new MachaMediaApi(catalogueWithNodes(['http://b', 'http://a']), preference);
    expect(after.artworkUrls(ref('http://b'))[0].url).toBe(first);
  });

  it('survives a restart, because the preference is persisted', () => {
    const shared = storage();
    const first = new MachaMediaApi(catalogueWithNodes(['http://a', 'http://b']), new ArtworkHostPreference(shared));
    first.noteArtworkLoaded(artworkPath('http://b'));

    const restarted = new MachaMediaApi(catalogueWithNodes(['http://a', 'http://b']), new ArtworkHostPreference(shared));
    expect(restarted.artworkUrls(ref('http://a'))[0].url).toBe(artworkPath('http://b'));
  });

  it('offers every candidate it offered before, only reordered', () => {
    // It orders URLs the cluster already gave, rather than choosing a node.
    // That is what makes it safe without any failure handling: nothing is
    // added, nothing removed, so failover is untouched.
    const api = new MachaMediaApi(catalogueWithNodes(['http://a', 'http://b']), new ArtworkHostPreference(storage()));
    const unordered = new MachaMediaApi(catalogueWithNodes(['http://a', 'http://b']), new ArtworkHostPreference(undefined));
    api.noteArtworkLoaded(artworkPath('http://b'));

    const ordered = api.artworkUrls(ref('http://a')).map((source) => source.url);
    const original = unordered.artworkUrls(ref('http://a')).map((source) => source.url);
    expect([...ordered].sort()).toEqual([...original].sort());
    expect(ordered).not.toEqual(original);
  });

  it('falls back to the cluster order when nothing has succeeded yet', () => {
    const api = new MachaMediaApi(catalogueWithNodes(['http://a', 'http://b']), new ArtworkHostPreference(storage()));
    expect(api.artworkUrls(ref('http://a'))[0].url).toBe(artworkPath('http://a'));
  });

  it('ignores a URL that is not an artwork URL', () => {
    const api = new MachaMediaApi(catalogueWithNodes(['http://a', 'http://b']), new ArtworkHostPreference(storage()));
    api.noteArtworkLoaded('http://b/api/v1/catalogue/items/x');

    expect(api.artworkUrls(ref('http://a'))[0].url).toBe(artworkPath('http://a'));
  });

  it('keeps a node base that carries a path prefix intact', () => {
    // A reverse proxy may mount a node under a path. Splitting on the artwork
    // route recovers the whole base rather than just the origin.
    const api = new MachaMediaApi(
      catalogueWithNodes(['http://proxy/node-a', 'http://proxy/node-b']),
      new ArtworkHostPreference(storage()),
    );
    api.noteArtworkLoaded(artworkPath('http://proxy/node-b'));

    expect(api.artworkUrls(ref('http://proxy/node-a'))[0].url).toBe(artworkPath('http://proxy/node-b'));
  });
});

/**
 * Search hits carry the ancestry a detail page would give them. Asked for by
 * the Android TV client on Tom's instruction: an episode found by search said
 * "S01E02" and not which series.
 */
describe('search hits and their ancestry', () => {
  class SearchCatalogue extends FakeCatalogue {
    readonly fetched: string[] = [];
    constructor(private readonly hits: CatalogueItem[], private readonly failing = new Set<string>()) { super(); }
    override search(): Promise<CatalogueItem[]> { return Promise.resolve(this.hits); }
    override get(id: string): Promise<CatalogueItem> {
      this.fetched.push(id);
      if (this.failing.has(id)) return Promise.reject(new Error('unavailable'));
      return super.get(id);
    }
  }

  const EPISODE_3 = catalogueItem('episode-3', 'episode', { parent_id: 'season-1', season_number: 1, episode_number: 3, title: 'Third' });
  const SEASON = catalogueItem('season-1', 'season', { parent_id: 'show', season_number: 1, title: 'Season 1' });
  const TRACK = catalogueItem('track-9', 'track', { parent_id: 'album-1', track_number: 9, title: 'Ninth' });

  it('sends only the words a search keys on, and nothing when none are left', async () => {
    class Recording extends SearchCatalogue {
      readonly queries: string[] = [];
      override search(query?: string): Promise<CatalogueItem[]> { this.queries.push(query ?? ''); return super.search(); }
    }
    const catalogue = new Recording([]);
    const api = new MachaMediaApi(catalogue);
    await api.search('The Matrix');
    await expect(api.search('the')).resolves.toEqual([]);
    await expect(api.search('a x')).resolves.toEqual([]);
    expect(catalogue.queries).toEqual(['Matrix']);
  });

  describe('narrowed to categories', () => {
    class Limited extends SearchCatalogue {
      readonly limits: number[] = [];
      override search(_query?: string, limit?: number): Promise<CatalogueItem[]> { this.limits.push(limit ?? -1); return super.search(); }
    }
    const MOVIE = catalogueItem('movie-1', 'movie', { title: 'Film' });
    const ALBUM = catalogueItem('album-9', 'album', { title: 'Record' });

    it('returns only the kinds asked for', async () => {
      const api = new MachaMediaApi(new Limited([MOVIE, EPISODE_1, ALBUM, SEASON]));
      expect((await api.search('xx', undefined, { categories: ['shows'] })).map((hit) => hit.id)).toEqual(['episode-1', 'season-1']);
      expect((await api.search('xx', undefined, { categories: ['movies', 'music'] })).map((hit) => hit.id)).toEqual(['movie-1', 'album-9']);
      expect((await api.search('xx')).map((hit) => hit.id)).toEqual(['movie-1', 'episode-1', 'album-9', 'season-1']);
    });

    it('asks nobody when no category is selected', async () => {
      const catalogue = new Limited([MOVIE]);
      await expect(new MachaMediaApi(catalogue).search('xx', undefined, { categories: [] })).resolves.toEqual([]);
      expect(catalogue.limits).toEqual([]);
    });

    it('asks for more when a filter will discard some, and still returns a page of at most 50', async () => {
      const many = Array.from({ length: 120 }, (_, i) => catalogueItem(`m${i}`, 'movie'));
      const catalogue = new Limited(many);
      const api = new MachaMediaApi(catalogue);
      await api.search('xx');
      const narrowed = await api.search('xx', undefined, { categories: ['movies'] });
      expect(catalogue.limits).toEqual([50, 200]);
      expect(narrowed).toHaveLength(50);
    });

    it('fetches no parent for a hit the filter discarded', async () => {
      const catalogue = new Limited([MOVIE, EPISODE_1]);
      await new MachaMediaApi(catalogue).search('xx', undefined, { categories: ['movies'] });
      expect(catalogue.fetched).toEqual([]);
    });
  });

  it('names the series on an episode, with the same context a season page gives', async () => {
    const api = new MachaMediaApi(new SearchCatalogue([EPISODE_1]));
    const [hit] = await api.search('episode');
    expect(hit.playbackContext).toEqual({
      series: { id: 'show', title: 'Show' },
      season: { id: 'season-1', title: 'Season 1', seasonNumber: 1 },
    });
  });

  it('names the series on a season', async () => {
    const api = new MachaMediaApi(new SearchCatalogue([SEASON]));
    const [hit] = await api.search('season');
    expect((hit as { showId?: string }).showId).toBe('show');
    expect(hit.playbackContext).toEqual({
      series: { id: 'show', title: 'Show' },
      season: { id: 'season-1', title: 'Season 1', seasonNumber: 1 },
    });
  });

  it('fetches each ancestor once, and none that the search already returned', async () => {
    const show = catalogueItem('show', 'show', { title: 'Show' });
    const catalogue = new SearchCatalogue([show, EPISODE_1, EPISODE_3]);
    const hits = await new MachaMediaApi(catalogue).search('show');
    expect(catalogue.fetched).toEqual(['season-1']);
    expect(hits.map((hit) => hit.playbackContext?.series.title)).toEqual([undefined, 'Show', 'Show']);
  });

  it('returns the hit as it was when an ancestor will not load, rather than failing the search', async () => {
    const api = new MachaMediaApi(new SearchCatalogue([EPISODE_1, SEASON], new Set(['show'])));
    const [episode, season] = await api.search('episode');
    expect(episode.playbackContext).toBeUndefined();
    expect(episode.episodeNumber).toBe(2);
    expect(season.playbackContext).toBeUndefined();
  });

  it('gives a track its album and artist', async () => {
    const [hit] = await new MachaMediaApi(new SearchCatalogue([TRACK])).search('ninth');
    expect(hit.musicContext).toEqual(expect.objectContaining({
      album: { id: 'album-1', title: 'Album', year: 1999 },
      artist: { id: 'artist-1', title: 'Artist' },
    }));
  });
});

/**
 * `musicContext` was declared "resolved by the media API" from 0.6.0 and
 * nothing ever set it, so the phone client's Now Playing, queue and downloads
 * never named an artist or album. Found 2026-09-24 while building search
 * ancestry.
 */
describe('tracks name their album and artist', () => {
  it('on an album page', async () => {
    const details = await new MachaMediaApi(new FakeCatalogue()).details('album-1');
    if (details.kind !== 'album' || !('tracks' in details)) throw new Error('expected album details');
    expect(details.tracks.map((track) => track.musicContext)).toEqual([
      { album: { id: 'album-1', title: 'Album', year: 1999 }, artist: { id: 'artist-1', title: 'Artist' }, artwork: undefined },
      { album: { id: 'album-1', title: 'Album', year: 1999 }, artist: { id: 'artist-1', title: 'Artist' }, artwork: undefined },
    ]);
  });

  it('in the whole-library track list', async () => {
    class Listing extends FakeCatalogue {
      override list(kind?: CatalogueKind, parent?: string): Promise<CatalogueItem[]> {
        if (kind === 'album' && parent === undefined) return Promise.resolve([catalogueItem('album-1', 'album', { parent_id: 'artist-1', title: 'Album' })]);
        if (kind === 'artist' && parent === undefined) return Promise.resolve([catalogueItem('artist-1', 'artist', { title: 'Artist' })]);
        return super.list(kind, parent);
      }
    }
    const [track] = await new MachaMediaApi(new Listing()).tracks();
    expect(track.musicContext?.album.title).toBe('Album');
    expect(track.musicContext?.artist?.title).toBe('Artist');
  });
});

/**
 * Artwork from the node this viewer reaches fastest, chosen once and then kept.
 * Measured 2026-09-24 from the fi-1 site: macnessa (~90 ms round trip) served
 * every poster at 636 ms median cold while fi-1 on the LAN served the same
 * signed URL in 65 ms. Stickiness kept whichever node served first, which was
 * whichever answered the catalogue read.
 */
describe('choosing the artwork host by what it costs this viewer', () => {
  const SIGNED_QUERY = `?exp=${Date.now() + 86_400_000}&sig=abc`;
  const FAR = 'https://macnessa';
  const NEAR = 'http://fi-1';

  function catalogue(latency: Record<string, number | undefined>): CatalogueApi {
    return {
      status: async () => ({ ready: true } as CatalogueStatus),
      list: async () => [],
      get: async () => catalogueItem('x', 'movie'),
      update: async (item) => item,
      clearMetadata: async () => undefined,
      search: async () => [],
      putArtwork: async () => ({} as CatalogueArtwork),
      artwork: async () => ({ size: 1, type: 'image/jpeg' } as Blob),
      artworkUrls: (id) => Object.entries(latency).map(([node, latencyMs]) => ({
        url: `${node}/api/v1/catalogue/artwork/${id}`,
        requiresAuthorization: true,
        ...(latencyMs === undefined ? {} : { latencyMs }),
      })),
      mediaProfile: async () => undefined,
    };
  }
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
  };
  const signedBy = (host: string) => ({ id: 'sha-1', mimeType: 'image/jpeg', url: `${host}/api/v1/catalogue/artwork/sha-1${SIGNED_QUERY}` });
  const leadHost = (sources: { url: string }[]) => sources[0]?.url.split('/api/')[0];

  it('leads with the materially nearer node, over the one that signed the URL', () => {
    const api = new MachaMediaApi(catalogue({ [FAR]: 90, [NEAR]: 3 }), new ArtworkHostPreference(storage()));
    const sources = api.artworkUrls(signedBy(FAR));
    expect(leadHost(sources)).toBe(NEAR);
    // Still the header-free capability first, now on the near node.
    expect(sources[0]).toEqual({ url: `${NEAR}/api/v1/catalogue/artwork/sha-1${SIGNED_QUERY}`, requiresAuthorization: false });
  });

  it('moves off a stored preference once, when another node is materially nearer', () => {
    const preference = new ArtworkHostPreference(storage());
    preference.noteLoaded(`${FAR}/api/v1/catalogue/artwork/sha-0`);
    const api = new MachaMediaApi(catalogue({ [FAR]: 90, [NEAR]: 3 }), preference);
    expect(leadHost(api.artworkUrls(signedBy(FAR)))).toBe(NEAR);
  });

  it('does not move for a small difference, so two nearby nodes never trade places', () => {
    const preference = new ArtworkHostPreference(storage());
    preference.noteLoaded(`${FAR}/api/v1/catalogue/artwork/sha-0`);
    const api = new MachaMediaApi(catalogue({ [FAR]: 40, [NEAR]: 3 }), preference);
    expect(leadHost(api.artworkUrls(signedBy(FAR)))).toBe(FAR);
  });

  it('decides nothing without evidence, and decides once it has some', () => {
    const preference = new ArtworkHostPreference(storage());
    expect(leadHost(new MachaMediaApi(catalogue({ [FAR]: undefined, [NEAR]: undefined }), preference).artworkUrls(signedBy(FAR)))).toBe(FAR);
    expect(leadHost(new MachaMediaApi(catalogue({ [FAR]: 90, [NEAR]: 3 }), preference).artworkUrls(signedBy(FAR)))).toBe(NEAR);
  });

  it('decides once per run: later readings do not move it again', () => {
    const preference = new ArtworkHostPreference(storage());
    new MachaMediaApi(catalogue({ [FAR]: 90, [NEAR]: 3 }), preference).artworkUrls(signedBy(FAR));
    // The link has changed since, but a second switch would re-download every poster again.
    expect(leadHost(new MachaMediaApi(catalogue({ [FAR]: 3, [NEAR]: 90 }), preference).artworkUrls(signedBy(FAR)))).toBe(NEAR);
  });

  it('is not undone by a poster from the old host finishing late', () => {
    const preference = new ArtworkHostPreference(storage());
    const api = new MachaMediaApi(catalogue({ [FAR]: 90, [NEAR]: 3 }), preference);
    api.artworkUrls(signedBy(FAR));
    api.noteArtworkLoaded(`${FAR}/api/v1/catalogue/artwork/sha-1${SIGNED_QUERY}`);
    expect(leadHost(api.artworkUrls(signedBy(FAR)))).toBe(NEAR);
  });

  it('never leads with a chosen host while it is in cooldown, and leads with it again once it recovers', () => {
    const preference = new ArtworkHostPreference(storage());
    new MachaMediaApi(catalogue({ [FAR]: 90, [NEAR]: 3 }), preference).artworkUrls(signedBy(FAR));

    const withNear = (ready: boolean): CatalogueApi => ({
      ...catalogue({}),
      artworkUrls: (id) => [
        { url: `${FAR}/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true, ready: true, latencyMs: 90 },
        { url: `${NEAR}/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true, ready },
      ],
    });
    expect(leadHost(new MachaMediaApi(withNear(false), preference).artworkUrls(signedBy(FAR)))).toBe(FAR);
    // Kept, not forgotten: its cache is warm the moment it is back.
    expect(leadHost(new MachaMediaApi(withNear(true), preference).artworkUrls(signedBy(FAR)))).toBe(NEAR);
  });

  it('moves a stored preference off a host that is down at the next run', () => {
    const shared = storage();
    const before = new ArtworkHostPreference(shared);
    before.noteLoaded(`${NEAR}/api/v1/catalogue/artwork/sha-0`);
    const restarted = new ArtworkHostPreference(shared);
    const api = new MachaMediaApi({
      ...catalogue({}),
      artworkUrls: (id) => [
        { url: `${FAR}/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true, ready: true, latencyMs: 90 },
        { url: `${NEAR}/api/v1/catalogue/artwork/${id}`, requiresAuthorization: true, ready: false },
      ],
    }, restarted);
    expect(leadHost(api.artworkUrls(signedBy(NEAR)))).toBe(FAR);
    expect(restarted.get()).toBe(FAR);
  });

  it('keeps following success when it chose not to switch', () => {
    // Nothing deliberate to protect, so the old behaviour stands.
    const preference = new ArtworkHostPreference(storage());
    const api = new MachaMediaApi(catalogue({ [FAR]: 10, [NEAR]: 8 }), preference);
    api.artworkUrls(signedBy(FAR));
    api.noteArtworkLoaded(`${NEAR}/api/v1/catalogue/artwork/sha-1`);
    expect(leadHost(api.artworkUrls(signedBy(FAR)))).toBe(NEAR);
  });
});

/** An album carries its artist as data; how a card words it is the client's. */
describe('an album names its artist', () => {
  class Library extends FakeCatalogue {
    constructor(private readonly artistsFail = false) { super(); }
    override list(kind?: CatalogueKind, parent?: string): Promise<CatalogueItem[]> {
      if (kind === 'album' && parent === undefined) {
        return Promise.resolve([
          catalogueItem('album-1', 'album', { parent_id: 'artist-1', title: 'Album', year: 1999 }),
          catalogueItem('orphan', 'album', { title: 'Orphan' }),
        ]);
      }
      if (kind === 'artist' && parent === undefined) {
        return this.artistsFail ? Promise.reject(new Error('unavailable')) : Promise.resolve([catalogueItem('artist-1', 'artist', { title: 'Artist' })]);
      }
      return super.list(kind, parent);
    }
    override search(): Promise<CatalogueItem[]> {
      return Promise.resolve([catalogueItem('album-1', 'album', { parent_id: 'artist-1', title: 'Album' })]);
    }
  }

  it('in the album list and on Home, leaving an album with no artist as it was', async () => {
    const api = new MachaMediaApi(new Library());
    expect((await api.albums()).map((album) => album.musicContext?.artist?.title)).toEqual(['Artist', undefined]);
    expect((await api.home()).albums.map((album) => album.musicContext?.artist?.title)).toEqual(['Artist', undefined]);
  });

  it('keeps the year on the item for a card that wants both lines', async () => {
    const [album] = await new MachaMediaApi(new Library()).albums();
    expect(album.year).toBe(1999);
  });

  it('still lists the albums when the artists will not load', async () => {
    const albums = await new MachaMediaApi(new Library(true)).albums();
    expect(albums.map((album) => [album.id, album.musicContext])).toEqual([['album-1', undefined], ['orphan', undefined]]);
  });

  it('on the album page and in search', async () => {
    const api = new MachaMediaApi(new Library());
    expect((await api.details('album-1')).musicContext?.artist?.title).toBe('Artist');
    expect((await api.search('album'))[0]?.musicContext?.artist?.title).toBe('Artist');
  });

  it("and on the artist's own page; whether to show it there is the client's call", async () => {
    const details = await new MachaMediaApi(new Library()).details('artist-1');
    if (details.kind !== 'artist' || !('albums' in details)) throw new Error('expected artist details');
    expect(details.albums[0]?.musicContext?.artist?.title).toBe('Artist');
  });
});
