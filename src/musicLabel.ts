import { joinSubtitle } from './subtitleJoin.js';
import type { MediaSummary, MusicHierarchyContext } from './types.js';

/**
 * An album named with its year: "Homogenic (1997)", or "Homogenic" with no
 * year known. Tom ruled 2026-09-24, through the web client, that a track in
 * search reads "Artist - Album (year)", with the artist and the album each
 * linking to its page. This is the album half, the text of its link.
 */
export function albumLabel(context: MusicHierarchyContext): string {
  const { title, year } = context.album;
  return year === undefined ? title : `${title} (${year})`;
}

/**
 * The whole line, "Björk - Homogenic (1997)", for a client that shows it as
 * one piece rather than two links, such as a television card that is a
 * single focus target. The album alone when no artist is known; undefined
 * for an item with no music context.
 */
export function trackSubtitle(item: MediaSummary): string | undefined {
  const context = item.musicContext;
  if (!context) return undefined;
  const album = albumLabel(context);
  return context.artist ? `${context.artist.title} - ${album}` : album;
}

/**
 * A track's own place on its album: "Track 9", or "Disc 2 · Track 3" on any
 * disc after the first. Undefined without a track number. It is the subtitle
 * core gives a track on an album page, and the third line of a search track
 * card beneath `trackSubtitle`, composed once so the two cannot disagree.
 * Asked for by the Android TV client.
 */
export function trackNumberLabel(item: Pick<MediaSummary, 'discNumber' | 'trackNumber'>): string | undefined {
  if (item.trackNumber === undefined) return undefined;
  return item.discNumber !== undefined && item.discNumber > 1
    ? joinSubtitle(`Disc ${item.discNumber}`, `Track ${item.trackNumber}`)
    : `Track ${item.trackNumber}`;
}
