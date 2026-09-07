import { describe, expect, it } from 'vitest';
import { canonicalContainers, choosePlaybackInstruction, degradeInstruction } from './choosePlaybackInstruction.js';
import type { MediaTechnicalProfile, PlaybackCapabilities } from '../types.js';

// The Samsung Tizen 3 set, as the TV actually advertises it.
const samsung: PlaybackCapabilities = {
  platform: 'tizen',
  videoCodecs: ['h264', 'hevc', 'vp9'],
  audioCodecs: ['aac', 'opus', 'vorbis', 'ac3', 'eac3', 'mp3'],
  containers: ['mp4', 'webm', 'mp3', 'ogg'],
  hlsFmp4: true,
  dash: false,
  hdr: [],
  videoBitDepth: 10,
};

function profile(format: string, streams: MediaTechnicalProfile['streams']): MediaTechnicalProfile {
  return { mediaId: 'm', format, durationMs: 1_000, bitrate: 1_000, streams };
}

const h264 = { index: 0, type: 'video' as const, codec: 'h264', profile: 'High', language: 'eng', default: true, forced: false };
const aac = { index: 1, type: 'audio' as const, codec: 'aac', profile: 'LC', language: 'eng', default: true, forced: false };
const eac3 = { ...aac, codec: 'eac3', channels: 6 };

