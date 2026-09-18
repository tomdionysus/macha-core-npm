import { describe, expect, it, vi } from 'vitest';
import type { PlaybackSession } from './PlaybackResolver.js';
import { generationLocalPosition, terminalRecoveryError } from './PlaybackCoordinator.js';
import { PlaybackSourceError } from '../platform/Platform.js';
import { MachaPlaybackResolver } from './MachaPlaybackResolver.js';
import { clearClientDiagnostics, clientDiagnosticsSnapshot } from '../diagnostics/ClientLog.js';

/** Invariant reports recorded since the last reset, by event name. */
function seekInvariantReports(): unknown[] {
  return clientDiagnosticsSnapshot().filter((entry) => entry.event === 'seek-invariant-violated');
}

/**
 * A remux generation as 0.46.0 reports one: the media begins at the last
 * keyframe at or before the request, and the remainder is the offset.
 */
function wireSession(seek: { seekMs: number; offsetMs?: number; requestedMs?: number }) {
  return {
    session_id: 'session-a',
    media_id: 'macha:media',
    mode: 'remux',
    duration_ms: 2_464_462,
    seek_ms: seek.seekMs,
    ...(seek.offsetMs === undefined ? {} : { seek_offset_ms: seek.offsetMs }),
    ...(seek.requestedMs === undefined ? {} : { seek_requested_ms: seek.requestedMs }),
    preferences: {
      mode: 'remux', max_height: null, max_bitrate: null, audio_stream: null,
      subtitle_stream: null, audio_language: '', subtitle_language: '',
    },
    selection: { video_stream: 0, audio_stream: 1, subtitle_stream: -1 },
    source: { path: '/movie.mkv', format: 'matroska', size: 1000, bitrate: 100, streams: [] },
    output: {},
    stream: { url: '/api/v1/playback/stream/session-a', mime_type: 'application/vnd.apple.mpegurl', subtitle_url: null },
    options: {
      modes: ['remux'], quality_heights: [], media_ids: ['macha:media'], audio_streams: [],
      subtitle_streams: [], can_seek: true, can_change_quality: false, can_switch_media: false,
    },
  };
}

async function resolveWith(wire: unknown): Promise<PlaybackSession> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(wire), {
    status: 201, headers: { 'Content-Type': 'application/json' },
  })));
  const resolver = new MachaPlaybackResolver('http://node');
  return resolver.resolve(
    { id: 'movie:test', kind: 'movie', title: 'Test', mediaIds: ['macha:media'] },
    { platform: 'web', videoCodecs: ['h264'], audioCodecs: ['aac'], containers: ['mp4'], hlsFmp4: true, dash: false, hdr: [] },
    733_680,
    { mode: 'remux' },
  );
}

function session(over: Partial<PlaybackSession>): PlaybackSession {
  return {
    sessionId: 'session-a', mediaId: 'macha:media', mode: 'remux', mimeType: 'application/vnd.apple.mpegurl',
    durationMs: 2_464_462, seekMs: 0,
    source: { mediaId: 'macha:media', url: 'http://node/s.m3u8', isManifest: true, mode: 'remux' },
    preferences: {
      mode: 'remux', maxHeight: null, maxBitrate: null, audioStream: null,
      subtitleStream: null, audioLanguage: '', subtitleLanguage: '',
    },
    sourceInfo: { path: '/m.mkv', format: 'matroska', size: 1, bitrate: 1, streams: [] },
    output: {}, selected: { videoStream: 0, audioStream: 1, subtitleStream: -1 },
    transform: { video: 'copy', audio: 'copy' },
    options: {
      modes: ['remux'], qualityHeights: [], mediaIds: [], audioStreams: [], subtitleStreams: [],
      canSeek: true, canChangeQuality: false, canSwitchMedia: false,
    },
    ...over,
  };
}

