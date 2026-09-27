import type { MediaTechnicalProfile, PlaybackCapabilities } from '../types.js';
import type { PlaybackPreferencesUpdate } from './PlaybackResolver.js';
import type { PlaybackOperations } from '../api/PlaybackFactsApi.js';
import type { PlaybackMode } from '../types.js';
import {
  choosePlaybackInstruction,
  type PlaybackDecisionReason,
  segmentContainer,
  type FileFacts,
  type PlaybackInstruction,
  type PlaybackPolicyOverrides,
} from './choosePlaybackInstruction.js';

/**
 * The picture sizes a viewer chooses between, by their conventional height.
 * Tom, 2026-09-25: per-quality Play buttons beside the generic Play, capping
 * down only, from the best file's class to 720; a best file below 720p is
 * offered as its own class, never one above.
 */
export type QualityClass = 2160 | 1440 | 1080 | 720 | 576 | 480 | 360;

/** Highest first. */
export const QUALITY_CLASSES: readonly QualityClass[] = [2160, 1440, 1080, 720, 576, 480, 360];

/** The lowest class offered as a step when the best file reaches it. */
const LOWEST_STEP: QualityClass = 720;

/** The frame a class stands for: 16:9 at its height. */
function classFrame(quality: QualityClass): { width: number; height: number } {
  return { width: Math.round((quality * 16) / 9), height: quality };
}

/**
 * The class a picture of this size belongs to: the highest whose frame it
 * fills to within 10% in either dimension. Either, because a film is framed
 * wider than 16:9 (1920x800 is a 1080p file) and a 4:3 transfer narrower
 * (1440x1080 is too). The tolerance takes in encodes cropped a little short
 * of their class, such as 3840x2076. Anything smaller than 360p is 360.
 */
export function qualityClass(width: number | undefined, height: number | undefined): QualityClass {
  const w = width ?? 0;
  const h = height ?? 0;
  for (const quality of QUALITY_CLASSES) {
    const frame = classFrame(quality);
    if (w >= frame.width * 0.9 || h >= frame.height * 0.9) return quality;
  }
  return 360;
}

/**
 * The class of a screen: the largest 16:9 picture it shows whole, to within
 * 10%. Not `qualityClass`'s either-dimension rule, which is right for a file
 * (a scope film is still 1080p) but wrong for a screen: a phone's 2400x1080
 * is 2400 wide, yet a 1440p picture would be scaled down to fit it, and a
 * 1080p one fits it exactly. Landscape whichever way the device is held, so
 * a phone upright is the same screen as on its side.
 */
export function displayQualityClass(width: number, height: number): QualityClass {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const fits = Math.min(short, (long * 9) / 16);
  return QUALITY_CLASSES.find((quality) => fits >= quality * 0.9) ?? 360;
}

/**
 * The largest class this device can play, from the `maxWidth` / `maxHeight`
 * its host stated, or undefined where it stated neither (the web leaves both
 * unset, and is then limited by nothing). Classed as a screen is: the largest
 * 16:9 picture within both.
 */
export function deviceQualityClass(capabilities: PlaybackCapabilities): QualityClass | undefined {
  const { maxWidth, maxHeight } = capabilities;
  if (maxWidth === undefined && maxHeight === undefined) return undefined;
  const width = maxWidth ?? Number.POSITIVE_INFINITY;
  const height = maxHeight ?? Number.POSITIVE_INFINITY;
  const fits = Math.min(height, (width * 9) / 16);
  return QUALITY_CLASSES.find((quality) => fits >= quality * 0.9) ?? 360;
}

/** A profile's picture size, from its first video stream. */
function pictureOf(profile: MediaTechnicalProfile): { width?: number; height?: number } {
  const video = profile.streams.find((stream) => stream.type === 'video' && stream.default)
    ?? profile.streams.find((stream) => stream.type === 'video');
  return { width: video?.width, height: video?.height };
}

/** The class of a file's picture; see `qualityClass`. */
export function profileQualityClass(profile: MediaTechnicalProfile): QualityClass {
  const { width, height } = pictureOf(profile);
  return qualityClass(width, height);
}

/** What a device's connection is, as its host knows it. */
export type ConnectionKind = 'wifi' | 'cellular' | 'unknown';

