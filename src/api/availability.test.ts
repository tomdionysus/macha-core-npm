import { describe, expect, it, vi } from 'vitest';
import type { CatalogueItem } from './CatalogueApi.js';
import { availabilityMembers, availableToPlay, currentAvailability, extentAvailability, withoutAvailability } from './availability.js';

describe('extentAvailability', () => {
  it('decodes the seven fields a file carries (server 0.82.0)', () => {
    expect(extentAvailability({
      availability: 'partial', extents: 40, extents_local: 30, extents_unavailable: 10, extents_unknown: 0,
      surveyed_generation: 812, surveyed_unix_ms: 1_791_000_000_000,
    })).toEqual({
      availability: 'partial', extents: 40, extentsLocal: 30, extentsUnavailable: 10, extentsUnknown: 0,
      surveyedGeneration: 812, surveyedUnixMs: 1_791_000_000_000,
    });
  });

  it('leaves out the counts and survey the server sent as null, as for a file not yet surveyed', () => {
    expect(extentAvailability({
      availability: 'unknown', extents: null, extents_local: null, extents_unavailable: null, extents_unknown: null,
      surveyed_generation: null, surveyed_unix_ms: null,
    })).toEqual({ availability: 'unknown' });
  });

  it('keeps a code it does not name, and answers nothing for a server that sends none', () => {
    expect(extentAvailability({ availability: 'degraded' })).toEqual({ availability: 'degraded' });
    expect(extentAvailability({ media_id: 'macha:abc' })).toBeUndefined();
  });
});

describe('availabilityMembers', () => {
  it("decodes a set's counts, and nothing for an item that is not a set", () => {
    expect(availabilityMembers({ total: 10, complete: 6, partial: 2, unavailable: 1, unknown: 1 }))
      .toEqual({ total: 10, complete: 6, partial: 2, unavailable: 1, unknown: 1 });
    expect(availabilityMembers(null)).toBeUndefined();
    expect(availabilityMembers({ total: 10 })).toBeUndefined();
  });
});

describe('availableToPlay', () => {
  it('blocks only unavailable (Tom, 2026-10-03)', () => {
    expect(availableToPlay({ availability: 'unavailable' })).toBe(false);
    for (const availability of ['complete', 'partial', 'unknown', 'degraded', undefined]) {
      expect(availableToPlay({ availability })).toBe(true);
    }
  });
});

describe('withoutAvailability', () => {
  it('drops both fields and keeps the rest', () => {
    const item = { id: 'm', availability: 'partial', availabilityMembers: { total: 1, complete: 0, partial: 1, unavailable: 0, unknown: 0 } };
    expect(withoutAvailability(item)).toEqual({ id: 'm' });
    const plain = { id: 'n' };
    expect(withoutAvailability(plain)).toBe(plain);
  });
});

describe('currentAvailability', () => {
  it('reads each stored title once, and leaves out one that failed or reports nothing', async () => {
    const items: Record<string, Partial<CatalogueItem>> = {
      show: { availability: 'partial', availability_members: { total: 2, complete: 1, partial: 0, unavailable: 1, unknown: 0 } },
      movie: { availability: 'unavailable', availability_members: null },
      older: {},
    };
    const get = vi.fn(async (id: string) => {
      if (!(id in items)) throw new Error('not found');
      return { id, ...items[id] } as CatalogueItem;
    });

    const found = await currentAvailability(['show', 'movie', 'older', 'gone', 'movie'], { get });

    expect(get).toHaveBeenCalledTimes(4);
    expect([...found]).toEqual([
      ['show', { availability: 'partial', availabilityMembers: { total: 2, complete: 1, partial: 0, unavailable: 1, unknown: 0 } }],
      ['movie', { availability: 'unavailable' }],
    ]);
  });
});
