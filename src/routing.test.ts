import { describe, expect, it } from 'vitest';
import { pathForMedia, routes } from './routing.js';
import type { MediaSummary } from './types.js';

const item = (partial: Partial<MediaSummary>): MediaSummary => ({
  id: 'id',
  kind: 'movie',
  title: 'Title',
  mediaIds: [],
  ...partial,
});

describe('routes', () => {
  it('uses stable browser-history paths for movies, series, music and playback', () => {
    expect(routes.movie('movie:one')).toBe('/movies/movie%3Aone');
    expect(routes.show('show:one')).toBe('/series/show%3Aone');
    expect(routes.season('show:one', 'season:1')).toBe('/series/show%3Aone/seasons/season%3A1');
    expect(routes.musicArtists).toBe('/music/artists');
    expect(routes.musicAlbums).toBe('/music/albums');
    expect(routes.musicTracks).toBe('/music/tracks');
    expect(routes.musicPlaylist).toBe('/music/playlist');
    expect(routes.ingest).toBe('/ingest');
    expect(routes.status).toBe('/status');
    expect(routes.statusClient).toBe('/status/client');
    expect(routes.statusConnectivity).toBe('/status/connectivity');
    expect(routes.connection).toBe('/manage/settings/connection');
    expect(routes.statusNode('node:one')).toBe('/status/nodes/node%3Aone');
    expect(routes.manage).toBe('/manage');
    expect(routes.manageFiles).toBe('/manage/files');
    expect(routes.settings).toBe('/manage/settings');
    expect(routes.artist('artist:one')).toBe('/music/artists/artist%3Aone');
    expect(routes.album('album:one')).toBe('/music/albums/album%3Aone');
    expect(routes.track('track:one')).toBe('/music/tracks/track%3Aone');
    expect(routes.player('track:one')).toBe('/play/track%3Aone');
    expect(routes.playerFromStart('track:one')).toBe('/play/track%3Aone?start=0');
  });

  it('routes season catalogue items through their parent series', () => {
    expect(pathForMedia(item({ id: 'season:1', kind: 'season', parentId: 'show:one' })))
      .toBe('/series/show%3Aone/seasons/season%3A1');
  });

  it('routes music catalogue items through first-class music paths', () => {
    expect(pathForMedia(item({ id: 'artist:one', kind: 'artist' }))).toBe('/music/artists/artist%3Aone');
    expect(pathForMedia(item({ id: 'album:one', kind: 'album' }))).toBe('/music/albums/album%3Aone');
    expect(pathForMedia(item({ id: 'track:one', kind: 'track' }))).toBe('/music/tracks/track%3Aone');
  });
});
