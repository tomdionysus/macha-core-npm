import { describe, expect, it } from 'vitest';
import { newestCatalogueFirst } from './recentMedia.js';
import type { MediaSummary } from './types.js';

function item(id: string, catalogueUpdatedNs?: number): MediaSummary {
  return { id, kind: 'movie', title: id, mediaIds: [], catalogueUpdatedNs };
}

describe('newestCatalogueFirst', () => {
  it('orders the newest catalogue timestamp first without mutating its input', () => {
    const input = [item('old', 10), item('new', 30), item('middle', 20)];
    expect(newestCatalogueFirst(input).map((entry) => entry.id)).toEqual(['new', 'middle', 'old']);
    expect(input.map((entry) => entry.id)).toEqual(['old', 'new', 'middle']);
  });
});

describe('ordering when the server gives no chronology', () => {
  it('falls back to title when two items share a timestamp', () => {
    // Without a stable tiebreak the Home rows reshuffle between renders for
    // items ingested in the same batch, which is most of a bulk import.
    const ordered = newestCatalogueFirst([item('Zulu', 10), item('Alpha', 10)]);
    expect(ordered.map((entry) => entry.id)).toEqual(['Alpha', 'Zulu']);
  });

  it('treats a missing timestamp as oldest rather than newest', () => {
    // An item the server has said nothing about must not displace one it has.
    const ordered = newestCatalogueFirst([item('unknown'), item('dated', 5)]);
    expect(ordered.map((entry) => entry.id)).toEqual(['dated', 'unknown']);
  });

  it('breaks a title tie on id, so the order is total', () => {
    const ordered = newestCatalogueFirst([
      { id: 'b', kind: 'movie', title: 'Same', mediaIds: [] },
      { id: 'a', kind: 'movie', title: 'Same', mediaIds: [] },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
