import type { ManageApi, ManualMetadata, ManualMetadataResult, MediaProbeCandidate } from './ManageApi.js';

/**
 * What to identify an unmatched file as, whichever way the viewer arrived at
 * it. Tom, 2026-09-24: matching and metadata editing become one interface in
 * every client, and core manages all of the server interaction behind it.
 *
 * - `candidate`: one of the file's own probe candidates, as `unmatchedDetail`
 *   returns them;
 * - `catalogue`: an item already in the catalogue, from `prospectiveMatches`
 *   or a search;
 * - `manual`: metadata the viewer entered.
 *
 * A fourth, `provider`, joins when the server ships a provider search that
 * returns results a match can refer to; parent links by id and a choice of
 * artwork join when the server accepts them. None is modelled before its
 * route exists.
 */
export type Identification =
  | { from: 'candidate'; probe: MediaProbeCandidate }
  | { from: 'catalogue'; catalogueItemId: string }
  | { from: 'manual'; metadata: ManualMetadata };

/** What applying an identification did. */
export type IdentificationResult =
  | { applied: 'matched'; catalogueItemId: string }
  | { applied: 'created'; result: ManualMetadataResult };

/**
 * A candidate the server can catalogue as it stands, or undefined when it is
 * missing what the manual route requires: a movie needs a title; an episode
 * a series and its season and episode numbers; a track an artist, an album
 * and a title. A client offers only the candidates this accepts, and routes
 * the rest to manual entry pre-filled from the probe.
 *
 * For an episode, the probe's year becomes the series year. That is how
 * filenames carry it (`Show (2005) S01E02`), and it tells two series of one
 * name apart.
 */
export function manualFromCandidate(probe: MediaProbeCandidate): ManualMetadata | undefined {
  const text = (value: string | null | undefined) => (value && value.trim() ? value.trim() : undefined);
  const number = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const title = text(probe.title);
  const year = number(probe.year);
  if (probe.kind === 'movie') {
    if (!title) return undefined;
    return { kind: 'movie', title, ...(year !== undefined ? { year } : {}) };
  }
  if (probe.kind === 'episode') {
    const series = text(probe.series);
    const season = number(probe.season_number);
    const episode = number(probe.episode_number);
    if (!series || season === undefined || episode === undefined) return undefined;
    return {
      kind: 'episode', series, season_number: season, episode_number: episode,
      ...(year !== undefined ? { series_year: year } : {}),
      ...(title ? { title } : {}),
    };
  }
  const artist = text(probe.artist);
  const album = text(probe.album);
  if (!artist || !album || !title) return undefined;
  const disc = number(probe.disc_number);
  const track = number(probe.track_number);
  return {
    kind: 'track', artist, album, title,
    ...(year !== undefined ? { year } : {}),
    ...(disc !== undefined ? { disc_number: disc } : {}),
    ...(track !== undefined ? { track_number: track } : {}),
  };
}

/**
 * Identify an unmatched file, by whichever route the identification needs:
 * `match` for an existing catalogue item, `manual` for a candidate or entered
 * metadata. The one place that knows which call each path takes, so every
 * client applies the same way.
 *
 * Throws `IdentificationError` with code `candidate_incomplete` for a
 * candidate `manualFromCandidate` refuses; any other failure is the server's
 * error, as the API threw it.
 */
export async function identifyUnmatched(manage: ManageApi, fileId: string, identification: Identification): Promise<IdentificationResult> {
  if (identification.from === 'catalogue') {
    await manage.match(fileId, identification.catalogueItemId);
    return { applied: 'matched', catalogueItemId: identification.catalogueItemId };
  }
  const metadata = identification.from === 'manual' ? identification.metadata : manualFromCandidate(identification.probe);
  if (!metadata) throw new IdentificationError(`Candidate for ${fileId} lacks what the manual route requires.`, CANDIDATE_INCOMPLETE_CODE);
  return { applied: 'created', result: await manage.manual(fileId, metadata) };
}

/** A candidate `manualFromCandidate` refuses; a host words it and offers manual entry. */
export const CANDIDATE_INCOMPLETE_CODE = 'candidate_incomplete';

export class IdentificationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'IdentificationError';
  }
}