describe('choosePlaybackInstruction', () => {
  it('direct-plays a source whose container and streams all check out', () => {
    const decision = choosePlaybackInstruction(profile('mov,mp4,m4a,3gp,3g2,mj2', [h264, aac]), samsung);
    expect(decision).toMatchObject({ mode: 'direct', video: 'copy', audio: 'copy', reasons: ['source-plays-as-is'] });
  });

  it('remuxes rather than transcodes when only the container is wrong', () => {
    // The evening's actual bug: a Matroska file whose streams the TV can play.
    const decision = choosePlaybackInstruction(profile('matroska,webm', [h264, aac]), samsung);
    expect(decision.mode).toBe('remux');
    expect(decision.video).toBe('copy');
    expect(decision.audio).toBe('copy');
    expect(decision.container).toBe('fmp4');
    expect(decision.reasons).toEqual(['container-not-playable']);
  });

  it('copies an advertised surround codec instead of downmixing it to AAC', () => {
    const decision = choosePlaybackInstruction(profile('matroska,webm', [h264, eac3]), samsung);
    expect(decision).toMatchObject({ mode: 'remux', video: 'copy', audio: 'copy' });
  });

  it('transcodes only the track that needs it', () => {
    const dts = { ...aac, codec: 'dts' };
    const decision = choosePlaybackInstruction(profile('matroska,webm', [h264, dts]), samsung);
    // Not `remux`: that mode requires every stream copied, so re-encoding the
    // audio makes it a transcode that copies the video.
    expect(decision).toMatchObject({ mode: 'transcode', video: 'copy', audio: 'transcode' });
    expect(decision.reasons).toContain('audio-codec-not-playable');
  });

  it('transcodes a PQ source for a client that presents no HDR', () => {
    const pq = { ...h264, codec: 'hevc', bitDepth: 10, colorTransfer: 'smpte2084' };
    const decision = choosePlaybackInstruction(profile('matroska,webm', [pq, aac]), samsung);
    expect(decision).toMatchObject({ mode: 'transcode', video: 'transcode', audio: 'copy' });
    expect(decision.reasons).toContain('video-transfer-not-presentable');
  });

  it('does not transcode over facts the server could not probe', () => {
    // Matroska does not report bits_per_raw_sample for HEVC, and the bounded
    // probe may never reach an SPS. Silence must not read as incapacity.
    const unknown = { ...h264, codec: 'hevc' };
    const decision = choosePlaybackInstruction(profile('mov,mp4', [unknown, aac]), samsung);
    expect(decision.mode).toBe('direct');
  });

  it('transcodes when the source is deeper than the client decodes', () => {
    const twelveBit = { ...h264, codec: 'hevc', bitDepth: 12 };
    const decision = choosePlaybackInstruction(profile('mov,mp4', [twelveBit, aac]), samsung);
    expect(decision.reasons).toContain('video-bit-depth-exceeds-client');
    expect(decision.mode).toBe('transcode');
  });

  it('honours an HLS codec subset that is narrower than direct play', () => {
    // This TV direct-plays HEVC and fails to decode it under hls.js.
    const hlsLimited: PlaybackCapabilities = { ...samsung, hlsVideoCodecs: ['h264'] };
    const hevc = { ...h264, codec: 'hevc' };
    const decision = choosePlaybackInstruction(profile('matroska,webm', [hevc, aac]), hlsLimited);
    expect(decision.mode).toBe('transcode');
    expect(decision.reasons).toContain('video-codec-not-deliverable-over-hls');
  });

  it('still direct-plays that same codec when the container allows it', () => {
    const hlsLimited: PlaybackCapabilities = { ...samsung, hlsVideoCodecs: ['h264'] };
    const hevc = { ...h264, codec: 'hevc' };
    expect(choosePlaybackInstruction(profile('mov,mp4', [hevc, aac]), hlsLimited).mode).toBe('direct');
  });

  it('lets a host forbid direct play outright', () => {
    const decision = choosePlaybackInstruction(profile('mov,mp4', [h264, aac]), samsung, {
      overrides: { neverDirect: true },
    });
    expect(decision.mode).toBe('remux');
    expect(decision.reasons).toContain('host-policy-forbids-direct');
  });

  it('lets a host veto a codec the probe wrongly claimed', () => {
    const hevc = { ...h264, codec: 'hevc' };
    const decision = choosePlaybackInstruction(profile('mov,mp4', [hevc, aac]), samsung, {
      overrides: { excludeVideoCodecs: ['hevc'] },
    });
    expect(decision.mode).toBe('transcode');
    expect(decision.reasons).toContain('host-policy-excludes-codec');
  });

  it('lets a host veto a container it renders corrupt', () => {
    const permissive: PlaybackCapabilities = { ...samsung, containers: [...samsung.containers, 'matroska'] };
    const decision = choosePlaybackInstruction(profile('matroska,webm', [h264, aac]), permissive, {
      overrides: { excludeContainers: ['matroska'] },
    });
    expect(decision.mode).toBe('remux');
    expect(decision.reasons).toContain('host-policy-excludes-container');
  });

  it('handles a music track with no video stream', () => {
    const flac = { ...aac, index: 0, codec: 'flac' };
    const decision = choosePlaybackInstruction(profile('flac', [flac]), samsung);
    expect(decision).toMatchObject({ mode: 'transcode', audio: 'transcode' });
  });

  it('picks MPEG-TS when the host cannot take fragmented MP4', () => {
    const tsOnly: PlaybackCapabilities = { ...samsung, hlsFmp4: false, hlsTs: true };
    expect(choosePlaybackInstruction(profile('matroska,webm', [h264, aac]), tsOnly).container).toBe('mpegts');
  });
});

describe('the invariant: direct is never returned on doubt', () => {
  // The server never refuses on capability grounds. A client that instructs
  // `direct` on a file it cannot demux receives the file and shows a black
  // picture — there is no error to catch and no retry to make. So `direct`
  // must only ever come from a positive match on every axis.
  // Must include codecs the set actually lists, or nothing reaches direct
  // and the invariant passes vacuously.
  const codecs = ['h264', 'hevc', 'aac', 'eac3', 'dts', 'av1'];
  const containers = ['mp4', 'matroska,webm', 'webm', 'ogg', 'avi', 'flac', 'unknown-format'];
  const transfers = [undefined, 'bt709', 'smpte2084', 'arib-std-b67'];
  const depths = [undefined, 8, 10, 12];

  it('returns direct only when container, video and audio all positively match', () => {
    let directCount = 0;
    for (const format of containers) {
      for (const vCodec of codecs) {
        for (const aCodec of codecs) {
          for (const colorTransfer of transfers) {
            for (const bitDepth of depths) {
              const decision = choosePlaybackInstruction(
                profile(format, [
                  { index: 0, type: 'video', codec: vCodec, profile: '', language: '', default: true, forced: false, colorTransfer, bitDepth },
                  { index: 1, type: 'audio', codec: aCodec, profile: '', language: '', default: true, forced: false },
                ]),
                samsung,
              );
              if (decision.mode !== 'direct') continue;
              directCount += 1;

              // Every axis must have been positively satisfied.
              expect(samsung.containers.some((c) => format.split(',').includes(c))).toBe(true);
              expect(samsung.videoCodecs).toContain(vCodec);
              expect(samsung.audioCodecs).toContain(aCodec);
              expect(colorTransfer === undefined || colorTransfer === 'bt709').toBe(true);
              expect(bitDepth === undefined || bitDepth <= 10).toBe(true);
              expect(decision.video).toBe('copy');
              expect(decision.audio).toBe('copy');
            }
          }
        }
      }
    }
    // Guard against the assertion passing because nothing ever chose direct.
    expect(directCount).toBeGreaterThan(0);
  });
});

