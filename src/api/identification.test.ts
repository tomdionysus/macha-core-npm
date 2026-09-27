import { describe, expect, it, vi } from 'vitest';
import { CANDIDATE_INCOMPLETE_CODE, identifyUnmatched, manualFromCandidate } from './identification.js';
import type { ManageApi, MediaProbeCandidate } from './ManageApi.js';

function probe(partial: Partial<MediaProbeCandidate>): MediaProbeCandidate {
  return {
    kind: 'movie', score: 1, generator: 'filename', title: '', year: null, series: '',
    season_number: null, episode_number: null, artist: '', album: '', disc_number: null, track_number: null, evidence: [],
    ...partial,
  };
}

function manage() {
  return {
    match: vi.fn(async () => undefined),
    manual: vi.fn(async () => ({ leaf_item_id: 'leaf', items: [] })),
  } as unknown as ManageApi & { match: ReturnType<typeof vi.fn>; manual: ReturnType<typeof vi.fn> };
}

describe('manualFromCandidate', () => {
  it('turns each kind into what the manual route takes', () => {
    expect(manualFromCandidate(probe({ kind: 'movie', title: 'Alien', year: 1979 }))).toEqual({ kind: 'movie', title: 'Alien', year: 1979 });
    expect(manualFromCandidate(probe({ kind: 'episode', series: 'Doctor Who', year: 2005, season_number: 1, episode_number: 2, title: 'The End of the World' })))
      .toEqual({ kind: 'episode', series: 'Doctor Who', series_year: 2005, season_number: 1, episode_number: 2, title: 'The End of the World' });
    expect(manualFromCandidate(probe({ kind: 'track', artist: 'Björk', album: 'Homogenic', title: 'Jóga', year: 1997, disc_number: 1, track_number: 2 })))
      .toEqual({ kind: 'track', artist: 'Björk', album: 'Homogenic', title: 'Jóga', year: 1997, disc_number: 1, track_number: 2 });
  });

  it('refuses a candidate missing what the server requires', () => {
    expect(manualFromCandidate(probe({ kind: 'movie', title: '  ' }))).toBeUndefined();
    expect(manualFromCandidate(probe({ kind: 'episode', series: 'Doctor Who', season_number: 1 }))).toBeUndefined();
    expect(manualFromCandidate(probe({ kind: 'episode', season_number: 1, episode_number: 2 }))).toBeUndefined();
    expect(manualFromCandidate(probe({ kind: 'track', artist: 'Björk', title: 'Jóga' }))).toBeUndefined();
  });

  it('leaves out what the probe does not know, rather than sending nulls', () => {
    expect(manualFromCandidate(probe({ kind: 'episode', series: 'S', season_number: 0, episode_number: 1 })))
      .toEqual({ kind: 'episode', series: 'S', season_number: 0, episode_number: 1 });
  });
});

describe('identifyUnmatched', () => {
  it('matches an existing catalogue item', async () => {
    const api = manage();
    await expect(identifyUnmatched(api, 'f1', { from: 'catalogue', catalogueItemId: 'movie:alien' }))
      .resolves.toEqual({ applied: 'matched', catalogueItemId: 'movie:alien' });
    expect(api.match).toHaveBeenCalledWith('f1', 'movie:alien');
    expect(api.manual).not.toHaveBeenCalled();
  });

  it('sends a candidate and entered metadata through the manual route', async () => {
    const api = manage();
    await identifyUnmatched(api, 'f1', { from: 'candidate', probe: probe({ kind: 'movie', title: 'Alien', year: 1979 }) });
    await identifyUnmatched(api, 'f2', { from: 'manual', metadata: { kind: 'movie', title: 'Aliens' } });
    expect(api.manual.mock.calls).toEqual([
      ['f1', { kind: 'movie', title: 'Alien', year: 1979 }],
      ['f2', { kind: 'movie', title: 'Aliens' }],
    ]);
  });

  it('refuses an incomplete candidate with a code, and asks the server nothing', async () => {
    const api = manage();
    await expect(identifyUnmatched(api, 'f1', { from: 'candidate', probe: probe({ kind: 'track', title: 'Jóga' }) }))
      .rejects.toMatchObject({ code: CANDIDATE_INCOMPLETE_CODE });
    expect(api.manual).not.toHaveBeenCalled();
  });
});
