import { describe, expect, it } from 'vitest';
import { episodeLabel } from './episodeLabel.js';
import type { MediaSummary } from './types.js';

function episode(partial: Partial<MediaSummary>): MediaSummary {
  return { id: 'e', kind: 'episode', title: 'E', mediaIds: [], ...partial };
}

describe('episodeLabel', () => {
  it('names season and episode in full and unpadded', () => {
    expect(episodeLabel(episode({ seasonNumber: 1, episodeNumber: 4 }))).toBe('Season 1 Episode 4');
    expect(episodeLabel(episode({ seasonNumber: 12, episodeNumber: 104 }))).toBe('Season 12 Episode 104');
  });

  it('takes the season from its context when the episode itself does not carry it', () => {
    const withContext = episode({
      episodeNumber: 4,
      playbackContext: { series: { id: 's', title: 'S' }, season: { id: 'x', title: 'Season 2', seasonNumber: 2 } },
    });
    expect(episodeLabel(withContext)).toBe('Season 2 Episode 4');
  });

  it('says "Episode 4" with no season known, and nothing for a non-episode or no number', () => {
    expect(episodeLabel(episode({ episodeNumber: 4 }))).toBe('Episode 4');
    expect(episodeLabel(episode({ seasonNumber: 1 }))).toBeUndefined();
    expect(episodeLabel({ id: 'm', kind: 'movie', title: 'M', mediaIds: [], episodeNumber: 4 })).toBeUndefined();
  });

  it('keeps specials as season 0', () => {
    expect(episodeLabel(episode({ seasonNumber: 0, episodeNumber: 1 }))).toBe('Season 0 Episode 1');
  });
});
