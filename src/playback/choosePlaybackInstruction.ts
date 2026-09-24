import type { MediaTechnicalProfile, MediaTechnicalStream, PlaybackCapabilities, PlaybackMode } from '../types.js';
import type { PlaybackDecisionFacts, PlaybackOperations } from '../api/PlaybackFactsApi.js';

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
  | 'executor-cannot-copy-audio'
  // The player could not decode the copied streams, so they are converted.
  | 'player-could-not-decode';

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
  ['mp3', 'mp2'],
  // MPEG program stream — a *video* container, and deliberately not grouped
  // with mp3. libav's names look adjacent and are not: the server reports
  // `mpeg` for a .mpg, so sharing a family with mp3 would let a host that
  // claims only mp3 be told a program stream plays as-is. The same shape of
  // mistake as reading `matroska,webm` as WebM.
  ['mpeg', 'mpg', 'vob', 'm2p'],
  ['flac'],
  ['wav'],
  ['aiff', 'aif'],
  ['aac', 'adts'],
  ['avi'],
  ['asf', 'wmv', 'wma'],
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
 *
 * The node's `copyIntoMpegts` deliberately does *not* veto the preference
 * here. A host states a carriage preference because the other carriage is
 * broken on the device — the 2017 Samsung black-screens copied HEVC in
 * fragmented MP4 — so falling back to fMP4 on learning that the node cannot
 * copy into MPEG-TS would trade a transcode the viewer can watch for a copy
 * they cannot. The node's answer decides copy versus transcode *within* the
 * chosen container; it does not decide the container.
 *
 * Exported because carriage is decided by the host and the device alone, so
 * every path that asks a node to transform — including the no-facts fallback,
 * which has no instruction to take it from — has to answer the same way. A
 * second implementation of this is how a host policy goes quietly missing.
 */
