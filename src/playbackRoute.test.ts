import { describe, expect, it } from 'vitest';
import type { MediaSummary } from './types.js';
import {
  playbackReturnTo,
  playbackStartsFromBeginning,
  playerRouteItemId,
  restoredPlaybackPosition,
  routePlaybackMedia,
} from './playbackRoute.js';

const movie = (id: string): MediaSummary => ({ id, kind: 'movie', title: id, mediaIds: [id] });

describe('playback route restoration', () => {
  it('decodes only exact player routes', () => {
    expect(playerRouteItemId('/play/movie%3Aone')).toBe('movie:one');
    expect(playerRouteItemId('/play/movie/one')).toBeUndefined();
    expect(playerRouteItemId('/movies/movie%3Aone')).toBeUndefined();
  });

  it('recognises an explicit start-from-beginning query', () => {
    expect(playbackStartsFromBeginning('?start=0')).toBe(true);
    expect(playbackStartsFromBeginning('?quality=720&start=0')).toBe(true);
    expect(playbackStartsFromBeginning('?start=1')).toBe(false);
  });

  it('keeps the established return route while replacing player media', () => {
    expect(playbackReturnTo(true, '/series/show', '/play/old', movie('new'))).toBe('/series/show');
    expect(playbackReturnTo(true, undefined, '/play/old', movie('new'))).toBe('/movies/new');
    expect(playbackReturnTo(false, '/ignored', '/search?q=new', movie('new'))).toBe('/search?q=new');
  });

  it('uses the latest resumable checkpoint unless start=0 is explicit', () => {
    const checkpoints = {
      continueWatchingPositionMs: 10_000,
      queuePositionMs: 20_000,
      persistedRoutePositionMs: 30_000,
    };
    expect(restoredPlaybackPosition({ ...checkpoints, fromStart: false })).toBe(30_000);
    expect(restoredPlaybackPosition({ ...checkpoints, fromStart: true })).toBe(0);
  });

  it('prefers route media, then queue media, then Continue Watching media', () => {
    const route = movie('target');
    const queued = movie('target');
    const progress = movie('target');
    expect(routePlaybackMedia('target', { media: route }, [queued], progress)).toBe(route);
    expect(routePlaybackMedia('target', undefined, [queued], progress)).toBe(queued);
    expect(routePlaybackMedia('target', undefined, [movie('other')], progress)).toBe(progress);
  });
});
