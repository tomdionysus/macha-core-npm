import { describe, expect, it } from 'vitest';
import { availabilityMembers, extentAvailability } from './availability.js';

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
