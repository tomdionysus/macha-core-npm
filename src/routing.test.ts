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
    expect(routes.connection).toBe('/settings/connection');
    expect(routes.statusNode('node:one')).toBe('/status/nodes/node%3Aone');
    expect(routes.manage).toBe('/manage');
    expect(routes.manageFiles).toBe('/manage/files');
    expect(routes.manageUsers).toBe('/manage/users');
    expect(routes.login).toBe('/login');
    expect(routes.account).toBe('/account');
    expect(routes.accountPassword).toBe('/account/password');
    expect(routes.settings).toBe('/settings');
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

describe('routing a media item that is not a plain title', () => {
  const item = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'x1', kind, title: 'x', mediaIds: ['x1'], ...extra }) as unknown as MediaSummary;

  it('routes a season through its show, so the page has its parent to render', () => {
    expect(pathForMedia(item('season', { parentId: 'show-9' }))).toBe(routes.season('show-9', 'x1'));
  });

  it('falls back to the generic item route for a season with no known parent', () => {
    // A season page cannot be drawn without its show, so an orphan goes to
    // the generic route rather than to a URL missing a segment.
    expect(pathForMedia(item('season'))).toBe(routes.item('x1'));
  });

  it('routes music kinds to their own pages', () => {
    expect(pathForMedia(item('artist'))).toBe(routes.artist('x1'));
    expect(pathForMedia(item('album'))).toBe(routes.album('x1'));
    expect(pathForMedia(item('track'))).toBe(routes.track('x1'));
  });

  it('sends a kind it has never heard of to the generic item route', () => {
    // A server that adds a kind must not produce a dead link in an old client.
    expect(pathForMedia(item('audiobook'))).toBe(routes.item('x1'));
  });
});
