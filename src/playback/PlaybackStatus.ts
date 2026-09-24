import { canonicalContainers } from './choosePlaybackInstruction.js';
import type {
  PlaybackOutputAudioInfo,
  PlaybackOutputVideoInfo,
  PlaybackSession,
  PlaybackStreamInfo,
  PlaybackTransform,
} from './PlaybackResolver.js';

/**
 * The container actually served, as the server named it, lower-cased: for
 * example `fmp4`, `mpegts`, or a source container such as `matroska` for a
 * direct session.
 *
 * Only ever from what the server says it produced — `output.container`, or
 * `output.format` where the node could not name a container. Never from the
 * request: synthesising it there would put the thing we asked for on screen
 * wearing the clothes of the thing we got, and the entire value of this field
 * is telling those two apart — a segment-container preference that the node
 * quietly ignored looks identical to one it honoured until something reports
 * back. Absent means absent, never a default.
 */
function servedContainer(session: PlaybackSession): string | undefined {
  // `output.format` is the fallback, not a default: it is still the server
  // describing what it produced, and it is the only answer for a direct
  // session whose container the server could not name — the six .avi files
  // report `container: ""` with `format: "avi"`. If that is fixed server-side
  // the fallback simply stops being reached.
  const container = session.output.container?.trim() || session.output.format?.trim();
  return container ? container.toLowerCase() : undefined;
}

function selectedStream(session: PlaybackSession, type: 'video' | 'audio' | 'subtitle', index: number): PlaybackStreamInfo | undefined {
  return session.sourceInfo.streams.find((stream) => stream.type === type && stream.index === index);
}

/**
 * How a session whose selected streams are all copied reached the viewer:
 * `direct`, the file handed over, or `remux`, the same streams rewrapped.
 */
export type PlaybackDelivery = 'direct' | 'remux';

/**
 * Direct or remux, from what was served rather than what was asked for.
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
 * letting the readout lie quietly. Nothing reachable from a session object is
 * truly independent of the server; this is the field that cannot be wrong on
 * its own.
 *
 * For anything handed over whole, `output.container` decides: same container
 * as the source is a direct hand-off, a different one was repackaged. Falls
 * back to the session mode for nodes that do not report the field, which is
 * the requested mode and was the only thing available before 0.33.1.
 */
function copyDelivery(session: PlaybackSession): PlaybackDelivery {
  if (session.source.isManifest) return 'remux';
  const served = session.output.container?.trim().toLowerCase();
  if (!served) return session.mode === 'direct' ? 'direct' : 'remux';
  const source = session.sourceInfo.container ?? session.sourceInfo.format;
  const sourceFamily = canonicalContainers(source);
  const servedFamily = canonicalContainers(served);
  const unchanged = sourceFamily !== undefined && sourceFamily === servedFamily;
  return unchanged ? 'direct' : 'remux';
}

/**
 * What the server says it is doing to each selected stream, as data. Core
 * writes no viewer text (Tom, 2026-09-24): a host formats every field.
 */
export interface PlaybackStatusDescription {
  /** The origin serving the picture: scheme, host and port only, or `same-origin`. */
  endpoint?: string;
  /** See `servedContainer`. Undefined when the node did not report one. */
  container?: string;
  /**
   * Set when every selected stream is copied, and then the session as a whole
   * is the thing to name, not each stream. Undefined when anything is
   * transcoded; the per-stream `transform` says which.
   */
  delivery?: PlaybackDelivery;
  video?: {
    transform: PlaybackTransform;
    source: PlaybackStreamInfo;
    /** The whole source's bitrate, for a video stream that states none of its own. */
    sourceBitrate?: number;
    /** Present for a transcode where the server reported what it produces. */
    output?: PlaybackOutputVideoInfo;
    /** The whole output's bitrate, where the video output states none of its own. */
    outputBitrate?: number;
  };
  audio?: {
    transform: PlaybackTransform;
    source: PlaybackStreamInfo;
    output?: PlaybackOutputAudioInfo;
  };
  /** The selected subtitle stream, only when subtitles are enabled. */
  subtitle?: PlaybackStreamInfo;
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
 * reporting.
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
 * Source and output metadata are both server-authoritative. The per-stream
 * transform fields describe mixed cases such as copied video with transcoded
 * audio; `delivery` describes the case where nothing was transcoded.
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
  // handed over untouched or the same streams rewrapped in a new container.
  // Calling a direct hand-off a stream copy describes an operation the server
  // never performed — it did not copy a stream anywhere, it sent the file.
  const copiedOrAbsent = (transform: PlaybackTransform) => transform === 'copy' || transform === 'omit';
  if (copiedOrAbsent(session.transform.video) && copiedOrAbsent(session.transform.audio)) {
    result.delivery = copyDelivery(session);
  }

  if (video && session.transform.video !== 'omit') {
    result.video = {
      transform: session.transform.video,
      source: video,
      sourceBitrate: session.sourceInfo.bitrate || undefined,
      output: session.transform.video === 'transcode' ? session.output.video : undefined,
      outputBitrate: session.output.bitrate,
    };
  }

  if (audio && session.transform.audio !== 'omit') {
    result.audio = {
      transform: session.transform.audio,
      source: audio,
      output: session.transform.audio === 'transcode' ? session.output.audio : undefined,
    };
  }

  if (subtitle) result.subtitle = subtitle;

  return result;
}
