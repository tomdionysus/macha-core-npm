import type { CatalogueApi } from './CatalogueApi.js';

/**
 * How much of a file, or of the files beneath an item, the reachable cluster
 * holds (server 0.82.0 for files, 0.83.0 for catalogue items and the fourth
 * code).
 *
 * - `complete`: every extent is held by a reachable node.
 * - `partial`: some are held by a reachable node and some by none.
 * - `unavailable`: none is held by a reachable node.
 * - `unknown`: rare from server 0.84.0. A file written since the last
 *   survey, an item with no files, or a file no survey has ever decided.
 *
 * From 0.84.0 the first three are the best the answering node knows: it
 * answers from its last survey, kept across a restart, and a file a survey
 * could not decide because a peer was unreachable keeps the counts of the
 * last survey that did. `surveyed_unix_ms` says when that survey ran. Before
 * 0.84.0 a node answered `unknown` until its first survey after a restart
 * (about 30 s on fi-1, 6 minutes on gbni-1), and for any file a survey could
 * not decide.
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

/**
 * Whether a title may be offered for play: anything but `unavailable` (Tom,
 * 2026-10-03). `partial` and `unknown` play as normal, and so does a title
 * from a server that reports nothing. Every client follows this rule alike.
 *
 * Not `isPlayable`, which is a different question: whether a title's kind can
 * go in a queue at all.
 */
export function availableToPlay(item: { availability?: Availability }): boolean {
  return item.availability !== 'unavailable';
}

/** A title's availability fields, as `MediaSummary` carries them. */
export interface ItemAvailability {
  availability?: Availability;
  availabilityMembers?: AvailabilityMembers;
}

/**
 * The same title without its availability, for a store that keeps it.
 *
 * Availability is how things stand now, not part of what a title is. A stored
 * `unavailable` would grey out and lock a Continue Watching card, a queued
 * title or a playlist entry after its node came back (the Android TV client,
 * 2026-10-03). So no store keeps it; a host that marks stored titles asks
 * `currentAvailability`.
 */
export function withoutAvailability<T extends object>(item: T): T {
  if (!('availability' in item) && !('availabilityMembers' in item)) return item;
  const { availability: _availability, availabilityMembers: _members, ...rest } = item as T & ItemAvailability;
  return rest as T;
}

/**
 * The current availability of stored titles, such as a Continue Watching
 * row, by item id: one catalogue read each, in parallel. A title that could
 * not be read, or that a server older than 0.83.0 reports nothing for, is
 * absent and shows no marker, so it stays playable.
 */
export async function currentAvailability(
  itemIds: readonly string[],
  catalogue: Pick<CatalogueApi, 'get'>,
  signal?: AbortSignal,
): Promise<Map<string, ItemAvailability>> {
  const ids = [...new Set(itemIds)];
  const read = await Promise.allSettled(ids.map((id) => catalogue.get(id, signal)));
  const found = new Map<string, ItemAvailability>();
  read.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    const item = result.value;
    const members = availabilityMembers(item.availability_members);
    if (typeof item.availability !== 'string' || !item.availability) return;
    found.set(ids[index], { availability: item.availability, ...(members ? { availabilityMembers: members } : {}) });
  });
  return found;
}
