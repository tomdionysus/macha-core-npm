import type { MediaTechnicalProfile, MediaTechnicalStream, PlaybackCapabilities, PlaybackMode } from '../types.js';
import type { PlaybackOperations } from '../api/PlaybackFactsApi.js';

export type StreamInstruction = 'copy' | 'transcode';
export type SegmentContainer = 'fmp4' | 'mpegts';

/**
 * Why the chooser decided what it did.
 *
 * Returned rather than inferred because "why is this transcoding?" is a
 * question the operator asks, and the answer must come from the code that
 * decided rather than from reconstructing it afterwards.
 */
export type PlaybackDecisionReason =
  | 'source-plays-as-is'
  | 'container-not-playable'
  | 'video-codec-not-playable'
  | 'video-codec-not-deliverable-over-hls'
  | 'video-bit-depth-exceeds-client'
  | 'video-transfer-not-presentable'
  | 'video-dolby-vision-not-supported'
  | 'audio-codec-not-playable'
  | 'audio-codec-not-deliverable-over-hls'
  | 'host-policy-forbids-direct'
  | 'host-policy-excludes-container'
  | 'host-policy-excludes-codec'
  | 'host-policy-prefers-container'
  | 'no-technical-facts'
  | 'executor-refused-copy'
  | 'executor-cannot-direct'
  | 'executor-cannot-copy-video'
  | 'executor-cannot-copy-audio';

/**
 * Platform truths that no probe can discover.
 *
 * Some devices lie. Samsung Tizen 3 reports HEVC supported through
 * `MediaSource.isTypeSupported` and then fails to decode it, and no
 * capability probe catches that. A host must be able to state such a fact
 * without forking the chooser, so these are first-class rather than a
 * special case someone adds later.
 */
export interface PlaybackPolicyOverrides {
  /** Never instruct direct play here, whatever the facts say. */
  neverDirect?: boolean;
  /** Containers never safe to direct-play here, even when advertised. */
  excludeContainers?: string[];
  /** Video codecs to treat as undecodable regardless of what the probe claimed. */
  excludeVideoCodecs?: string[];
  excludeAudioCodecs?: string[];
  /**
   * Which HLS segment container to ask for when the host supports both.
   *
   * Without this, fragmented MP4 wins whenever it is available, which is a
   * preference hardcoded as an ordering — the rule living in the chooser
   * rather than with the party that knows it. A host may have good reason to
   * want MPEG-TS: a 2017 Samsung carries neither HEVC video nor any audio
   * correctly in fMP4 on any delivery path, while copying both untouched in
   * TS. Stating that here rather than by denying `hlsFmp4` matters, because
   * the set genuinely can do fMP4 — denying it would falsify a capability to
   * achieve a policy.
   *
   * Ignored when the host has not said it supports the container it prefers;
   * the default ordering then applies rather than an unusable instruction.
   */
  preferSegmentContainer?: SegmentContainer;
}

/**
 * An optional input the chooser did without, and the answer it assumed.
 *
 * Every one of these has a reasonable fallback, which is exactly the problem:
 * a reasonable fallback produces a plausible instruction, so nothing ever
 * looks wrong. Three fields in one evening — `operations`, `hlsAudioCodecs`
 * and `hlsTs` — were declared here, consumed here, defaulted here, and
 * populated by no host anywhere, and each was invisible for the same reason.
 *
 * Reporting what was assumed is the only thing that distinguishes "the host
 * considered this and had nothing to say" from "nobody ever wired it up".
 */
export type PlaybackChoiceAssumption =
  /** No executor facts: assumed this node can perform whatever it is asked. */
  | 'operations'
  /** No HLS video list: assumed the direct-play decoder also serves delivery. */
  | 'hlsVideoCodecs'
  /** No HLS audio list: assumed the same. */
  | 'hlsAudioCodecs'
  /** Never asked about MPEG-TS: assumed unsupported. */
  | 'hlsTs'
  /** No depth claimed: assumed any sample depth decodes. */
  | 'videoBitDepth';

export interface PlaybackInstruction {
  mode: PlaybackMode;
  video: StreamInstruction;
  audio: StreamInstruction;
  /** Only meaningful when something is being packaged rather than served whole. */
  container?: SegmentContainer;
  /** Every reason that shaped this decision, in the order they were found. */
  reasons: PlaybackDecisionReason[];
  /**
   * Optional inputs no host supplied, which this decision assumed answers
   * for. Empty means the decision was made on stated facts throughout.
   */
  assumed: PlaybackChoiceAssumption[];
}

