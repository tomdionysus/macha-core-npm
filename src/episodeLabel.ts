import { joinSubtitle } from './subtitleJoin.js';
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

/**
 * The episode's label with its series before it: "Firefly · Season 1 Episode
 * 4". The label alone when no series is known; undefined when there is no
 * label either. What search hits carry as their subtitle and what a Continue
 * Watching card shows, composed once so the two cannot disagree. Asked for by
 * the Android TV client.
 */
export function episodeSubtitle(item: MediaSummary): string | undefined {
  const label = episodeLabel(item);
  const series = item.playbackContext?.series.title;
  if (!series) return label;
  return joinSubtitle(series, label);
}