describe('degradeInstruction', () => {
  const remuxCopyBoth = {
    mode: 'remux' as const, video: 'copy' as const, audio: 'copy' as const,
    container: 'fmp4' as const, reasons: ['container-not-playable' as const], assumed: [],
  };

  it('gives up the audio copy first, since re-encoding sound costs least', () => {
    const next = degradeInstruction(remuxCopyBoth);
    // And promotes the mode, because a remux with a re-encode is not a remux.
    expect(next).toMatchObject({ mode: 'transcode', video: 'copy', audio: 'transcode' });
    expect(next?.reasons).toContain('executor-refused-copy');
  });

  it('gives up the video copy only when the audio copy is already gone', () => {
    const next = degradeInstruction({ ...remuxCopyBoth, audio: 'transcode' });
    expect(next).toMatchObject({ mode: 'transcode', video: 'transcode', audio: 'transcode' });
  });

  it('converges: repeated degradation terminates rather than looping', () => {
    let current = degradeInstruction(remuxCopyBoth);
    let steps = 0;
    while (current && steps < 10) {
      const next = degradeInstruction(current);
      if (!next) break;
      current = next;
      steps += 1;
    }
    expect(steps).toBeLessThan(3);
    expect(degradeInstruction({ ...remuxCopyBoth, video: 'transcode', audio: 'transcode' })).toBeUndefined();
  });

  it('never becomes more ambitious than the instruction that was refused', () => {
    const next = degradeInstruction(remuxCopyBoth);
    expect(next?.video === 'copy' || remuxCopyBoth.video === 'copy').toBe(true);
    expect(next?.audio).not.toBe('copy');
  });
});

