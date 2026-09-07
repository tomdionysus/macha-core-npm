import type { MediaSummary } from './types.js';

/**
 * Order Home-page catalogue rows by the newest chronology signal currently
 * supplied by the server. The wire model exposes catalogue updated_ns rather
 * than a separate immutable ingest timestamp, so keep that distinction visible
 * in the MediaSummary field name.
 */
export function newestCatalogueFirst(items: readonly MediaSummary[]): MediaSummary[] {
  return [...items].sort((left, right) => {
    const timestamp = (right.catalogueUpdatedNs ?? 0) - (left.catalogueUpdatedNs ?? 0);
    if (timestamp !== 0) return timestamp;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}