describe('the seek contract is read rather than re-derived', () => {
  it('carries the offset and the honoured position onto the session', async () => {
    // The live figures: a 2464.462 s title, generation origin 715.56 s, the
    // viewer's request 733.68 s, the remainder 18.12 s.
    const mapped = await resolveWith(wireSession({ seekMs: 715_560, offsetMs: 18_120, requestedMs: 733_680 }));
    expect(mapped.seekMs).toBe(715_560);
    expect(mapped.seekOffsetMs).toBe(18_120);
    expect(mapped.seekRequestedMs).toBe(733_680);
  });

  it('attaches at the offset, because that is what the derivation comes to', async () => {
    // `seekOffsetMs === seekRequestedMs - seekMs` is the invariant rearranged,
    // so the local position of the requested position *is* the offset. This
    // pins that equality rather than trusting it.
    const mapped = await resolveWith(wireSession({ seekMs: 715_560, offsetMs: 18_120, requestedMs: 733_680 }));
    expect(generationLocalPosition(mapped, mapped.seekRequestedMs!)).toBe(mapped.seekOffsetMs);
  });

  it('stays silent on a node too old to state the invariant', async () => {
    clearClientDiagnostics();
    await resolveWith(wireSession({ seekMs: 715_560 }));
    expect(seekInvariantReports()).toHaveLength(0);
  });

  it('reports a violated invariant without refusing the generation', async () => {
    clearClientDiagnostics();
    // 715_560 + 18_120 is 733_680, not 740_000.
    const mapped = await resolveWith(wireSession({ seekMs: 715_560, offsetMs: 18_120, requestedMs: 740_000 }));
    expect(seekInvariantReports()).toHaveLength(1);
    // Reported, not acted on: the session is still returned and usable, because
    // asking the same node again is the least likely way to get a better
    // answer and that path livelocked once already.
    expect(mapped.sessionId).toBe('session-a');
  });

  it('does not mistake an end-of-title clamp for a violation', async () => {
    clearClientDiagnostics();
    // The viewer asked past the end; the server honoured `duration - 1ms` and
    // the sum still balances against the *honoured* position. A clamp shows up
    // as the honoured value differing from the ask, never as a broken sum.
    await resolveWith(wireSession({ seekMs: 2_460_000, offsetMs: 4_461, requestedMs: 2_464_461 }));
    expect(seekInvariantReports()).toHaveLength(0);
  });
});

describe('a generation that begins after the viewer', () => {
  it('renegotiates against a node that states the offset', () => {
    // 0.46.0 snaps backwards, so the generation always contains the request.
    // Landing here means the viewer moved back while it was negotiated — a
    // seek they made — and the next answer will contain it.
    const ahead = session({ seekMs: 900_000, seekOffsetMs: 0, seekRequestedMs: 900_000 });
    expect(generationLocalPosition(ahead, 500_000)).toBeUndefined();
  });

  it('is reachable at all only when the viewer is behind the origin', () => {
    const generation = session({ seekMs: 715_560, seekOffsetMs: 18_120, seekRequestedMs: 733_680 });
    expect(generationLocalPosition(generation, 733_680)).toBe(18_120);
    expect(generationLocalPosition(generation, 715_560)).toBe(0);
    expect(generationLocalPosition(generation, 715_559)).toBeUndefined();
  });

  it('maps direct play on the title timeline, with no generation origin', () => {
    const direct = session({ mode: 'direct', seekMs: 715_560 });
    expect(generationLocalPosition(direct, 500_000)).toBe(500_000);
  });
});

describe('core supplies the whole failure chain and presents none of it', () => {
  it('keeps the ending failure even when the originating one already has a cause', async () => {
    // The defect this replaced: attaching only onto an empty `cause` meant a
    // `PlaybackSourceError` constructed with one silently discarded the
    // failure that actually ended playback. Core deciding a host does not need
    // something core is holding is the judgement that does not belong here.
    const underlying = new Error('socket closed');
    const originating = new PlaybackSourceError('node lost the source', 'not-found', underlying);
    const ending = new Error('every candidate refused');

    const reported = terminalRecoveryError(originating, ending);

    expect(reported).toBe(originating);
    expect((reported as PlaybackSourceError).kind).toBe('not-found');
    expect(reported.cause).toBe(underlying);
    expect((underlying as Error).cause).toBe(ending);
  });

  it('leads with what started the recovery, not what ended it', () => {
    // Leading with the ending names a node the session was never on — the
    // 2026-09-17 failure that sent a day of diagnosis to fi-1.
    const originating = new Error('es-1 lost the source');
    const reported = terminalRecoveryError(originating, new Error('fi-1 refused'));
    expect(reported.message).toBe('es-1 lost the source');
    expect((reported.cause as Error).message).toBe('fi-1 refused');
  });

  it('does not hang on a chain something upstream made cyclic', () => {
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(terminalRecoveryError(a, new Error('ending'))).toBe(a);
  });

  it('ignores an ending that is already somewhere in the chain', () => {
    const ending = new Error('ending');
    const originating = new Error('originating');
    originating.cause = ending;
    terminalRecoveryError(originating, ending);
    expect((ending as Error).cause).toBeUndefined();
  });
});
