import { describe, expect, it } from 'vitest';
import { ARTWORK_HEDGE_MAX_IN_FLIGHT, nextArtworkSource } from './artworkHedge.js';

const a = 'http://a/api/v1/catalogue/artwork/x?exp=1&sig=s';
const aOwn = 'http://a/api/v1/catalogue/artwork/x';
const b = 'http://b/api/v1/catalogue/artwork/x';

describe('nextArtworkSource', () => {
  it('hedges to another host, past the same host listed twice', () => {
    expect(nextArtworkSource([a, aOwn, b], [0], [0], true)).toBe(2);
  });

  it('after a failure, takes the next untried source on any host', () => {
    expect(nextArtworkSource([a, aOwn, b], [0], [], false)).toBe(1);
  });

  it('has nothing to hedge to when every other source shares the busy host', () => {
    expect(nextArtworkSource([a, aOwn], [0], [0], true)).toBeUndefined();
  });

  it('never runs more than the limit at once', () => {
    expect(ARTWORK_HEDGE_MAX_IN_FLIGHT).toBe(2);
    const c = 'http://c/api/v1/catalogue/artwork/x';
    expect(nextArtworkSource([a, b, c], [0, 1], [0, 1], true)).toBeUndefined();
  });

  it('answers nothing once every source is tried', () => {
    expect(nextArtworkSource([a, b], [0, 1], [], false)).toBeUndefined();
  });
});
