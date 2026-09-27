import type { CatalogueMediaProfile } from '../api/CatalogueApi.js';
import type { MediaTechnicalProfile } from '../types.js';
import { qualityClass, type QualityClass } from './playbackVersions.js';

/**
 * A file's technical facts, normalised and labelled, for every client to lay
 * out alike. Tom, 2026-09-27: format, codec, bitrate and the like "are non
 * i18n and technical. They are core's responsibility, but should be supplied
 * to clients in a structured object. The client should still 'format' them,
 * in terms of layout." So core names each value ("HEVC", "E-AC-3", "Stereo",
 * "4K", "47.4 Mbps") and a client chooses the order, the separators, the
 * wrapping and where it sits. Sentences stay the clients' (see
 * `docs/principles-and-laws.md`: core writes no viewer text).
 *
 * The labels are the web client's, as all three clients showed them on
 * 2026-09-27 (macha-client e31635a), moved here so they cannot drift.
 */
export interface TechnicalSummary {
  /** `audio` for a file with no picture other than cover art. */
  kind: 'video' | 'audio';
  /** "2h 31m" or "31m" for a film, "3:45" or "1:02:03" for a track. */
  duration?: { ms: number; label: string };
  resolution?: { width: number; height: number; label: string };
  /** The picture's class and its name: "4K", "2K", "1080p". */
  quality?: { class: QualityClass; label: string };
  videoCodec?: { codec: string; label: string };
  /** The default audio track's, else the first's: the one that plays. */
  audioCodec?: { codec: string; label: string };
  /** A track's, where the file has no picture: "24-bit". */
  bitDepth?: { bits: number; label: string };
  /** A track's: "96 kHz". */
  sampleRate?: { hz: number; label: string };
  /** The default audio track's layout: "Mono", "Stereo", "5.1", "7.1", else "6ch". */
  channels?: { count: number; label: string };
  /** "47.4 Mbps" for a film, "2,304 kbps" for a track. */
  bitrate?: { bps: number; label: string };
  /**
   * The labels of the one-line summary every client shows, in order: for a
   * film length, resolution with its class ("3840×2160 (4K)"), video codec,
   * audio codec, channels, bitrate; for a track length, codec, bit depth,
   * sample rate, channels, bitrate. A client joins them with its own
   * separator and wraps between them. Tom, 2026-09-27: "add a (4K), (2K),
   * (1080p) etc after the physical resolution. Also add a channel count after
   * the audio codec, like 5.1".
   */
  parts: string[];
}

const COVER_ART_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp']);

/** The codec's name as clients show it: "H.264", "HEVC", "E-AC-3", else upper case. */
export function codecLabel(codec: string): string {
  const normalized = codec.trim().toLowerCase();
  if (normalized === 'h264') return 'H.264';
  if (normalized === 'hevc' || normalized === 'h265') return 'HEVC';
  if (normalized === 'aac') return 'AAC';
  if (normalized === 'ac3') return 'AC-3';
  if (normalized === 'eac3') return 'E-AC-3';
  return codec.toUpperCase();
}

/** "4K" for 2160, "2K" for 1440, else "1080p" and so on. */
export function qualityLabel(quality: QualityClass): string {
  if (quality === 2160) return '4K';
  if (quality === 1440) return '2K';
  return `${quality}p`;
}

