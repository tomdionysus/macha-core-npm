import { describe, expect, it, vi } from 'vitest';
import { migrateEpisodeContext, needsEpisodeContextMigration } from './continueWatchingMigration.js';
import type { MediaApi } from '../api/MediaApi.js';
import type { MediaSummary, PlaybackHierarchyContext, PlaybackProgress } from '../types.js';

const entry = (media?: Partial<MediaSummary>): PlaybackProgress => ({
  mediaId: 'macha:ep-1',
  positionMs: 40_000,
  durationMs: 100_000,
  updatedAt: 1,
  ...(media ? { media: { id: 'macha:ep-1', title: 'Pilot', mediaIds: ['macha:ep-1'], ...media } as MediaSummary } : {}),
});

const context: PlaybackHierarchyContext = {
  series: { id: 'show-1', title: 'Deep Space Nine' },
  season: { id: 'season-1', title: 'Season 1', seasonNumber: 1 },
};

function apiReturning(media: unknown): MediaApi {
  return { details: vi.fn(async () => media) } as unknown as MediaApi;
}

describe('recognising an entry that predates episode ancestry', () => {
  it('needs migrating when an episode carries no context', () => {
    expect(needsEpisodeContextMigration(entry({ kind: 'episode' }))).toBe(true);
  });

  it('does not need migrating once the context is there', () => {
    expect(needsEpisodeContextMigration(entry({ kind: 'episode', playbackContext: context }))).toBe(false);
  });

  it('does not need migrating for a film, which has no ancestry to carry', () => {
    expect(needsEpisodeContextMigration(entry({ kind: 'movie' }))).toBe(false);
  });

  it('does not need migrating when the entry has no summary at all', () => {
    // An entry saved before summaries were attached renders as a bare id.
    // There is nothing to repair here and no episode to re-read.
    expect(needsEpisodeContextMigration(entry())).toBe(false);
  });
});

describe('repairing an entry by re-reading its episode', () => {
  it('replaces the summary with the one the API produced', async () => {
    // The API is the sole producer of ancestry, so repair is a re-read rather
    // than anything reconstructed on the client.
    const repaired = { id: 'macha:ep-1', kind: 'episode', title: 'Pilot', mediaIds: ['macha:ep-1'], playbackContext: context } as MediaSummary;
    const api = apiReturning(repaired);

    const result = await migrateEpisodeContext(api, entry({ kind: 'episode' }));

    expect(result.media).toBe(repaired);
    expect(result.positionMs).toBe(40_000);
    expect(api.details).toHaveBeenCalledWith('macha:ep-1');
  });

  it('leaves an entry that does not need it alone, without calling the API', async () => {
    // A migration that re-reads every entry would spend a request per row of
    // Continue Watching on every launch, forever.
    const api = apiReturning({ kind: 'episode' });
    const already = entry({ kind: 'episode', playbackContext: context });

    expect(await migrateEpisodeContext(api, already)).toBe(already);
    expect(api.details).not.toHaveBeenCalled();
  });

  it('refuses when the id no longer names an episode', async () => {
    // The catalogue can be rebuilt and ids reused. Writing a film's summary
    // into an entry the UI will render as an episode is worse than failing.
    await expect(migrateEpisodeContext(apiReturning({ kind: 'movie' }), entry({ kind: 'episode' })))
      .rejects.toThrow('no longer an episode');
  });

  it('lets an API failure surface rather than returning the stale entry', async () => {
    // Silently keeping the unmigrated entry would leave a row that never
    // repairs and never explains why.
    const api = { details: vi.fn(async () => { throw new Error('node unreachable'); }) } as unknown as MediaApi;

    await expect(migrateEpisodeContext(api, entry({ kind: 'episode' }))).rejects.toThrow('node unreachable');
  });
});