describe('executor operations as an input', () => {
  const canDoEverything = {
    direct: true, copyIntoFmp4: { video: true, audio: true },
    copyIntoMpegts: { video: true, audio: true },
    transcodeVideo: true, transcodeAudio: true,
  };

  // These fixtures all package into fMP4, so the MPEG-TS answers are set to
  // the opposite of the fMP4 ones: if the chooser ever consults the wrong
  // carriage, the assertion changes rather than staying accidentally true.
  const noMpegtsCopy = { video: false, audio: false };

  it('does not instruct a copy the node cannot perform', () => {
    // The evening's actual failure: the chooser asked for an E-AC-3 copy that
    // the deployed build could not do, and the viewer got nothing at all.
    const decision = choosePlaybackInstruction(
      profile('matroska', [h264, eac3]), samsung,
      { operations: { ...canDoEverything, copyIntoFmp4: { video: true, audio: false }, copyIntoMpegts: noMpegtsCopy } },
    );
    expect(decision).toMatchObject({ mode: 'transcode', video: 'copy', audio: 'transcode' });
    expect(decision.reasons).toContain('executor-cannot-copy-audio');
  });

  it('does not instruct direct when the node says it cannot', () => {
    const decision = choosePlaybackInstruction(
      profile('mov,mp4', [h264, aac]), samsung,
      { operations: { ...canDoEverything, direct: false } },
    );
    expect(decision.mode).not.toBe('direct');
    expect(decision.reasons).toContain('executor-cannot-direct');
  });

  it('treats an absent operation as cannot, never as can', () => {
    // An unknown answer must not be optimistic: the point of the gate is to
    // stop asking for what will be refused.
    const decision = choosePlaybackInstruction(
      profile('matroska', [h264, eac3]), samsung,
      { operations: { direct: false, copyIntoFmp4: { video: false, audio: false }, copyIntoMpegts: noMpegtsCopy, transcodeVideo: true, transcodeAudio: true } },
    );
    expect(decision.video).toBe('transcode');
    expect(decision.audio).toBe('transcode');
  });

  it('flips an audio-only source off direct when the node refuses both paths', () => {
    // Verified in the field against a live node by the React Native client,
    // then reproduced here: an MP3 the host can play whole, on a node that
    // says it can neither serve it directly nor copy the audio into fMP4.
    const mp3 = { index: 0, type: 'audio' as const, codec: 'mp3', profile: '', language: '', default: true, forced: false };
    const decision = choosePlaybackInstruction(
      profile('mp3', [mp3]), samsung,
      { operations: { direct: false, copyIntoFmp4: { video: true, audio: false }, copyIntoMpegts: noMpegtsCopy, transcodeVideo: true, transcodeAudio: true } },
    );

    expect(decision).toMatchObject({ mode: 'transcode', audio: 'transcode', container: 'fmp4' });
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'executor-cannot-direct',
      'executor-cannot-copy-audio',
    ]));
  });

  it('leaves that same source on direct when the node is willing', () => {
    const mp3 = { index: 0, type: 'audio' as const, codec: 'mp3', profile: '', language: '', default: true, forced: false };
    const decision = choosePlaybackInstruction(profile('mp3', [mp3]), samsung, { operations: canDoEverything });
    expect(decision.mode).toBe('direct');
  });

  it('behaves exactly as before when operations are not supplied', () => {
    const withOps = choosePlaybackInstruction(profile('matroska', [h264, eac3]), samsung, { operations: canDoEverything });
    const without = choosePlaybackInstruction(profile('matroska', [h264, eac3]), samsung);
    // Identical but for the assumption note, which is the point of the note.
    expect({ ...without, assumed: [] }).toEqual({ ...withOps, assumed: [] });
  });
});

describe('reporting what had to be assumed', () => {
  it('names every optional input no host supplied', () => {
    const decision = choosePlaybackInstruction(profile('mov,mp4', [h264, aac]), samsung);
    // The Samsung fixture states videoBitDepth and nothing else.
    expect(decision.assumed).toEqual(
      expect.arrayContaining(['operations', 'hlsVideoCodecs', 'hlsAudioCodecs', 'hlsTs']),
    );
    expect(decision.assumed).not.toContain('videoBitDepth');
  });

  it('is empty when the host stated everything', () => {
    const complete = {
      ...samsung,
      hlsVideoCodecs: ['h264' as const], hlsAudioCodecs: ['aac' as const], hlsTs: false,
    };
    const decision = choosePlaybackInstruction(profile('mov,mp4', [h264, aac]), complete, {
      operations: { direct: true, copyIntoFmp4: { video: true, audio: true }, copyIntoMpegts: { video: true, audio: true }, transcodeVideo: true, transcodeAudio: true },
    });
    expect(decision.assumed).toEqual([]);
  });

  it('distinguishes a stated false from an absent field', () => {
    // `hlsTs: false` is an answer; omitting it is not, and the instruction
    // is identical either way — which is exactly why it needs reporting.
    const stated = choosePlaybackInstruction(profile('matroska', [h264, aac]), { ...samsung, hlsTs: false });
    const absent = choosePlaybackInstruction(profile('matroska', [h264, aac]), samsung);
    expect(stated.container).toEqual(absent.container);
    expect(stated.assumed).not.toContain('hlsTs');
    expect(absent.assumed).toContain('hlsTs');
  });
});


