import { describe, expect, it } from 'vitest';
import { albumLabel, trackNumberLabel, trackSubtitle } from './musicLabel.js';
import type { MediaSummary } from './types.js';

const track = (musicContext?: MediaSummary['musicContext']): MediaSummary =>
  ({ id: 't', kind: 'track', title: 'Joga', mediaIds: [], musicContext });

describe('albumLabel', () => {
  it('names the year in brackets, or nothing when it is unknown', () => {
    expect(albumLabel({ album: { id: 'a', title: 'Homogenic', year: 1997 } })).toBe('Homogenic (1997)');
    expect(albumLabel({ album: { id: 'a', title: 'Homogenic' } })).toBe('Homogenic');
  });
});

describe('trackSubtitle', () => {
  it('reads "Artist - Album (year)"', () => {
    expect(trackSubtitle(track({ album: { id: 'a', title: 'Homogenic', year: 1997 }, artist: { id: 'b', title: 'Björk' } })))
      .toBe('Björk - Homogenic (1997)');
  });

  it('gives the album alone with no artist, and nothing with no context', () => {
    expect(trackSubtitle(track({ album: { id: 'a', title: 'Homogenic' } }))).toBe('Homogenic');
    expect(trackSubtitle(track())).toBeUndefined();
  });
});

describe('trackNumberLabel', () => {
  it('names the disc only after the first', () => {
    expect(trackNumberLabel({ trackNumber: 9 })).toBe('Track 9');
    expect(trackNumberLabel({ discNumber: 1, trackNumber: 9 })).toBe('Track 9');
    expect(trackNumberLabel({ discNumber: 2, trackNumber: 3 })).toBe('Disc 2 · Track 3');
  });

  it('says nothing without a track number', () => {
    expect(trackNumberLabel({ discNumber: 2 })).toBeUndefined();
    expect(trackNumberLabel({})).toBeUndefined();
  });
});
