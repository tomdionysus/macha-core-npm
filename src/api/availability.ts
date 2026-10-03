/**
 * How much of a file, or of the files beneath an item, the reachable cluster
 * holds (server 0.82.0 for files, 0.83.0 for catalogue items and the fourth
 * code).
 *
 * - `complete`: every extent is held by a reachable node.
 * - `partial`: some are held by a reachable node and some by none.
 * - `unavailable`: none is held by a reachable node.
 * - `unknown`: not surveyed yet, or some extents could not be decided.
 *   Expect it for a few minutes after a node restarts, and briefly for a
 *   newly imported file.
 *
 * Facts about extents being held, from each node's index of what it stores:
 * not a promise the bytes read back, and "no reachable node" is not "lost",
 * since a node that is down may hold them. The server refuses nothing on
 * them; what a viewer is shown or offered is the client's. The set is open,
 * so keep a code this does not name.
 */
export type Availability = 'complete' | 'partial' | 'unavailable' | 'unknown' | (string & {});

/**
 * A set's members by availability: the items beneath a show, season, artist
 * or album, at any depth, that have files. `total` is their count.
 */
export interface AvailabilityMembers {
  total: number;
  complete: number;
  partial: number;
  unavailable: number;
  unknown: number;
}

/** The seven extent fields as a file carries them on the wire. */
export interface WireExtentAvailability {
  availability: Availability;
  /** The extents the file refers to. Null when `unknown` and nothing was surveyed. */
  extents: number | null;
  /** Those the answering node holds. */
  extents_local: number | null;
  /** Those no reachable node holds. */
  extents_unavailable: number | null;
  /** Those the answering node lacks, where a node that might hold them could not be asked. */
  extents_unknown: number | null;
  /** The metadata generation of the survey these came from; null before a node's first. */
  surveyed_generation: number | null;
  surveyed_unix_ms: number | null;
}

/** A file's availability, decoded. A count or survey the server left null is absent. */
export interface ExtentAvailability {
  availability: Availability;
  extents?: number;
  extentsLocal?: number;
  extentsUnavailable?: number;
  extentsUnknown?: number;
  surveyedGeneration?: number;
  surveyedUnixMs?: number;
}

/** Decode a file's availability; undefined from a server that does not report it. */
export function extentAvailability(record: Record<string, unknown>): ExtentAvailability | undefined {
  if (typeof record.availability !== 'string' || !record.availability) return undefined;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const fields = {
    extents: count(record.extents),
    extentsLocal: count(record.extents_local),
    extentsUnavailable: count(record.extents_unavailable),
    extentsUnknown: count(record.extents_unknown),
    surveyedGeneration: count(record.surveyed_generation),
    surveyedUnixMs: count(record.surveyed_unix_ms),
  };
  return {
    availability: record.availability,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  };
}

/** Decode a set's member counts; undefined for an item that is not a set, or a malformed record. */
export function availabilityMembers(value: unknown): AvailabilityMembers | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const keys = ['total', 'complete', 'partial', 'unavailable', 'unknown'] as const;
  if (!keys.every((key) => typeof record[key] === 'number')) return undefined;
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as AvailabilityMembers;
}