describe('mode legality', () => {
  // `remux` means the container changed and every stream was copied. The
  // server refuses any other reading by contract, not by capability — so an
  // illegal instruction fails on every node, however healthy. Asserted over
  // the space rather than over the two paths that happen to reach it today.
  it('never pairs remux with a re-encoded stream', () => {
    const codecs = ['h264', 'hevc', 'aac', 'eac3', 'dts', 'av1'];
    const containers = ['mp4', 'matroska,webm', 'webm', 'ogg', 'flac', 'unknown-format'];
    const operationSets = [
      undefined,
      { direct: true, copyIntoFmp4: { video: true, audio: true }, copyIntoMpegts: { video: true, audio: true }, transcodeVideo: true, transcodeAudio: true },
      { direct: false, copyIntoFmp4: { video: true, audio: false }, copyIntoMpegts: { video: false, audio: false }, transcodeVideo: true, transcodeAudio: true },
      { direct: false, copyIntoFmp4: { video: false, audio: false }, copyIntoMpegts: { video: true, audio: true }, transcodeVideo: true, transcodeAudio: true },
    ];
    let remuxes = 0;
    for (const format of containers) {
      for (const vCodec of codecs) {
        for (const aCodec of codecs) {
          for (const operations of operationSets) {
            const decision = choosePlaybackInstruction(
              profile(format, [
                { index: 0, type: 'video', codec: vCodec, profile: '', language: '', default: true, forced: false },
                { index: 1, type: 'audio', codec: aCodec, profile: '', language: '', default: true, forced: false },
              ]),
              samsung,
              { operations },
            );
            if (decision.mode !== 'remux') continue;
            remuxes += 1;
            expect(decision.video).toBe('copy');
            expect(decision.audio).toBe('copy');

            // Degrading must not violate it either.
            const degraded = degradeInstruction(decision);
            if (degraded?.mode === 'remux') {
              expect(degraded.video).toBe('copy');
              expect(degraded.audio).toBe('copy');
            }
          }
        }
      }
    }
    expect(remuxes).toBeGreaterThan(0);
  });
});

describe('container families', () => {
  it('does not let an mp3 claim cover an MPEG program stream', () => {
    // libav's names look adjacent and are not. The server reports `mpeg` for
    // a .mpg, and a host that plays mp3 has said nothing about video.
    const audioOnly = {
      ...samsung, containers: ['mp3'], videoCodecs: ['h264' as const],
    };
    const decision = choosePlaybackInstruction(profile('mpeg', [h264, aac]), audioOnly);
    expect(decision.mode).not.toBe('direct');
    expect(decision.reasons).toContain('container-not-playable');
  });

  it('keeps the segment container fmp4 out of the mp4 source family', () => {
    // Deliberate, and worth pinning: fragmented MP4 *is* an MP4, so grouping
    // them is the natural reading. Keeping them apart is what made an .mp4
    // remuxed into fMP4 read as a container change — on the 58 .mp4 files in
    // the library, the carriage everyone actually uses. `mpegts` is the
    // opposite case, legitimately both a source and a segment container,
    // which is why the badge cannot rest on this distinction alone.
    expect(canonicalContainers('fmp4')).toBeUndefined();
    expect(canonicalContainers('mp4')).toContain('mp4');
  });

  it('maps every container the server can emit to a family of its own', () => {
    // The server's source vocabulary, written down here so the two lists can
    // be compared rather than assumed to agree. Three of tonight's bugs were
    // found exactly this way — by holding two written copies of the same fact
    // side by side — and none was reachable from either side alone.
    const serverVocabulary = [
      'matroska', 'webm', 'mp4', 'avi', 'asf', 'mpeg', 'mpegts',
      'mp3', 'flac', 'ogg', 'adts', 'wav', 'aiff',
    ];

    const families = serverVocabulary.map((name) => canonicalContainers(name));
    // Every token is known: an unrecognised one falls through to "not
    // playable", which is safe but silently costs a viewer direct play.
    expect(serverVocabulary.filter((_, i) => families[i] === undefined)).toEqual([]);
    // And no two share a family. `mpeg` with `mp3` was that bug; `mpeg` with
    // `mpegts` would have been the same bug with a worse failure.
    expect(new Set(families.map((family) => family?.join('/'))).size).toBe(serverVocabulary.length);
  });

  it('still plays an mp3 on a host that claims mp3', () => {
    const mp3 = { index: 0, type: 'audio' as const, codec: 'mp3', profile: '', language: '', default: true, forced: false };
    const decision = choosePlaybackInstruction(profile('mp3', [mp3]), { ...samsung, containers: ['mp3'] });
    expect(decision.mode).toBe('direct');
  });
});