/**
 * The viewer's stated ceilings, kept per device by the host. Absent means the
 * viewer set none. `cellular` applies on mobile data and `wifi` otherwise;
 * a connection the host cannot name counts as Wi-Fi.
 */
export interface QualityPreference {
  wifi?: QualityClass;
  cellular?: QualityClass;
  /**
   * Offer every quality and every mode, even those this device cannot play.
   * Tom, 2026-09-25: limit to the device's capabilities on all clients, with
   * a setting on all clients to turn the limit off. It widens what is
   * offered; automatic play still stays within the device.
   */
  offerAll?: boolean;
}

/**
 * Why automatic play was capped, as a code for the host to explain (Tom:
 * "with context to the user as to why"):
 * - `ceiling-display`: no setting, so the display's own class;
 * - `ceiling-preference`: the viewer's setting;
 * - `ceiling-cellular`: on mobile data, the mobile-data ceiling;
 * - `ceiling-device`: the largest picture this device can play, from the
 *   `maxWidth` / `maxHeight` its host stated (see `deviceQualityClass`).
 */
export type QualityCeilingReason = 'ceiling-display' | 'ceiling-preference' | 'ceiling-cellular' | 'ceiling-device';

export interface QualityCeiling {
  quality: QualityClass;
  reason: QualityCeilingReason;
}

/**
 * The mobile-data ceiling where the viewer set none. Lower than Wi-Fi by
 * Tom's ruling; the value itself is core's default, not a ruling, and a host
 * or a viewer setting replaces it.
 */
export const DEFAULT_CELLULAR_CEILING: QualityClass = 720;

export interface QualityCeilingInput {
  /** The display's resolution as the host measured it, in physical pixels. */
  display?: { width: number; height: number };
  preference?: QualityPreference;
  connection?: ConnectionKind;
  /** Replaces `DEFAULT_CELLULAR_CEILING` for a host that ships its own. */
  cellularDefault?: QualityClass;
}

/**
 * The highest class automatic play may choose, and why, or undefined when
 * nothing caps it. An explicit setting overrides the display, in either
 * direction (Tom: "cap at the screen resolution for automatic play", and an
 * explicit setting overrides it). On mobile data the lower of the mobile-data
 * ceiling and the Wi-Fi one applies. An explicit pick of a version is never
 * capped; this is for automatic play only.
 */
export function qualityCeiling(input: QualityCeilingInput): QualityCeiling | undefined {
  const display = input.display ? displayQualityClass(input.display.width, input.display.height) : undefined;
  const wifi: QualityCeiling | undefined = input.preference?.wifi !== undefined
    ? { quality: input.preference.wifi, reason: 'ceiling-preference' }
    : display !== undefined ? { quality: display, reason: 'ceiling-display' } : undefined;
  if (input.connection !== 'cellular') return wifi;
  const cellular = input.preference?.cellular ?? input.cellularDefault ?? DEFAULT_CELLULAR_CEILING;
  if (wifi && wifi.quality <= cellular) return wifi;
  return { quality: cellular, reason: 'ceiling-cellular' };
}

/** One file of the item, with its class and how this device would play it. */
export interface VersionFile {
  mediaId?: string;
  quality: QualityClass;
  width?: number;
  height?: number;
  instruction: PlaybackInstruction;
  /** Its place in the facts, which is stored order. */
  index: number;
}

/**
 * One quality a viewer can pick: a file of that class played as the device
 * plays it, or, where no file is of that class, a transcode of the smallest
 * file above it, capped to the class.
 */
export interface VersionStep {
  quality: QualityClass;
  source: 'file' | 'transcode';
  mediaId?: string;
  instruction: PlaybackInstruction;
  /** The height cap for a `transcode` step, fitted to the source's shape. */
  maxHeight?: number;
}

export interface PlaybackVersions {
  files: VersionFile[];
  /**
   * Highest first, from the best file's class down to 720p, without any above
   * what the device can play unless `offerAll` was set.
   */
  steps: VersionStep[];
  /** The largest class the device can play, where its host stated one. */
  deviceLimit?: QualityClass;
  /** What automatic play would choose. */
  automatic?: VersionStep;
  /** Set when the ceiling kept automatic play off a larger file. */
  limitedBy?: QualityCeiling;
}

