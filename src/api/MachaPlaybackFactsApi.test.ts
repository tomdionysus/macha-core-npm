import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaPlaybackFactsApi } from './MachaPlaybackFactsApi.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function respond(body: unknown, status = 200) {
  const fetchMock = vi.fn(() => Promise.resolve(json(body, status)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const entry = {
  media_id: 'macha:abc', container: 'matroska', format: 'matroska,webm',
  duration_ms: 1_000, bitrate: 1_000, size: 10,
  streams: [{ index: 0, type: 'video', codec: 'hevc' }],
};

describe('MachaPlaybackFactsApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports copy support separately for each carriage', async () => {
    // The lists genuinely differ (MPEG-TS takes MPEG-2 video and MP3 that
    // fragmented MP4 refuses, fMP4 takes AV1 and Opus that TS refuses), so
    // one answer cannot stand for both.
    respond({
      item_id: 'movie:1',
      media: [{
        ...entry,
        operations: {
          direct: true,
          copy_into_fmp4: { video: false, audio: false },
          copy_into_mpegts: { video: true, audio: true },
          transcode_video: true, transcode_audio: true,
        },
      }],
    });

    const [facts] = await new MachaPlaybackFactsApi('http://node.test').facts({ itemId: 'movie:1' });

    expect(facts?.operations.copyIntoFmp4).toEqual({ video: false, audio: false });
    expect(facts?.operations.copyIntoMpegts).toEqual({ video: true, audio: true });
  });

  it('reads an unreported carriage as cannot, never as can', async () => {
    // A node predating `copy_into_mpegts` says nothing about it. Optimism
    // here produces an instruction the node will refuse, which is the whole
    // failure this gate exists to prevent.
    respond({
      item_id: 'movie:1',
      media: [{ ...entry, operations: { direct: true, copy_into_fmp4: { video: true, audio: true } } }],
    });

    const [facts] = await new MachaPlaybackFactsApi('http://node.test').facts({ itemId: 'movie:1' });

    expect(facts?.operations.copyIntoMpegts).toEqual({ video: false, audio: false });
  });

  it('treats a container the server could not name as absent', async () => {
    // Six .avi files answer `container: ""` with `format: "avi"`. An empty
    // string is not a container, and letting it through gives consumers two
    // shapes of "no answer" to test for.
    respond({ item_id: 'movie:1', media: [{ ...entry, container: '', format: 'avi' }] });

    const [facts] = await new MachaPlaybackFactsApi('http://node.test').facts({ itemId: 'movie:1' });

    expect(facts?.profile.container).toBeUndefined();
    expect(facts?.profile.format).toBe('avi');
  });

  it('refuses to ask without an identifier rather than fetching a whole library', async () => {
    const fetchMock = respond({ item_id: 'movie:1', media: [] });

    await expect(new MachaPlaybackFactsApi('http://node.test').facts({}))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MachaPlaybackFactsApi against server 0.58.0', () => {
  afterEach(() => vi.unstubAllGlobals());

  const streams = [
    { index: 0, type: 'video', codec: 'hevc', default: true, copy_into: { fmp4: true, mpegts: true } },
    { index: 1, type: 'audio', codec: 'opus', copy_into: { fmp4: true, mpegts: false } },
    { index: 2, type: 'audio', codec: 'mp3', default: true, copy_into: { fmp4: false, mpegts: true } },
  ];

  it("reads each stream's own copy support", async () => {
    respond({ media: [{ ...entry, streams, operations: { direct: true, transcode_video: true, transcode_audio: true } }] });
    const [facts] = await new MachaPlaybackFactsApi('http://node.test').facts({ mediaId: 'macha:abc' });
    expect(facts?.profile.streams.map((stream) => stream.copyInto)).toEqual([
      { fmp4: true, mpegts: true }, { fmp4: true, mpegts: false }, { fmp4: false, mpegts: true },
    ]);
  });

  it('answers the operations pair for the default streams when the node no longer sends it', async () => {
    // The pair meant the default streams on an older node; the default audio
    // here is the MP3, not the first-listed Opus.
    respond({ media: [{ ...entry, streams, operations: { direct: true } }] });
    const [facts] = await new MachaPlaybackFactsApi('http://node.test').facts({ mediaId: 'macha:abc' });
    expect(facts?.operations.copyIntoFmp4).toEqual({ video: true, audio: false });
    expect(facts?.operations.copyIntoMpegts).toEqual({ video: true, audio: true });
  });

  it("leaves a stream's copy support absent from an older node", async () => {
    respond({ media: [{ ...entry, operations: { direct: true, copy_into_fmp4: { video: true, audio: true } } }] });
    const [facts] = await new MachaPlaybackFactsApi('http://node.test').facts({ mediaId: 'macha:abc' });
    expect(facts?.profile.streams[0]).not.toHaveProperty('copyInto');
    expect(facts?.operations.copyIntoFmp4).toEqual({ video: true, audio: true });
  });
});

describe('MachaPlaybackFactsApi availability (server 0.82.0)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("carries each file's availability (server 0.82.0), and none from an older server", async () => {
    respond({
      item_id: 'movie:1',
      media: [
        { ...entry, availability: 'unavailable', extents: 12, extents_local: 0, extents_unavailable: 12, extents_unknown: 0, surveyed_generation: 9, surveyed_unix_ms: 5 },
        { ...entry, media_id: 'macha:def' },
      ],
    });

    const [held, older] = await new MachaPlaybackFactsApi('http://node.test').facts({ itemId: 'movie:1' });

    expect(held.availability).toEqual({
      availability: 'unavailable', extents: 12, extentsLocal: 0, extentsUnavailable: 12, extentsUnknown: 0, surveyedGeneration: 9, surveyedUnixMs: 5,
    });
    expect(older).not.toHaveProperty('availability');
  });
});