describe('preferSegmentContainer', () => {
  const bothContainers = { ...samsung, hlsFmp4: true, hlsTs: true };

  it('asks for MPEG-TS when the host prefers it and supports it', () => {
    // The Samsung case: it carries neither HEVC nor any audio correctly in
    // fMP4 on any delivery path, and copies both untouched in TS.
    const decision = choosePlaybackInstruction(profile('matroska', [h264, eac3]), bothContainers, {
      overrides: { preferSegmentContainer: 'mpegts' },
    });
    expect(decision.container).toBe('mpegts');
    expect(decision.reasons).toContain('host-policy-prefers-container');
  });

  it('still defaults to fragmented MP4 when nothing is preferred', () => {
    const decision = choosePlaybackInstruction(profile('matroska', [h264, eac3]), bothContainers);
    expect(decision.container).toBe('fmp4');
    expect(decision.reasons).not.toContain('host-policy-prefers-container');
  });

  it('ignores a preference the host never said it supports', () => {
    // Preferring what you cannot play is a configuration error, not an
    // instruction: fall back rather than emit something unusable.
    const decision = choosePlaybackInstruction(profile('matroska', [h264, eac3]), samsung, {
      overrides: { preferSegmentContainer: 'mpegts' },
    });
    expect(decision.container).toBe('fmp4');
    expect(decision.reasons).not.toContain('host-policy-prefers-container');
  });

  it('does not claim a preference when there was no choice to make', () => {
    // TS is the only container this host takes, so asking for it is not a
    // preference being honoured — saying so would be noise in the panel.
    const tsOnly = { ...samsung, hlsFmp4: false, hlsTs: true };
    const decision = choosePlaybackInstruction(profile('matroska', [h264, eac3]), tsOnly, {
      overrides: { preferSegmentContainer: 'mpegts' },
    });
    expect(decision.container).toBe('mpegts');
    expect(decision.reasons).not.toContain('host-policy-prefers-container');
  });

  it('leaves direct play alone, which has no segments at all', () => {
    const decision = choosePlaybackInstruction(profile('mov,mp4', [h264, aac]), bothContainers, {
      overrides: { preferSegmentContainer: 'mpegts' },
    });
    expect(decision.mode).toBe('direct');
    expect(decision.container).toBeUndefined();
  });

  it('asks the node about the carriage it actually chose', () => {
    // The two carriages take different codecs, so `copyIntoFmp4` is simply
    // the wrong question once the instruction says MPEG-TS. Here the node
    // cannot copy either stream into fMP4 and can copy both into TS.
    const decision = choosePlaybackInstruction(profile('matroska', [h264, eac3]), bothContainers, {
      overrides: { preferSegmentContainer: 'mpegts' },
      operations: {
        direct: false,
        copyIntoFmp4: { video: false, audio: false },
        copyIntoMpegts: { video: true, audio: true },
        transcodeVideo: true, transcodeAudio: true,
      },
    });
    expect(decision).toMatchObject({ mode: 'remux', video: 'copy', audio: 'copy', container: 'mpegts' });
  });

  it('transcodes into the preferred carriage rather than copying into the broken one', () => {
    // The preference exists because fMP4 is broken on this device, so
    // retreating to a copy the device cannot decode would trade a picture the
    // viewer can watch for one they cannot. The node's answer decides copy
    // versus transcode inside the chosen container; it does not choose the
    // container.
    const decision = choosePlaybackInstruction(profile('matroska', [h264, eac3]), bothContainers, {
      overrides: { preferSegmentContainer: 'mpegts' },
      operations: {
        direct: false,
        copyIntoFmp4: { video: true, audio: true },
        copyIntoMpegts: { video: true, audio: false },
        transcodeVideo: true, transcodeAudio: true,
      },
    });
    expect(decision).toMatchObject({ mode: 'transcode', video: 'copy', audio: 'transcode', container: 'mpegts' });
    expect(decision.reasons).toContain('executor-cannot-copy-audio');
  });
});
