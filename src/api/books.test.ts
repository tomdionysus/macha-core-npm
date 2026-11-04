import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBookKind, isPlayableKind, NOT_PLAYABLE_KIND_CODE, orderBooksInSeries } from './books.js';
import { MachaPlaybackResolver } from '../playback/MachaPlaybackResolver.js';
import { ClusterPlaybackResolver } from '../playback/ClusterPlaybackResolver.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import type { MediaSummary, PlaybackCapabilities } from '../types.js';
import { pathForMedia } from '../routing.js';
import { searchCategoryOf } from '../searchCategories.js';

const capabilities: PlaybackCapabilities = {
  platform: 'web', videoCodecs: ['h264'], audioCodecs: ['aac'], containers: ['mp4'], hlsFmp4: true, dash: false, hdr: [],
};

function summary(id: string, kind: MediaSummary['kind'], partial: Partial<MediaSummary> = {}): MediaSummary {
  return { id, kind, title: id, mediaIds: [`macha:${id}`], ...partial };
}

describe('book kinds', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('are read, not played', () => {
    expect(['book', 'author', 'series'].every(isBookKind)).toBe(true);
    expect(isPlayableKind('movie') && isPlayableKind('track') && !isPlayableKind('book')).toBe(true);
  });

  it('are refused by both resolvers before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const book = summary('book:mort', 'book');
    await expect(new MachaPlaybackResolver('http://node').resolve(book, capabilities))
      .rejects.toMatchObject({ status: 422, code: NOT_PLAYABLE_KIND_CODE });
    await expect(new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a']))).resolve(book, capabilities))
      .rejects.toMatchObject({ status: 422, code: NOT_PLAYABLE_KIND_CODE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('route to the books section and search under books', () => {
    expect(pathForMedia(summary('book:mort', 'book'))).toBe('/books/titles/book%3Amort');
    expect(pathForMedia(summary('author:a', 'author'))).toBe('/books/authors/author%3Aa');
    expect(pathForMedia(summary('series:s', 'series'))).toBe('/books/series/series%3As');
    expect(searchCategoryOf('series')).toBe('books');
  });
});

describe('orderBooksInSeries', () => {
  const inSeries = (id: string, index: number | null, title = id) => summary(id, 'book', {
    title, bookContext: { authors: [], series: [{ id: 'series:other', index: 1 }, { id: 'series:s', index }] },
  });

  it('orders by the index in that series, fractions between, unnumbered last, ties by title', () => {
    const ordered = orderBooksInSeries([
      inSeries('none-b', null, 'B'), inSeries('two', 2), inSeries('half', 1.5), inSeries('none-a', null, 'A'), inSeries('one', 1),
    ], 'series:s');
    expect(ordered.map((book) => book.id)).toEqual(['one', 'half', 'two', 'none-a', 'none-b']);
  });

  it('does not reorder its input', () => {
    const input = [inSeries('two', 2), inSeries('one', 1)];
    orderBooksInSeries(input, 'series:s');
    expect(input.map((book) => book.id)).toEqual(['two', 'one']);
  });
});
