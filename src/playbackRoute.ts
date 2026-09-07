import { pathForMedia, type PlaybackRouteState } from './routing.js';
import type { MediaSummary } from './types.js';

export function playerRouteItemId(pathname: string): string | undefined {
  const match = pathname.match(/^\/play\/([^/]+)$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function playbackStartsFromBeginning(search: string): boolean {
  return /(?:^|[?&])start=0(?:&|$)/.test(search);
}

export function playbackReturnTo(
  playerRouteActive: boolean,
  activeReturnTo: string | undefined,
  currentPath: string,
  media: MediaSummary,
): string {
  return playerRouteActive ? activeReturnTo ?? pathForMedia(media) : currentPath;
}

export function restoredPlaybackPosition(options: {
  fromStart: boolean;
  continueWatchingPositionMs: number;
  queuePositionMs: number;
  persistedRoutePositionMs: number;
}): number {
  if (options.fromStart) return 0;
  return Math.max(
    options.continueWatchingPositionMs,
    options.queuePositionMs,
    options.persistedRoutePositionMs,
  );
}

export function routePlaybackMedia(
  itemId: string,
  routeState: PlaybackRouteState | undefined,
  queueItems: readonly MediaSummary[] | undefined,
  progressMedia: MediaSummary | undefined,
): MediaSummary | undefined {
  if (routeState?.media?.id === itemId) return routeState.media;
  return queueItems?.find((item) => item.id === itemId) ?? progressMedia;
}
