import { describe, expect, it, vi } from 'vitest';
import { episodeNeighbours } from './episodeNeighbours.js';
import type { MediaApi } from './MediaApi.js';
import type { Episode, MediaDetails, SeasonDetails, SeasonSummary, ShowDetails } from '../types.js';

const SHOW = { id: 'show', title: 'The Show' };

function season(id: string, seasonNumber: number): SeasonSummary {
  return { id, kind: 'season', title: `Season ${seasonNumber}`, showId: SHOW.id, seasonNumber, mediaIds: [] };
}
function episode(id: string, of: SeasonSummary, episodeNumber: number): Episode {
  return {
    id, kind: 'episode', title: id, seasonNumber: of.seasonNumber, episodeNumber, mediaIds: [`m:${id}`],
    playbackContext: { series: SHOW, season: { id: of.id, title: of.title, seasonNumber: of.seasonNumber } },
  };
}

// Specials, a two-episode season, an empty season, a one-episode season.
const s0 = season('s0', 0);
const s1 = season('s1', 1);
const s2 = season('s2', 2);
const s3 = season('s3', 3);
const episodes: Record<string, Episode[]> = {
  s0: [episode('special', s0, 1), episode('special-2', s0, 2)],
  s1: [episode('e1', s1, 1), episode('e2', s1, 2)],
  s2: [],
  s3: [episode('e3', s3, 1)],
};

function catalogue(overrides: Partial<Record<string, () => Promise<MediaDetails>>> = {}): MediaApi & { details: ReturnType<typeof vi.fn> } {
  const details = vi.fn(async (id: string) => {
    const override = overrides[id];
    if (override) return override();
    if (id === SHOW.id) return { ...SHOW, kind: 'show', mediaIds: [], seasons: [s0, s1, s2, s3] } as ShowDetails;
    const seasonSummary = [s0, s1, s2, s3].find((candidate) => candidate.id === id);
    if (seasonSummary) return { ...seasonSummary, episodes: episodes[id] ?? [] } as SeasonDetails;
    const found = Object.values(episodes).flat().find((candidate) => candidate.id === id);
    if (found) return found;
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  return { details } as unknown as MediaApi & { details: ReturnType<typeof vi.fn> };
}
const byId = (id: string) => Object.values(episodes).flat().find((candidate) => candidate.id === id)!;

describe('episodeNeighbours', () => {
  it('steps within a season, and hands back the show and season for the way out', async () => {
    const result = await episodeNeighbours(catalogue(), byId('e1'));
    expect(result.previous).toBeUndefined();
    expect(result.next?.id).toBe('e2');
    expect(result.season).toMatchObject({ id: 's1', kind: 'season', title: 'Season 1' });
    expect(result.season).not.toHaveProperty('episodes');
    expect(result.show).toMatchObject({ id: 'show', kind: 'show', title: 'The Show' });
  });

  it('crosses a season boundary in both directions, stepping over an empty season', async () => {
    const forward = await episodeNeighbours(catalogue(), byId('e2'));
    expect(forward.next?.id).toBe('e3');
    const back = await episodeNeighbours(catalogue(), byId('e3'));
    expect(back.previous?.id).toBe('e2');
    expect(back.next).toBeUndefined();
  });

  it('never steps from a numbered season into specials, or out of them', async () => {
    const first = await episodeNeighbours(catalogue(), byId('e1'));
    expect(first.previous).toBeUndefined();
    const special = await episodeNeighbours(catalogue(), byId('special-2'));
    expect(special.previous?.id).toBe('special');
    expect(special.next).toBeUndefined();
  });

  it('looks up an episode that arrives with no ancestry, as a Continue Watching entry might', async () => {
    const { playbackContext: _dropped, ...bare } = byId('e2');
    const result = await episodeNeighbours(catalogue(), bare);
    expect(result.previous?.id).toBe('e1');
    expect(result.next?.id).toBe('e3');
  });

  it('resolves with no neighbours rather than throwing when a parent cannot be read', async () => {
    const broken = catalogue({ s1: async () => { throw Object.assign(new Error('gone'), { status: 404 }); } });
    await expect(episodeNeighbours(broken, byId('e2'))).resolves.toEqual({});
    const { playbackContext: _dropped, ...orphan } = byId('e2');
    await expect(episodeNeighbours(catalogue({ e2: async () => { throw new Error('gone'); } }), orphan)).resolves.toEqual({});
  });

  it('keeps the neighbour it has when the one across a boundary cannot be read', async () => {
    const result = await episodeNeighbours(catalogue({ s3: async () => { throw new Error('gone'); } }), byId('e2'));
    expect(result.previous?.id).toBe('e1');
    expect(result.next).toBeUndefined();
    expect(result.show?.id).toBe('show');
  });

  it('rejects when the caller aborts, because then nobody is waiting', async () => {
    const controller = new AbortController();
    const api = catalogue({ show: async () => { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
    await expect(episodeNeighbours(api, byId('e1'), controller.signal)).rejects.toThrow('aborted');
  });
});