/**
 * Transfer characteristics needing no HDR capability to display correctly.
 * Anything outside this set is HDR of some kind and must be advertised.
 */
const SDR_TRANSFERS: ReadonlySet<string> = new Set([
  'bt709', 'bt601', 'smpte170m', 'smpte240m', 'bt470m', 'bt470bg',
  'linear', 'iec61966-2-1', 'iec61966-2-4', 'log100', 'log316', 'unknown', '',
]);

function has(list: readonly string[] | undefined, value: string | undefined): boolean {
  if (!list || value === undefined) return false;
  const wanted = value.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Container families, so that a probed demuxer name can be resolved to the
 * one format the file actually is.
 *
 * This matters more than it looks. A probed format names every format its
 * demuxer covers, not the file's own: Matroska arrives as `matroska,webm`
 * and MP4 as `mov,mp4,m4a,3gp,3g2,mj2`. Matching any listed name means a
 * host that supports WebM — as every browser and the Samsung do — accepts a
 * Matroska file as directly playable, which is the corrupt picture we spent
 * an evening chasing. Matroska and WebM share a demuxer and are not the same
 * container to a decoder.
 *
 * The first recognised name is ffmpeg's canonical one for that demuxer, so
 * it decides the family; the family's aliases are then what the host may
 * have named it.
 */
const CONTAINER_FAMILIES: ReadonlyArray<readonly string[]> = [
  ['matroska', 'mkv'],
  ['webm'],
  ['mov', 'mp4', 'm4a', 'm4v', '3gp', '3g2'],
  ['mpegts', 'ts', 'mts', 'm2ts'],
  ['ogg', 'oga', 'ogv'],
  ['mp3', 'mp2', 'mpeg'],
  ['flac'],
  ['wav'],
  ['aac', 'adts'],
  ['avi'],
];

/**
 * The single container a probed format actually describes, or undefined when
 * the name is not one we know how to disambiguate.
 */
export function canonicalContainers(format: string): readonly string[] | undefined {
  for (const name of format.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const family = CONTAINER_FAMILIES.find((names) => names.includes(name));
    if (family) return family;
  }
  return undefined;
}

/** Whether the host can play the source whole, in the container it is in. */
export function containerIsPlayable(format: string, containers: readonly string[]): boolean {
  const family = canonicalContainers(format);
  if (family) return family.some((name) => has(containers, name));
  // An unrecognised demuxer: fall back to naming it exactly, which is all
  // the host could have done either.
  return format.split(',').map((name) => name.trim()).filter(Boolean)
    .some((name) => has(containers, name));
}

/** Delivery over HLS may use a different decoder than direct play does. */
function deliveryVideoCodecs(capabilities: PlaybackCapabilities): readonly string[] {
  return capabilities.hlsVideoCodecs ?? capabilities.videoCodecs;
}

function deliveryAudioCodecs(capabilities: PlaybackCapabilities): readonly string[] {
  return capabilities.hlsAudioCodecs ?? capabilities.audioCodecs;
}

/**
 * Why this video stream cannot be played as it stands, or undefined if it can.
 *
 * An unreported fact is never a reason to transcode. Servers omit what they
 * could not probe — bit depth is missing from Matroska HEVC, and colour
 * transfer needs an SPS the bounded probe may not reach — so treating
 * silence as incapacity would transcode most of a library. The server's
 * advisory warnings catch a wrong guess; a needless transcode costs the
 * viewer quality and the node its CPU, and nothing catches that.
 */
export function videoStreamObjection(
  stream: MediaTechnicalStream,
  capabilities: PlaybackCapabilities,
  overrides: PlaybackPolicyOverrides = {},
): PlaybackDecisionReason | undefined {
  if (has(overrides.excludeVideoCodecs, stream.codec)) return 'host-policy-excludes-codec';
  if (!has(capabilities.videoCodecs, stream.codec)) return 'video-codec-not-playable';
  if (stream.bitDepth !== undefined && capabilities.videoBitDepth !== undefined
    && stream.bitDepth > capabilities.videoBitDepth) return 'video-bit-depth-exceeds-client';

  const transfer = stream.colorTransfer?.toLowerCase();
  if (transfer !== undefined && !SDR_TRANSFERS.has(transfer) && !has(capabilities.hdr, transfer)) {
    return 'video-transfer-not-presentable';
  }
  if (stream.dolbyVisionProfile !== undefined
    && !(capabilities.dolbyVision ?? []).includes(stream.dolbyVisionProfile)) {
    return 'video-dolby-vision-not-supported';
  }
  return undefined;
}

export function audioStreamObjection(
  stream: MediaTechnicalStream,
  capabilities: PlaybackCapabilities,
  overrides: PlaybackPolicyOverrides = {},
): PlaybackDecisionReason | undefined {
  if (has(overrides.excludeAudioCodecs, stream.codec)) return 'host-policy-excludes-codec';
  if (!has(capabilities.audioCodecs, stream.codec)) return 'audio-codec-not-playable';
  return undefined;
}

/**
 * Note this reads `hlsTs`, which the default ordering never reached: `fmp4`
 * was returned one line before it was consulted. A preference and its
 * detection have to arrive together or neither does anything — which is how
 * `hlsTs` managed to be both unreachable and unpopulated without anyone
 * noticing.
 */
function segmentContainer(
  capabilities: PlaybackCapabilities,
  overrides: PlaybackPolicyOverrides,
): { container: SegmentContainer | undefined; preferred: boolean } {
  const fmp4 = capabilities.hlsFmp4;
  const mpegts = capabilities.hlsTs ?? false;
  const wanted = overrides.preferSegmentContainer;

  if (wanted === 'mpegts' && mpegts) return { container: 'mpegts', preferred: fmp4 };
  if (wanted === 'fmp4' && fmp4) return { container: 'fmp4', preferred: false };

  if (fmp4) return { container: 'fmp4', preferred: false };
  if (mpegts) return { container: 'mpegts', preferred: false };
  return { container: undefined, preferred: false };
}

export interface ChooseInstructionOptions {
  /** Stream indices the viewer selected, when they have chosen. */
  videoStream?: number;
  audioStream?: number;
  overrides?: PlaybackPolicyOverrides;
  /**
   * What this node's build can perform for this source.
   *
   * An input rather than a validation step, deliberately: as a check it could
   * only explain a failure the viewer has already suffered, whereas as an
   * input it prevents the instruction being formed. Omit it and the chooser
   * assumes the node can do whatever it is asked, which is what it did before
   * the facts endpoint existed.
   */
  operations?: PlaybackOperations;
}

/**
 * Decide what to ask the server for, from what the media is and what the host
 * can actually decode.
 *
 * The server no longer chooses: it reports what the media is and performs
 * what it is told. Deciding from the same facts by the same rules is not
 * something each client should reinvent, so it lives here.
 *
 * Copy whatever can be copied. Repackaging is cheap and lossless; re-encoding
 * costs the viewer quality and the node its CPU, so a container mismatch must
 * never escalate to a full transcode, and an audio codec the host listed must
 * never be silently downmixed to AAC.
 */
export function choosePlaybackInstruction(
  profile: MediaTechnicalProfile,
  capabilities: PlaybackCapabilities,
  options: ChooseInstructionOptions = {},
): PlaybackInstruction {
  const overrides = options.overrides ?? {};
  const reasons: PlaybackDecisionReason[] = [];
  const assumed: PlaybackChoiceAssumption[] = [];
  if (options.operations === undefined) assumed.push('operations');
  if (capabilities.hlsVideoCodecs === undefined) assumed.push('hlsVideoCodecs');
  if (capabilities.hlsAudioCodecs === undefined) assumed.push('hlsAudioCodecs');
  if (capabilities.hlsTs === undefined) assumed.push('hlsTs');
  if (capabilities.videoBitDepth === undefined) assumed.push('videoBitDepth');
  const streams = profile.streams;

  const video = options.videoStream !== undefined
    ? streams.find((s) => s.index === options.videoStream)
    : streams.find((s) => s.type === 'video');
  const audio = options.audioStream !== undefined
    ? streams.find((s) => s.index === options.audioStream)
    : streams.find((s) => s.type === 'audio' && s.default) ?? streams.find((s) => s.type === 'audio');

  const { container, preferred: containerPreferred } = segmentContainer(capabilities, overrides);
  if (containerPreferred) reasons.push('host-policy-prefers-container');
  if (streams.length === 0) reasons.push('no-technical-facts');

  // A stream with no video is the music case; the container decision still applies.
  const videoObjection = video === undefined ? undefined : videoStreamObjection(video, capabilities, overrides);
  const audioObjection = audio === undefined ? undefined : audioStreamObjection(audio, capabilities, overrides);

  // Prefer the server's resolved family. `format` is the demuxer list and
  // matching it accepts a Matroska file for any host that supports WebM.
  const containerName = profile.container ?? profile.format;
  let containerPlayable = containerIsPlayable(containerName, capabilities.containers);
  if (containerPlayable && overrides.excludeContainers
    && containerName.split(',').some((name) => has(overrides.excludeContainers, name.trim()))) {
    containerPlayable = false;
    reasons.push('host-policy-excludes-container');
  } else if (!containerPlayable) {
    reasons.push('container-not-playable');
  }
  if (videoObjection) reasons.push(videoObjection);
  if (audioObjection) reasons.push(audioObjection);

  const directForbidden = overrides.neverDirect === true;
  if (directForbidden && containerPlayable && !videoObjection && !audioObjection) {
    reasons.push('host-policy-forbids-direct');
  }

  const operations = options.operations;
  if (operations && !operations.direct && containerPlayable && !videoObjection && !audioObjection) {
    reasons.push('executor-cannot-direct');
  }

  if (containerPlayable && !videoObjection && !audioObjection && !directForbidden
    && (operations?.direct ?? true)) {
    return { mode: 'direct', video: 'copy', audio: 'copy', reasons: ['source-plays-as-is'], assumed };
  }

  // The streams themselves are fine — only the wrapper, or one track, is not.
  // Copying the video is the whole point of the per-stream instruction.
  if (!videoObjection) {
    // ...unless HLS delivery uses a different decoder that cannot take it.
    const deliverable = (video === undefined || has(deliveryVideoCodecs(capabilities), video.codec))
      && (video === undefined || (operations?.copyIntoFmp4.video ?? true));
    if (video !== undefined && operations && !operations.copyIntoFmp4.video) {
      reasons.push('executor-cannot-copy-video');
    }
    if (deliverable) {
      const canCopyAudio = operations?.copyIntoFmp4.audio ?? true;
      const audioDeliverable = audio === undefined
        || (!audioObjection && has(deliveryAudioCodecs(capabilities), audio.codec) && canCopyAudio);
      if (!audioDeliverable && !audioObjection && audio !== undefined) {
        reasons.push(canCopyAudio ? 'audio-codec-not-deliverable-over-hls' : 'executor-cannot-copy-audio');
      }
      // `remux` means the container changed and *every* stream was copied.
      // Re-encoding one makes it a transcode that happens to copy the video,
      // which is legal and says the same thing. The two are not
      // interchangeable: the server refuses `remux` with any quality
      // conversion, and refuses it by contract rather than by capability.
      return audioDeliverable
        ? { mode: 'remux', video: 'copy', audio: 'copy', container, reasons, assumed }
        : { mode: 'transcode', video: 'copy', audio: 'transcode', container, reasons, assumed };
    }
    reasons.push('video-codec-not-deliverable-over-hls');
  }

  const audioDeliverable = audio === undefined
    || (!audioObjection && has(deliveryAudioCodecs(capabilities), audio.codec)
      && (operations?.copyIntoFmp4.audio ?? true));
  return { mode: 'transcode', video: 'transcode', audio: audioDeliverable ? 'copy' : 'transcode', container, reasons, assumed };
}


/**
 * One step less ambitious, after the executor refused the instruction.
 *
 * The chooser reasons about the media and the device. It cannot reason about
 * the node: whether *this* build can copy E-AC-3 into fragmented MP4 is a
 * fact about the server, and until the facts endpoint reports its
 * `operations` there is no way to know before asking. So a wholly correct
 * instruction can still be refused, and the viewer gets nothing.
 *
 * Degrading turns that into a slightly worse picture instead. It is
 * deliberately one step and one direction — a copy becomes a transcode,
 * never the reverse — so it converges, cannot loop, and cannot invent an
 * instruction more ambitious than the one that was already refused.
 *
 * Returns undefined when there is nothing left to give up, which is the point
 * at which the failure is real and must surface.
 */
export function degradeInstruction(instruction: PlaybackInstruction): PlaybackInstruction | undefined {
  const reasons: PlaybackDecisionReason[] = [...instruction.reasons, 'executor-refused-copy'];

  // Audio first: re-encoding a soundtrack costs far less than re-encoding
  // video, and an unsupported copy is more often the audio codec.
  //
  // Giving up the audio copy leaves the mode's own contract violated if it
  // was `remux`, which requires every stream copied. The instruction becomes
  // a transcode that copies the video — the same operation, legally stated.
  if (instruction.audio === 'copy') {
    return {
      ...instruction,
      mode: instruction.mode === 'remux' ? 'transcode' : instruction.mode,
      audio: 'transcode',
      reasons,
    };
  }
  if (instruction.video === 'copy') {
    return { ...instruction, mode: 'transcode', video: 'transcode', reasons };
  }
  return undefined;
}
