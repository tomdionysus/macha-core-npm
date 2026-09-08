import { describe, expect, it } from 'vitest';
import type { CatalogueApi, CatalogueArtwork, CatalogueItem, CatalogueKind, CatalogueStatus } from './CatalogueApi.js';
import { MachaMediaApi } from './MachaMediaApi.js';

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
    if (id === 'album-1') return Promise.resolve(catalogueItem('album-1', 'album', { parent_id: 'artist-1', title: 'Album' }));
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
      subtitle: 'S01E02',
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
      subtitle: 'S01E02',
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
    expect(album.tracks[0].subtitle).toBe('Track 1');
    expect(album.tracks[0].artwork).toEqual({ poster: { id: 'album-effective-art', mimeType: 'image/jpeg' } });
  });

  it('lists tracks directly for the top-level Music tracks grid', async () => {
    const api = new MachaMediaApi(new FakeCatalogue());
    const tracks = await api.tracks();
    expect(tracks).toEqual([expect.objectContaining({
      id: 'track-global',
      kind: 'track',
      parentId: 'album-1',
      subtitle: 'Track 3',
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

  it('falls back to node URLs, and says they need the caller\'s header', () => {
    // A flat list of strings would silently 401 here. A caller that cannot
    // send a header has to be able to tell, rather than hope.
    const api = new MachaMediaApi(new FakeCatalogue() as unknown as CatalogueApi);

    expect(api.artworkUrls({ id: 'art-1', mimeType: 'image/jpeg' })).toEqual([
      { url: 'http://node/artwork/art-1', requiresAuthorization: true },
    ]);
  });
});
