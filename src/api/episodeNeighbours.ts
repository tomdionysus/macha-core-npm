import type { MediaApi } from './MediaApi.js';
import type { Episode, MediaSummary, SeasonDetails, SeasonSummary, ShowDetails } from '../types.js';

/**
 * An episode's place in its show: the episodes either side of it, and the
 * show and season it sits in.
 *
 * `show` and `season` are what a host needs to build its way back out --
 * TV Shows, then the series, then the season -- without a second round trip:
 * ids, titles and kinds, already fetched to work out the neighbours. Both are
 * absent only when the episode's ancestry could not be found at all.
 */
export interface EpisodeNeighbours {
  previous?: Episode;
  next?: Episode;
  season?: SeasonSummary;
  show?: ShowDetails;
}

/**
 * The episodes either side of this one, crossing season boundaries.
 *
 * **Every client needs this and none had it.** Next and previous are the same
 * question on every platform, answered from the catalogue alone, so they are
 * worked out once here; a host owns only the buttons and where they sit.
 *
 * **Across a season boundary** the next episode after a season's last is the
 * first episode of the next season that has any, and the previous before a
 * season's first is the last of the previous season that has any. Empty
 * seasons are stepped over, not treated as the end of the show.
 *
 * **Specials are a chain of their own.** Season 0 is left out of the chain
 * for every other season, so "next" after a finale ends at the finale rather
 * than dropping into a behind-the-scenes special; and an episode inside
 * season 0 steps only between specials. Specials carry no broadcast order
 * against the numbered seasons, and inventing one is worse than stopping.
 *
 * **Never throws for a missing or broken hierarchy.** An episode with no
 * ancestry attached is looked up once; if that, or any parent, cannot be
 * read, the answer has no neighbours and a host greys its buttons. A
 * neighbour that cannot be read across a boundary is simply absent. The one
 * thing that does reject is the caller's own `signal` aborting, because then
 * nobody is waiting for the answer.
 */
export async function episodeNeighbours(
  api: MediaApi,
  episode: MediaSummary,
  signal?: AbortSignal,
): Promise<EpisodeNeighbours> {
  const context = episode.playbackContext ?? await ancestryOf(api, episode, signal);
  if (!context) return {};

  let show: ShowDetails;
  let season: SeasonDetails;
  try {
    const [showDetails, seasonDetails] = await Promise.all([
      api.details(context.series.id, signal),
      api.details(context.season.id, signal),
    ]);
    if (showDetails.kind !== 'show' || seasonDetails.kind !== 'season') return {};
    show = showDetails as ShowDetails;
    season = seasonDetails as SeasonDetails;
  } catch (error) {
    rethrowIfAborted(error, signal);
    return {};
  }

  const summary = seasonSummaryOf(season);
  const episodes = season.episodes;
  let index = episodes.findIndex((candidate) => candidate.id === episode.id);
  // The catalogue may have been rebuilt since the episode was saved, which
  // changes nothing about where it sits in the show.
  if (index === -1 && episode.episodeNumber !== undefined) {
    index = episodes.findIndex((candidate) => candidate.episodeNumber === episode.episodeNumber);
  }
  if (index === -1) return { season: summary, show };

  const chain = show.seasons.filter((candidate) => (season.seasonNumber === 0) === (candidate.seasonNumber === 0));
  const position = chain.findIndex((candidate) => candidate.id === season.id);

  const [previous, next] = await Promise.all([
    index > 0
      ? Promise.resolve(episodes[index - 1])
      : acrossBoundary(api, chain.slice(0, Math.max(0, position)).reverse(), 'last', signal),
    index < episodes.length - 1
      ? Promise.resolve(episodes[index + 1])
      : acrossBoundary(api, position === -1 ? [] : chain.slice(position + 1), 'first', signal),
  ]);
  return {
    ...(previous ? { previous } : {}),
    ...(next ? { next } : {}),
    season: summary,
    show,
  };
}

async function ancestryOf(api: MediaApi, episode: MediaSummary, signal?: AbortSignal) {
  if (episode.kind !== 'episode') return undefined;
  try {
    return (await api.details(episode.id, signal)).playbackContext;
  } catch (error) {
    rethrowIfAborted(error, signal);
    return undefined;
  }
}

/** The first or last episode of the nearest season in `seasons` that has any. */
async function acrossBoundary(
  api: MediaApi,
  seasons: readonly SeasonSummary[],
  end: 'first' | 'last',
  signal?: AbortSignal,
): Promise<Episode | undefined> {
  for (const candidate of seasons) {
    let details;
    try {
      details = await api.details(candidate.id, signal);
    } catch (error) {
      rethrowIfAborted(error, signal);
      return undefined;
    }
    const episodes = details.kind === 'season' ? (details as SeasonDetails).episodes : [];
    if (episodes.length > 0) return end === 'first' ? episodes[0] : episodes[episodes.length - 1];
  }
  return undefined;
}

function seasonSummaryOf(season: SeasonDetails): SeasonSummary {
  const { episodes: _episodes, ...summary } = season;
  return summary;
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw error;
}
