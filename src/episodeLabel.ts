import type { MediaSummary } from './types.js';

/**
 * How an episode is named where it appears away from its season: "Season 1
 * Episode 4", or "Episode 4" when no season number is known. Undefined for
 * anything that is not an episode with an episode number.
 *
 * Tom ruled 2026-09-24 that search results and Continue Watching say this in
 * place of "S01E04", with the series name beside it linking to the series and
 * this label linking to the season, whose ids are on `playbackContext`. The
 * season page's own episode rows keep their compact label, since the season is
 * already on screen there. Composed here so every client says it the same way.
 */
export function episodeLabel(item: MediaSummary): string | undefined {
  if (item.kind !== 'episode' || item.episodeNumber === undefined) return undefined;
  const season = item.playbackContext?.season.seasonNumber ?? item.seasonNumber;
  return season === undefined ? `Episode ${item.episodeNumber}` : `Season ${season} Episode ${item.episodeNumber}`;
}
