import { canonicalContainers } from './choosePlaybackInstruction.js';
import type { PlaybackSession, PlaybackStreamInfo, PlaybackTransform } from './PlaybackResolver.js';

const CONTAINER_LABELS: Record<string, string> = {
  fmp4: 'FMP4',
  mpegts: 'MPEG-TS',
};

/**
 * The container actually served, as the panel should show it.
 *
 * Only ever from what the server says it produced — `output.container`, or
 * `output.format` where the node could not name a container. Never from the
 * request: synthesising it there would put the thing we asked for on screen
 * wearing the clothes of the thing we got, and the entire value of this field
 * is telling those two apart — a segment-container preference that the node
 * quietly ignored looks identical to one it honoured until something reports
 * back. Absent means absent: no text rather than a default.
 */
function servedContainer(session: PlaybackSession): string | undefined {
  // `output.format` is the fallback, not a default: it is still the server
  // describing what it produced, and it is the only answer for a direct
  // session whose container the server could not name — the six .avi files
  // report `container: ""` with `format: "avi"`. If that is fixed server-side
  // the fallback simply stops being reached.
  const container = session.output.container?.trim() || session.output.format?.trim();
  if (!container) return undefined;
  const key = container.toLowerCase();
  return CONTAINER_LABELS[key] ?? key.toUpperCase();
}

function formatBitrate(bitrate?: number): string {
  if (!bitrate) return '';
  return bitrate >= 1_000_000 ? `${(bitrate / 1_000_000).toFixed(1)} Mb/s` : `${Math.round(bitrate / 1000)} kb/s`;
}