const MODE_RANK = { direct: 0, remux: 1, transcode: 2 } as const;

/**
 * The height that fits a source into a class's 16:9 frame without changing
 * its shape: a 2.39:1 film capped to 720p is 1280 wide, so 536 high, not 720.
 * Even, as encoders want it.
 */
function cappedHeight(file: VersionFile, quality: QualityClass): number {
  const frame = classFrame(quality);
  const width = file.width ?? 0;
  const height = file.height ?? 0;
  if (width <= 0 || height <= 0) return quality;
  const scale = Math.min(frame.width / width, frame.height / height, 1);
  return Math.max(2, Math.round((height * scale) / 2) * 2);
}

function capped(file: VersionFile, quality: QualityClass, capabilities: PlaybackCapabilities, overrides?: PlaybackPolicyOverrides): VersionStep {
  const { container } = segmentContainer(capabilities, overrides);
  // Audio keeps its copy where the file's own instruction already packaged a
  // copy of it; a direct instruction says nothing about packaging, so it is
  // re-encoded like the picture.
  const audio = file.instruction.mode !== 'direct' && file.instruction.audio === 'copy' ? 'copy' : 'transcode';
  return {
    quality,
    source: 'transcode',
    ...(file.mediaId !== undefined ? { mediaId: file.mediaId } : {}),
    instruction: {
      mode: 'transcode', video: 'transcode', audio, container,
      reasons: file.instruction.reasons, assumed: file.instruction.assumed,
    },
    maxHeight: cappedHeight(file, quality),
  };
}

function fileStep(file: VersionFile): VersionStep {
  return {
    quality: file.quality,
    source: 'file',
    ...(file.mediaId !== undefined ? { mediaId: file.mediaId } : {}),
    instruction: file.instruction,
  };
}

/**
 * Of several files, the one to play: a file that plays without re-encoding
 * before one that needs it, then the larger picture, then direct before
 * remux, then stored order. Among files of one class this is the chooser's
 * own ranking (see `chooseAmongFiles`); across classes, a remux of 2160p
 * plays before a direct 1080p, as nothing is lost either way.
 */
function best(files: readonly VersionFile[]): VersionFile | undefined {
  return [...files].sort((a, b) =>
    Number(a.instruction.mode === 'transcode') - Number(b.instruction.mode === 'transcode')
    || b.quality - a.quality
    || MODE_RANK[a.instruction.mode] - MODE_RANK[b.instruction.mode]
    || a.index - b.index)[0];
}

export interface PlaybackVersionsOptions {
  overrides?: PlaybackPolicyOverrides;
  /** The item's files, to name a lone file whose facts carry no id. */
  mediaIds?: readonly string[];
  /** The cap on automatic play; see `qualityCeiling`. */
  ceiling?: QualityCeiling;
  /** Offer steps above the device's limit too; see `QualityPreference.offerAll`. */
  offerAll?: boolean;
}

/**
 * Every quality a viewer can pick for an item, from its files' facts, and the
 * one automatic play would choose. Pure: a host calls it on its media screen
 * to draw the buttons, and the coordinator calls it to start.
 *
 * Automatic play takes the best file at or below the ceiling. Where every
 * file is above it, it takes a transcode of the smallest, capped to the
 * ceiling.
 */
