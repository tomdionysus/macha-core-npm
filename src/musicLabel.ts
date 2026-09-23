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