function channelsLabel(channels: number): string {
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

function trackLength(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function filmLength(ms: number): string | undefined {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m` : undefined;
}

interface Stream {
  type: string;
  codec: string;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
  default: boolean;
  picture: boolean;
}

/** Either profile shape, as one: the catalogue's wire shape or the facts' mapped one. */
function normalised(profile: CatalogueMediaProfile | MediaTechnicalProfile): { durationMs: number; bitrate: number; streams: Stream[] } {
  if ('duration_ms' in profile) {
    return {
      durationMs: profile.duration_ms,
      bitrate: profile.bitrate,
      streams: profile.streams.map((stream) => ({
        type: stream.type, codec: stream.codec, width: stream.width, height: stream.height,
        channels: stream.channels, sampleRate: stream.sample_rate, bitDepth: stream.bit_depth,
        default: stream.default, picture: stream.attached_picture,
      })),
    };
  }
  return {
    durationMs: profile.durationMs,
    bitrate: profile.bitrate,
    streams: profile.streams.map((stream) => ({
      type: stream.type, codec: stream.codec, width: stream.width, height: stream.height,
      channels: stream.channels, sampleRate: stream.sampleRate, bitDepth: stream.bitDepth,
      default: stream.default,
      // The facts carry no attached-picture flag, so cover art is known by its codec.
      picture: stream.type === 'video' && COVER_ART_CODECS.has(stream.codec.toLowerCase()),
    })),
  };
}

/** The summary of one file; see `TechnicalSummary`. */
export function technicalSummary(profile: CatalogueMediaProfile | MediaTechnicalProfile): TechnicalSummary {
  const { durationMs, bitrate, streams } = normalised(profile);
  const video = streams.find((stream) => stream.type === 'video' && !stream.picture);
  const audio = streams.find((stream) => stream.type === 'audio' && stream.default)
    ?? streams.find((stream) => stream.type === 'audio');
  const positive = (value: number | undefined): value is number => value !== undefined && value > 0;

  if (!video) {
    const summary: TechnicalSummary = { kind: 'audio', parts: [] };
    if (durationMs > 0) summary.duration = { ms: durationMs, label: trackLength(durationMs) };
    if (audio?.codec) summary.audioCodec = { codec: audio.codec, label: codecLabel(audio.codec) };
    if (positive(audio?.bitDepth)) summary.bitDepth = { bits: audio.bitDepth, label: `${audio.bitDepth}-bit` };
    if (positive(audio?.sampleRate)) summary.sampleRate = { hz: audio.sampleRate, label: `${Number((audio.sampleRate / 1000).toFixed(1))} kHz` };
    if (positive(audio?.channels)) summary.channels = { count: audio.channels, label: channelsLabel(audio.channels) };
    if (bitrate > 0) summary.bitrate = { bps: bitrate, label: `${Math.round(bitrate / 1000).toLocaleString('en-GB')} kbps` };
    summary.parts = [summary.duration, summary.audioCodec, summary.bitDepth, summary.sampleRate, summary.channels, summary.bitrate]
      .flatMap((field) => (field ? [field.label] : []));
    return summary;
  }

  const summary: TechnicalSummary = { kind: 'video', parts: [] };
  const length = filmLength(durationMs);
  if (length) summary.duration = { ms: durationMs, label: length };
  if (positive(video.width) && positive(video.height)) {
    summary.resolution = { width: video.width, height: video.height, label: `${video.width}×${video.height}` };
    const quality = qualityClass(video.width, video.height);
    summary.quality = { class: quality, label: qualityLabel(quality) };
  }
  if (video.codec) summary.videoCodec = { codec: video.codec, label: codecLabel(video.codec) };
  if (audio?.codec) summary.audioCodec = { codec: audio.codec, label: codecLabel(audio.codec) };
  if (positive(audio?.channels)) summary.channels = { count: audio.channels, label: channelsLabel(audio.channels) };
  if (bitrate > 0) summary.bitrate = { bps: bitrate, label: `${(bitrate / 1_000_000).toFixed(1)} Mbps` };
  const resolution = summary.resolution && summary.quality
    ? { label: `${summary.resolution.label} (${summary.quality.label})` }
    : summary.resolution;
  summary.parts = [summary.duration, resolution, summary.videoCodec, summary.audioCodec, summary.channels, summary.bitrate]
    .flatMap((field) => (field ? [field.label] : []));
  return summary;
}

/**
 * One summary per distinct file, with files whose summaries read the same
 * combined, and the ids of the files each one stands for. Files identical in
 * length, resolution, codecs and bitrate are very likely one media stored
 * twice (Tom, 2026-09-27: one line for them).
 *
 * TODO: an entry with more than one media id is very likely a duplicate the
 * server could flag. Report it once the server has a route for that; it is a
 * server interaction, so it belongs here, not in each client (moved from the
 * web client's call site, 2026-09-27).
 */
export function fileSummaries(profiles: readonly (CatalogueMediaProfile | MediaTechnicalProfile)[]): Array<{ summary: TechnicalSummary; mediaIds: string[] }> {
  const combined = new Map<string, { summary: TechnicalSummary; mediaIds: string[] }>();
  for (const profile of profiles) {
    const summary = technicalSummary(profile);
    const key = summary.parts.join('\u0000');
    const mediaId = 'media_id' in profile ? profile.media_id : profile.mediaId;
    const entry = combined.get(key);
    if (entry) entry.mediaIds.push(mediaId);
    else combined.set(key, { summary, mediaIds: [mediaId] });
  }
  // Highest resolution first (Tom, 2026-09-27: "sort by descending
  // resolution"), stored order between equals; a track has none and keeps it.
  const pixels = (summary: TechnicalSummary) => (summary.resolution ? summary.resolution.width * summary.resolution.height : 0);
  return [...combined.values()].sort((a, b) => pixels(b.summary) - pixels(a.summary));
}
