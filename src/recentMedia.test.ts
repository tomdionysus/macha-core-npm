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