export function playbackVersions(
  facts: readonly FileFacts[],
  capabilities: PlaybackCapabilities,
  options: PlaybackVersionsOptions = {},
): PlaybackVersions {
  const files: VersionFile[] = facts.map((fact, index) => {
    const { width, height } = pictureOf(fact.profile);
    const mediaId = fact.mediaId ?? (facts.length === 1 && options.mediaIds?.length === 1 ? options.mediaIds[0] : undefined);
    return {
      ...(mediaId !== undefined ? { mediaId } : {}),
      quality: qualityClass(width, height),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      instruction: choosePlaybackInstruction(fact.profile, capabilities, { overrides: options.overrides, operations: fact.operations }),
      index,
    };
  });
  if (files.length === 0) return { files, steps: [] };

  const top = Math.max(...files.map((file) => file.quality)) as QualityClass;
  const floor = top < LOWEST_STEP ? top : LOWEST_STEP;
  const stepAt = (quality: QualityClass): VersionStep => {
    const own = best(files.filter((file) => file.quality === quality));
    if (own) return fileStep(own);
    const above = files.filter((file) => file.quality > quality);
    const smallest = best(above.filter((file) => file.quality === Math.min(...above.map((f) => f.quality))))!;
    return capped(smallest, quality, capabilities, options.overrides);
  };
  const deviceLimit = deviceQualityClass(capabilities);
  const offered = (quality: QualityClass) => options.offerAll || deviceLimit === undefined || quality <= deviceLimit;
  const steps = QUALITY_CLASSES.filter((quality) => quality <= top && quality >= floor && offered(quality)).map(stepAt);
  // Where the device cannot play even the lowest step, it is offered its own
  // limit instead, so there is always something to press.
  if (steps.length === 0 && deviceLimit !== undefined) steps.push(stepAt(deviceLimit));

  // Automatic play stays within the device whatever is offered, under the
  // lower of the device and the host's ceiling.
  const ceiling = deviceLimit !== undefined && (!options.ceiling || deviceLimit < options.ceiling.quality)
    ? { quality: deviceLimit, reason: 'ceiling-device' as const }
    : options.ceiling;
  const within = ceiling ? files.filter((file) => file.quality <= ceiling.quality) : files;
  const automatic = within.length > 0 ? fileStep(best(within)!) : stepAt(ceiling!.quality);
  return {
    files,
    steps,
    ...(deviceLimit !== undefined ? { deviceLimit } : {}),
    automatic,
    // Only where the ceiling excluded a file: a larger file passed over
    // because it needs re-encoding is the ranking, not the ceiling.
    ...(ceiling && files.some((file) => file.quality > ceiling.quality) ? { limitedBy: ceiling } : {}),
  };
}

/**
 * The preferences that start playback on a version the viewer picked, for
 * `PlaybackRuntime.play(request, versionPreferences(step))`. A concrete mode,
 * so the coordinator treats it as the viewer's choice: never capped, never
 * stepped down. During playback use `PlaybackCoordinator.playVersion`.
 */
export function versionPreferences(step: VersionStep): PlaybackPreferencesUpdate {
  return {
    mode: step.instruction.mode,
    video: step.instruction.video,
    audio: step.instruction.audio,
    ...(step.instruction.container !== undefined ? { container: step.instruction.container } : {}),
    ...(step.maxHeight !== undefined ? { maxHeight: step.maxHeight } : {}),
    ...(step.mediaId !== undefined ? { mediaId: step.mediaId } : {}),
  };
}

/** Whether this device can play a file a given way, and why not. */
export interface OfferedMode {
  mode: PlaybackMode;
  /** False where the device cannot play it so; true for all with `offerAll`. */
  offered: boolean;
  /** Why the device cannot, from the chooser, even where `offerAll` offers it. */
  reasons: PlaybackDecisionReason[];
}

/**
 * The modes to offer for a file on this device. Tom, 2026-09-25: limit to
 * the device's capabilities, with a setting to turn the limit off. `direct`
 * is offered where the chooser would play the file directly, `remux` where it
 * would play it without re-encoding (directly, or copied into a segment
 * container), and `transcode` always. With `offerAll` every mode is offered,
 * and the reasons still say why the device objects, for the host to show.
 */
export function offeredModes(
  profile: MediaTechnicalProfile,
  capabilities: PlaybackCapabilities,
  options: { operations?: PlaybackOperations; overrides?: PlaybackPolicyOverrides; offerAll?: boolean } = {},
): OfferedMode[] {
  const instruction = choosePlaybackInstruction(profile, capabilities, { operations: options.operations, overrides: options.overrides });
  const why = instruction.reasons.filter((reason) => reason !== 'source-plays-as-is' && reason !== 'host-policy-prefers-container');
  const playable = (mode: PlaybackMode) => MODE_RANK[instruction.mode] <= MODE_RANK[mode];
  return (['direct', 'remux', 'transcode'] as const).map((mode) => ({
    mode,
    offered: options.offerAll === true || playable(mode),
    reasons: playable(mode) ? [] : why,
  }));
}
