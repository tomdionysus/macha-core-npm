import { withoutAvailability } from '../api/availability.js';
import type { MediaSummary } from '../types.js';

/**
 * A title as a saved list keeps it: what a row needs to be drawn and played
 * with no node reachable, and nothing else.
 *
 * Every field it drops is optional on `MediaSummary`, so a `SavedTitle` is
 * still one and renders through the same code. Dropped:
 * - `synopsis`, free text of any length that no list row draws;
 * - `availability` and `availabilityMembers`, which are how things stand now
 *   (see `withoutAvailability`);
 * - `catalogueUpdatedNs` and `releaseDate`, which order and describe a
 *   catalogue, not a list the viewer made.
 *
 * Tom, 2026-10-04: saved playlists store slim entries, and it "needs to just
 * work". Artwork stays as the catalogue gave it, signed link included: a
 * stored link is good for at least a day and then only `artworkUrls`'s
 * authenticated candidates remain, which is the open refresh question, not
 * this one.
 */
export type SavedTitle = Omit<MediaSummary, 'synopsis' | 'catalogueUpdatedNs' | 'releaseDate' | 'availability' | 'availabilityMembers'>;

export function savedTitle(item: MediaSummary): SavedTitle {
  const { synopsis: _synopsis, catalogueUpdatedNs: _updated, releaseDate: _release, ...rest } = withoutAvailability(item);
  return rest;
}

/**
 * The most a saved list writes to one storage row, in UTF-8 bytes.
 *
 * Android's AsyncStorage reads a row through a SQLite CursorWindow of about
 * 2 MB, and a row larger than that cannot be read back at all and takes the
 * other keys in its read batch with it. The phone client measured that with
 * a whole-library play queue (`bb3d79c`). Half of it leaves room for the key
 * and for the window's own overhead.
 */
export const SAVED_ROW_LIMIT_BYTES = 1024 * 1024;

/**
 * A saved list refused a change that would have made its row too large to
 * read back. Nothing was written, so what was saved before is intact.
 *
 * `code` is for the client to word. A row is one playlist, so a host can
 * offer to start another.
 */
export class MachaSavedRowLimitError extends Error {
  readonly code = 'saved_row_limit';

  constructor(public readonly key: string, public readonly bytes: number, public readonly limitBytes: number) {
    super(`Saved row ${key} would be ${bytes} bytes, over the ${limitBytes} byte limit.`);
    this.name = 'MachaSavedRowLimitError';
  }
}

/** UTF-8 length of a string, which is what a storage row holds, not its UTF-16 `length`. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair is one code point of four bytes.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * A row's stored text, refused with `MachaSavedRowLimitError` when it could
 * not be read back. Serialise every row of a change first and write after,
 * so a refusal leaves nothing half-saved.
 */
export function savedRow(key: string, value: unknown, limitBytes = SAVED_ROW_LIMIT_BYTES): string {
  const raw = JSON.stringify(value);
  const bytes = utf8Bytes(raw);
  if (bytes > limitBytes) throw new MachaSavedRowLimitError(key, bytes, limitBytes);
  return raw;
}