export function segmentContainer(
  capabilities: PlaybackCapabilities,
  overrides: PlaybackPolicyOverrides = {},
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

/**
 * Which streams this node can copy into the container we settled on.
 *
 * Copy support is a property of the pair, not of the node: MPEG-TS takes
 * MPEG-2 video and MP3 audio that fragmented MP4 refuses, and fragmented MP4
 * takes AV1 and Opus that MPEG-TS refuses. Asking `copyIntoFmp4` about a
 * MPEG-TS session would answer a question nobody asked.
 *
 * From server 0.58.0 each stream answers for itself, and that answer wins: the
 * node's `operations` pair spoke only for the first video and audio stream,
 * which is not the one played when another is named. An older node's pair
 * answers where a stream carries nothing.
 *
 * With no facts at all, assume the node can copy — the chooser's behaviour
 * before the facts endpoint existed, and the 400 is the loud, recoverable leg.
 */
function copyInto(
  container: SegmentContainer | undefined,
  operations: PlaybackOperations | undefined,
  video: MediaTechnicalStream | undefined,
  audio: MediaTechnicalStream | undefined,
): { video: boolean; audio: boolean } {
  const key = container === 'mpegts' ? 'mpegts' : 'fmp4';
  const pair = !operations ? { video: true, audio: true }
    : container === 'mpegts' ? operations.copyIntoMpegts : operations.copyIntoFmp4;
  return {
    video: video?.copyInto ? video.copyInto[key] : pair.video,
    audio: audio?.copyInto ? audio.copyInto[key] : pair.audio,
  };
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
    : defaultStream(streams, 'video');
  const audio = options.audioStream !== undefined
    ? streams.find((s) => s.index === options.audioStream)
    : defaultStream(streams, 'audio');

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
  const executorCanCopy = copyInto(container, operations, video, audio);

  if (!videoObjection) {
    // ...unless HLS delivery uses a different decoder that cannot take it.
    const deliverable = (video === undefined || has(deliveryVideoCodecs(capabilities), video.codec))
      && (video === undefined || executorCanCopy.video);
    if (video !== undefined && operations && !executorCanCopy.video) {
      reasons.push('executor-cannot-copy-video');
    }
    if (deliverable) {
      const canCopyAudio = executorCanCopy.audio;
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
      && executorCanCopy.audio);
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
/**
 * The step down from a copied generation the player could not decode: convert
 * every stream that was being copied. Both, not the audio first as
 * `degradeInstruction` does, because a decoder failure does not say which
 * stream it could not handle, and the fallback is taken only once. Undefined
 * when nothing was being copied.
 */
/**
 * A step down's reasons: the instruction's own, less `source-plays-as-is`,
 * which stops being true the moment anything is converted, plus why it
 * stepped down. The Android TV set showed "plays the file as it is" beside
 * "could not decode the original streams" on 2026-09-24.
 */
function steppedDownReasons(reasons: readonly PlaybackDecisionReason[], why: PlaybackDecisionReason): PlaybackDecisionReason[] {
  return [...reasons.filter((reason) => reason !== 'source-plays-as-is'), why];
}

export function transcodeUndecodable(instruction: PlaybackInstruction): PlaybackInstruction | undefined {
  if (instruction.video !== 'copy' && instruction.audio !== 'copy') return undefined;
  return {
    ...instruction,
    mode: 'transcode',
    video: instruction.video === 'copy' ? 'transcode' : instruction.video,
    audio: instruction.audio === 'copy' ? 'transcode' : instruction.audio,
    reasons: steppedDownReasons(instruction.reasons, 'player-could-not-decode'),
  };
}

export function degradeInstruction(instruction: PlaybackInstruction): PlaybackInstruction | undefined {
  const reasons = steppedDownReasons(instruction.reasons, 'executor-refused-copy');

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

/** One file's facts, and which file, where the facts say. */
export type FileFacts = PlaybackDecisionFacts & { mediaId?: string };

/** The file to play, the instruction for it, and where it stood in the list. */
export interface FileChoice {
  instruction: PlaybackInstruction;
  /** Undefined when the facts name no file and the item has more than one. */
  mediaId?: string;
  index: number;
}

/** The server's own ranking, from when it chose: direct, then remux, then transcode. */
const MODE_RANK: Record<PlaybackMode, number> = { direct: 0, remux: 1, transcode: 2 };

/**
 * Which of an item's files to play, and how. Choosing among an item's files
 * is the client's decision (Tom, 2026-09-24), and this is the one ranking every
 * client uses, the coordinator included: an instruction for each file, then
 * the best by mode, with ties to stored order, as the server ranked them. A
 * file whose facts carry no id is named from `mediaIds` when the item has
 * exactly one. Undefined for an empty list.
 */
export function chooseAmongFiles(
  files: readonly FileFacts[],
  capabilities: PlaybackCapabilities,
  options: { overrides?: ChooseInstructionOptions['overrides'] } = {},
  mediaIds: readonly string[] = [],
): FileChoice | undefined {
  let best: FileChoice | undefined;
  files.forEach((file, index) => {
    const instruction = choosePlaybackInstruction(file.profile, capabilities, { overrides: options.overrides, operations: file.operations });
    if (!best || MODE_RANK[instruction.mode] < MODE_RANK[best.instruction.mode]) {
      best = { instruction, mediaId: file.mediaId, index };
    }
  });
  if (best && best.mediaId === undefined && mediaIds.length === 1) best = { ...best, mediaId: mediaIds[0] };
  return best;
}

/**
 * The stream of a type core plays when nothing names one: the stream flagged
 * default, else the first. From server 0.58.0 the node chooses no stream, so
 * this rule is core's, and it is the same rule the node used to apply.
 */
export function defaultStream(streams: readonly MediaTechnicalStream[], type: 'video' | 'audio'): MediaTechnicalStream | undefined {
  const ofType = streams.filter((stream) => stream.type === type);
  return ofType.find((stream) => stream.default) ?? ofType[0];
}

/**
 * The streams to name so a node has nothing to choose, from the file's facts.
 *
 * From server 0.58.0 a node refuses any choice it would otherwise make, and a
 * language is no exception: one no stream has is `choice_not_available`, and
 * one several share is `choice_required`, for audio and subtitles alike and
 * even under `direct`. Until 0.58.0 it fell back to the default track, so a
 * viewer's language preference was safe to send whatever the file held. It no
 * longer is, and core resolves it here, against the same exact, case-blind
 * match the node makes. A caller sends these indexes in place of the
 * languages; see `withoutLanguages`.
 *
 * - video: the default stream, where a remux or transcode has several and
 *   none is named;
 * - audio: the named stream; else the one stream in the viewer's language, or
 *   the default among several in it; else, for a remux or transcode of a file
 *   with several, the default stream. `direct` names nothing then, since the
 *   player picks its own tracks;
 * - subtitle: the named stream; else the one in the viewer's language, or the
 *   default among several in it (the first when none is flagged); else none.
 *   A subtitle language the file lacks is no subtitles, not a refusal.
 */
export function streamsToName(
  profile: MediaTechnicalProfile,
  mode: PlaybackMode,
  preferences: {
    videoStream?: number | null;
    audioStream?: number | null;
    subtitleStream?: number | null;
    audioLanguage?: string;
    subtitleLanguage?: string;
  },
): { videoStream?: number; audioStream?: number; subtitleStream?: number } {
  const named = (index: number | null | undefined) => index !== undefined && index !== null && index >= 0;
  const inLanguage = (type: MediaTechnicalStream['type'], language: string | undefined) => {
    const wanted = language?.trim().toLowerCase();
    return wanted ? profile.streams.filter((stream) => stream.type === type && stream.language.toLowerCase() === wanted) : undefined;
  };
  const out: { videoStream?: number; audioStream?: number; subtitleStream?: number } = {};

  const videos = profile.streams.filter((stream) => stream.type === 'video');
  if (mode !== 'direct' && videos.length > 1 && !named(preferences.videoStream)) {
    const chosen = defaultStream(profile.streams, 'video');
    if (chosen) out.videoStream = chosen.index;
  }

  if (!named(preferences.audioStream)) {
    const audios = profile.streams.filter((stream) => stream.type === 'audio');
    const matches = inLanguage('audio', preferences.audioLanguage);
    const chosen = matches && matches.length > 0 ? defaultStream(matches, 'audio')
      : mode !== 'direct' && audios.length > 1 ? defaultStream(profile.streams, 'audio')
        : undefined;
    if (chosen) out.audioStream = chosen.index;
  }

  if (!named(preferences.subtitleStream)) {
    const matches = inLanguage('subtitle', preferences.subtitleLanguage);
    const chosen = matches?.find((stream) => stream.default) ?? matches?.[0];
    if (chosen) out.subtitleStream = chosen.index;
  }
  return out;
}

/**
 * Preferences with the viewer's languages taken out, for a request whose
 * streams `streamsToName` has already resolved from them. A named index wins
 * on the node, but where nothing was named (a `direct` play, or no subtitle in
 * that language) a language left in would be refused outright.
 */
export function withoutLanguages<T extends { audioLanguage?: string; subtitleLanguage?: string }>(preferences: T): T {
  const { audioLanguage: _audio, subtitleLanguage: _subtitle, ...rest } = preferences;
  return rest as T;
}
