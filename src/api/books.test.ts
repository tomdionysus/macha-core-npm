import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitConversion, isBookKind, isConversionFormat, isConvertibleContentType, isConvertibleSource, isPlayableKind, NOT_PLAYABLE_KIND_CODE, orderBooksInSeries } from './books.js';
import type { CatalogueConversion } from './CatalogueApi.js';
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

describe('awaitConversion', () => {
  afterEach(() => vi.useRealTimers());

  const state = (status: CatalogueConversion['status'], extra: Partial<CatalogueConversion> = {}): CatalogueConversion => ({
    mediaId: 'macha:book', format: 'epub', status, size: null, mimeType: null, errorCode: null, ...extra,
  });

  it('polls at the wait the server asks, on the node that started it, to the end', async () => {
    vi.useFakeTimers();
    const answers = [state('converting', { retryAfterMs: 5_000 }), state('ready', { size: 10 })];
    const conversion = vi.fn(async () => answers.shift()!);
    const seen: string[] = [];

    const done = awaitConversion({ conversion }, state('converting', { endpointId: 'http://b', retryAfterMs: 2_000 }), {
      onState: (current) => seen.push(current.status),
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(conversion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(conversion).toHaveBeenCalledTimes(1);
    expect(conversion.mock.calls[0]).toEqual([expect.objectContaining({ endpointId: 'http://b' }), undefined]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await done).toMatchObject({ status: 'ready', endpointId: 'http://b' });
    expect(seen).toEqual(['converting', 'converting', 'ready']);
  });

  it('resolves a failed conversion rather than throwing', async () => {
    const conversion = vi.fn();
    await expect(awaitConversion({ conversion }, state('failed', { errorCode: 'conversion_timed_out' })))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'conversion_timed_out' });
    expect(conversion).not.toHaveBeenCalled();
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const done = awaitConversion({ conversion: vi.fn() }, state('converting'), { signal: controller.signal });
    controller.abort(new Error('gone'));
    await expect(done).rejects.toThrow('gone');
  });

  it('knows the one format, EPUB', () => {
    expect(isConversionFormat('epub')).toBe(true);
    expect(isConversionFormat('azw3')).toBe(false);
  });

  it('knows which files convert by the type they are served with', () => {
    expect(isConvertibleContentType('application/x-mobipocket-ebook')).toBe(true);
    expect(isConvertibleContentType('Application/Vnd.Amazon.Ebook; charset=binary')).toBe(true);
    for (const type of ['application/epub+zip', 'application/pdf', 'application/x-fictionbook+xml', 'application/vnd.comicbook+zip', 'application/octet-stream', '']) {
      expect(isConvertibleContentType(type)).toBe(false);
    }
  });

  it('knows which files convert: the MOBI family, by name, path or extension', () => {
    for (const name of ['Mort.mobi', '/Books/Mort.AZW3', 'mort.azw', 'prc', ' Mort.Prc ']) expect(isConvertibleSource(name)).toBe(true);
    for (const name of ['Mort.epub', 'Mort.pdf', 'Mort.fb2', 'Comic.cbz', '/Books.mobi/Mort', '', 'mobi.txt']) expect(isConvertibleSource(name)).toBe(false);
  });
});