function formatChannels(channels?: number): string {
  if (!channels) return '';
  if (channels === 1) return 'mono';
  if (channels === 2) return 'stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

function formatSampleRate(sampleRate?: number): string {
  if (!sampleRate) return '';
  return sampleRate >= 1_000 ? `${Number((sampleRate / 1_000).toFixed(1))} kHz` : `${sampleRate} Hz`;
}

function selectedStream(session: PlaybackSession, type: 'video' | 'audio' | 'subtitle', index: number): PlaybackStreamInfo | undefined {
  return session.sourceInfo.streams.find((stream) => stream.type === type && stream.index === index);
}

function sourceVideoParts(session: PlaybackSession, video: PlaybackStreamInfo): string[] {
  const parts = [video.codec.toUpperCase()];
  if (video.width && video.height) parts.push(`${video.width}×${video.height}`);
  const bitrate = formatBitrate(video.bitrate || session.sourceInfo.bitrate);
  if (bitrate) parts.push(bitrate);
  return parts;
}

function outputVideoParts(session: PlaybackSession): string[] {
  const output = session.output.video;
  if (!output) return [];
  const parts: string[] = [];
  if (output.codec) parts.push(output.codec.toUpperCase());
  if (output.width && output.height) parts.push(`${output.width}×${output.height}`);
  const bitrate = formatBitrate(output.bitrate ?? session.output.bitrate);
  if (bitrate) parts.push(bitrate);
  return parts;
}

function audioParts(stream: PlaybackStreamInfo): string[] {
  const parts: string[] = [];
  if (stream.language) parts.push(stream.language.toUpperCase());
  parts.push(stream.codec.toUpperCase());
  const channels = formatChannels(stream.channels);
  const sampleRate = formatSampleRate(stream.sampleRate);
  if (channels) parts.push(channels);
  if (sampleRate) parts.push(sampleRate);
  if (stream.bitDepth) parts.push(`${stream.bitDepth}-bit`);
  const bitrate = formatBitrate(stream.bitrate);
  if (bitrate) parts.push(bitrate);
  return parts;
}

function subtitleParts(stream: PlaybackStreamInfo): string[] {
  const parts = [stream.language ? stream.language.toUpperCase() : 'UND', stream.codec.toUpperCase()];
  if (stream.forced) parts.push('FORCED');
  return parts;
}

function outputAudioParts(session: PlaybackSession): string[] {
  const output = session.output.audio;
  if (!output) return [];
  const parts: string[] = [];
  if (output.codec) parts.push(output.codec.toUpperCase());
  const channels = formatChannels(output.channels);
  const sampleRate = formatSampleRate(output.sampleRate);
  if (channels) parts.push(channels);
  if (sampleRate) parts.push(sampleRate);
  if (output.bitDepth) parts.push(`${output.bitDepth}-bit`);
  const bitrate = formatBitrate(output.bitrate);
  if (bitrate) parts.push(bitrate);
  return parts;
}

/**
 * DIRECT or REMUX, from what was served rather than what was asked for.
 *
 * Only called when every selected stream is copied, so the question is
 * narrow: was the viewer handed the file, or something built from it?
 *
 * A manifest settles it on its own. An MPEG-TS source packaged into MPEG-TS
 * segments changes no container at all, and is still a playlist and a pile of
 * segments rather than the file — so container equality cannot answer this
 * and `isManifest` is the honest tell. That case is not hypothetical: it is
 * .ts and .m2ts sources on a host whose policy asks for MPEG-TS carriage,
 * which is the television.
 *
 * `isManifest` is not an independent witness — it is derived from the
 * session's stream mime type, which the server sets from the same plan the
 * mode comes from. What recommends it is that the player picks its loading
 * path from that same value, so a wrong one breaks playback loudly instead of
 * letting the badge lie quietly. Nothing reachable from a session object is
 * truly independent of the server; this is the field that cannot be wrong on
 * its own.
 *
 * For anything handed over whole, `output.container` decides: same container
 * as the source is a direct hand-off, a different one was repackaged. Falls
 * back to the session mode for nodes that do not report the field, which is
 * the requested mode and was the only thing available before 0.33.1.
 */
function copyModeLabel(session: PlaybackSession): string {
  if (session.source.isManifest) return 'REMUX';
  const served = session.output.container?.trim().toLowerCase();
  if (!served) return session.mode === 'direct' ? 'DIRECT' : 'REMUX';
  const source = session.sourceInfo.container ?? session.sourceInfo.format;
  const sourceFamily = canonicalContainers(source);
  const servedFamily = canonicalContainers(served);
  const unchanged = sourceFamily !== undefined && sourceFamily === servedFamily;
  return unchanged ? 'DIRECT' : 'REMUX';
}

export interface PlaybackStatusDescription {
  endpoint?: string;
  /**
   * The container the server says it served — `MPEG-TS`, `FMP4`, or a source
   * container such as `MATROSKA` for a direct session. Undefined when the
   * node did not report one; render nothing in that case rather than a
   * default, so an unanswering node stays visibly distinct from an answer.
   */
  container?: string;
  video?: string;
  audio?: string;
  subtitle?: string;
}

function safeOrigin(value: string | undefined, base?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base || 'http://same-origin.invalid');
    return url.origin === 'http://same-origin.invalid' ? 'same-origin' : url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Where the bytes on screen are coming from, as a bare origin.
 *
 * The stream origin, not the API one, and deliberately only one of them. They
 * are usually identical; when they diverge it is because a Direct Play
 * failover silently moved the transfer to another node while session
 * bookkeeping stayed put, and the origin serving the picture is the one worth
 * showing. That divergence still reads on the panel — the URL simply changes —
 * without spending a line on labels to announce a distinction that holds for
 * seconds at a time.
 *
 * Credentials never appear: `safeOrigin` reduces to scheme, host and port, so
 * a capability query string or embedded userinfo cannot reach the screen.
 */
function endpointDescription(session: PlaybackSession, activeStreamOrigin?: string): string | undefined {
  if (!session.endpoint) return undefined;
  return safeOrigin(activeStreamOrigin)
    ?? safeOrigin(session.source.url, session.endpoint.baseUrl)
    ?? safeOrigin(session.endpoint.baseUrl);
}

/**
 * Describe what the server says it is doing to each selected stream.
 *
 * Source and output metadata are both server-authoritative. The mode is the
 * resolved session mode; per-stream transform fields describe mixed cases such
 * as copied video with transcoded audio.
 */
export function describePlaybackSession(session?: PlaybackSession, activeStreamOrigin?: string): PlaybackStatusDescription | undefined {
  if (!session) return undefined;

  const video = selectedStream(session, 'video', session.selected.videoStream);
  const audio = selectedStream(session, 'audio', session.selected.audioStream);
  const subtitle = session.selected.subtitleStream >= 0
    ? selectedStream(session, 'subtitle', session.selected.subtitleStream)
    : undefined;
  const result: PlaybackStatusDescription = {
    endpoint: endpointDescription(session, activeStreamOrigin),
    container: servedContainer(session),
  };

  // When every selected stream is copied, no per-stream operation happened
  // that is worth naming per stream: the session as a whole is either the file
  // handed over untouched (DIRECT) or the same streams rewrapped in a new
  // container (REMUX). Saying "AUDIO COPY" for a direct hand-off describes an
  // operation the server never performed — it did not copy a stream anywhere,
  // it sent the file. The distinction is not pedantry: "copy" is what makes
  // remux and a copied-video transcode legible, and spending the word on
  // direct play too is what stopped it meaning anything.
  //
  // Per-stream labels therefore belong to the mixed cases, which is exactly
  // where the streams differ from one another and the reader needs telling
  // which is which.
  const streamCopiedOrAbsent = (transform: PlaybackTransform) => transform === 'copy' || transform === 'omit';
  const wholeSessionLabel = streamCopiedOrAbsent(session.transform.video)
    && streamCopiedOrAbsent(session.transform.audio)
    ? copyModeLabel(session)
    : undefined;

  if (video && session.transform.video !== 'omit') {
    const source = sourceVideoParts(session, video);
    const output = outputVideoParts(session);
    if (session.transform.video === 'transcode') {
      const sourceDescription = ['VIDEO TRANSCODE', 'SOURCE', ...source].join(' · ');
      result.video = output.length ? `${sourceDescription} → ${output.join(' · ')}` : sourceDescription;
    } else {
      result.video = [wholeSessionLabel ?? 'VIDEO COPY', ...source].join(' · ');
    }
  }

  if (audio && session.transform.audio !== 'omit') {
    const source = audioParts(audio);
    const output = outputAudioParts(session);
    if (session.transform.audio === 'transcode') {
      const sourceDescription = ['AUDIO TRANSCODE', 'SOURCE', ...source].join(' · ');
      result.audio = output.length ? `${sourceDescription} → ${output.join(' · ')}` : sourceDescription;
    } else {
      result.audio = [wholeSessionLabel ?? 'AUDIO COPY', ...source].join(' · ');
    }
  }

  if (subtitle) {
    result.subtitle = ['SUBTITLES', ...subtitleParts(subtitle)].join(' · ');
  }

  return result;
}
