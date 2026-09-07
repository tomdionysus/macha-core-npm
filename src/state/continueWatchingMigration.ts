import type { MediaApi } from '../api/MediaApi.js';
import type { PlaybackProgress } from '../types.js';

/** Entries persisted before episodes carried their series/season ancestry. */
export function needsEpisodeContextMigration(entry: PlaybackProgress): boolean {
  return entry.media?.kind === 'episode' && !entry.media.playbackContext;
}

/** The API is the sole producer of ancestry, so repairing an entry is just re-reading its episode. */
export async function migrateEpisodeContext(
  api: MediaApi,
  entry: PlaybackProgress,
): Promise<PlaybackProgress> {
  if (!needsEpisodeContextMigration(entry)) return entry;
  const media = await api.details(entry.mediaId);
  if (media.kind !== 'episode') {
    throw new Error(`Legacy Continue Watching entry ${entry.mediaId} is no longer an episode.`);
  }
  return { ...entry, media };
}
