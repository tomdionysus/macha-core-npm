import { DEFAULT_REQUEST_TIMEOUT_MS, mergeRequestHeaders, normalizeBaseUrl, queryString } from '../api/httpCompat.js';
import { MachaConnectionError } from '../api/serverConnection.js';
import { segmentContainer } from './choosePlaybackInstruction.js';
import type { PlaybackProduction } from './streamProtocol.js';
import { NO_AUTH, type AuthenticatedFetch } from '../api/SessionManager.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import { parseErrorEnvelope } from '../api/errorEnvelope.js';
import type { MediaSummary, PlaybackCapabilities, PlaybackMode, PlaybackSource } from '../types.js';
import type {
  PlaybackOptions,
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackSession,
  PlaybackStopOptions,
  PlaybackStreamInfo,
  PlaybackUpdate,
} from './PlaybackResolver.js';
import { machaHost } from '../runtime/host.js';

interface WireStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  profile: string;
  language: string;
  default: boolean;
  forced: boolean;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: number;
  bit_depth?: number;
  bitrate?: number;
  level?: number;
  color_transfer?: string;
  dolby_vision_profile?: number;
  dolby_vision_compatibility?: number;
}

interface WireOutputVideo {
  source_stream: number;
  transform: 'copy' | 'transcode' | 'omit';
  codec?: string;
  profile?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  bit_depth?: number;
  level?: number;
  color_transfer?: string;
}

interface WireOutputAudio {
  source_stream: number;
  transform: 'copy' | 'transcode' | 'omit';
  codec?: string;
  profile?: string;
  channels?: number;
  sample_rate?: number;
  bit_depth?: number;
  bitrate?: number;
}

interface WireSession {
  session_id: string;
  item_id?: string;
  media_id: string;
  mode: PlaybackMode;
  duration_ms: number;
  /**
   * Where the generation's media actually begins on the title's timeline —
   * the first sample the client receives.
   *
   * **Not necessarily the position that was asked for.** A remux generation
   * begins at the last keyframe at or before the request, because a stream
   * copy has no decoder and an fMP4 fragment's first sample must be a sync
   * sample. `seek_offset_ms` carries the remainder.
   */
  seek_ms: number;
  /**
   * How far into this generation the requested position sits. Server 0.46.0
   * and later; absent on an older node.
   *
   * `seek_ms + seek_offset_ms === seek_requested_ms`, exactly, in integer
   * milliseconds. Never negative, so a generation always contains the position
   * that was asked for and nothing between the request and the stream start
   * can go missing.
   *
   * Zero exactly when the mode can be frame-accurate: always for transcode and
   * direct, and for remux when the request already sits on a keyframe.
   */
  seek_offset_ms?: number;
  /**
   * The position the server honoured, after clamping to `[0, duration - 1ms]`.
   * Server 0.46.0 and later.
   *
   * **Present so a client can tell a clamp from a broken invariant.** Without
   * it, a sum that does not match the request is either a server fault or an
   * out-of-range request, and those want opposite handling — which makes the
   * check useless exactly at the end of a title, where it would otherwise
   * raise a false alarm every time.
   */
  seek_requested_ms?: number;
  preferences: {
    mode: PlaybackMode;
    max_height: number | null;
    max_bitrate: number | null;
    /** From server 0.57.1. */
    video_stream?: number | null;
    audio_stream: number | null;
    subtitle_stream: number | null;
    audio_language: string;
    subtitle_language: string;
  };
  selection: {
    video_stream: number;
    audio_stream: number;
    subtitle_stream: number;
  };
  source: {
    path: string;
    format: string;
    container?: string;
    size: number;
    bitrate: number;
    streams: WireStream[];
  };
  output: {
    format?: string;
    /**
     * The container actually served: `fmp4` or `mpegts` for HLS, the source
     * file's own container for a direct session. Never synthesise it from the
     * request — the request is what was asked for, and this is the one field
     * that says what arrived.
     */
    container?: string;
    bitrate?: number;
    video?: WireOutputVideo;
    audio?: WireOutputAudio;
  };
  stream: {
    url: string;
    mime_type: string;
    /**
     * How far past the last fragment requested the node will have produced —
     * `max_ahead_segments` x `segment_duration_ms`. Server 0.45.0 and later.
     *
     * Three states, and collapsing any two of them is a defect. **Absent**:
     * the node predates the field and cannot say. **`null`**: direct play,
     * which has no transcode pipeline and therefore no production frontier —
     * not the same claim as `0`. **A number**: the frontier, in milliseconds.
     */
    look_ahead_ms?: number | null;
    /**
     * How fast this generation is producing. Server 0.47.0 and later.
     *
     * **Absent for direct play, and absent on an older node** — no pipeline,
     * no rate. Absent means the node cannot say and never means zero.
     */
    production?: {
      /** Media produced, in media time. Also the production frontier. */
      produced_ms: number;
      /**
       * Encoder time spent producing it, **excluding time parked on the
       * look-ahead gate** and including everything else: demux, decode,
       * filter, encode, mux, disk, GPU and contention with another session.
       *
       * Measured from one `publish_segment` returning to the next being
       * entered, with the timestamp taken before the mutex is acquired, so
       * the parked interval falls outside the span structurally rather than
       * being subtracted from it.
       */
      producing_ms: number;
      /** How long since the last fragment published, measured on the node. */
      produced_age_ms: number;
      /** Whether the producer is blocked on the look-ahead gate. */
      producer_parked: boolean;
    };
    subtitle_url: string | null;
  };
  options: {
    modes: PlaybackMode[];
    quality_heights: number[];
    /** Removed in server 0.57.1: a session is bound to one file. */
    media_ids?: string[];
    audio_streams: WireStream[];
    subtitle_streams: WireStream[];
    can_seek: boolean;
    can_change_quality: boolean;
    /** Removed in server 0.57.1. */
    can_switch_media?: boolean;
  };
}

/**
 * How long core waits for a node to say whether a session still exists.
 *
 * Core's ordinary bound on a JSON API request, `DEFAULT_REQUEST_TIMEOUT_MS`,
 * because that is what this is: one small GET on the session route. Exported
 * because it sits in front of a failover: on a node that has genuinely gone,
 * it is the longest core waits before walking away, and a host budgeting a
 * recovery should be able to name it rather than find it.
 */
export const SESSION_LIVENESS_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;

export class MachaPlaybackError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly retryAfterMs?: number,
    /** Server-stated source failure reason; see `ParsedErrorEnvelope.reason`. */
    public readonly reason?: string,
    /**
     * The server's own sentence, without core's prefix.
     *
     * `message` is for a log: it says which layer is speaking, and by the time
     * a failure has crossed `endpointFailure` it says which node too. That is
     * the right shape for a trail and the wrong shape for a viewer, who gets
     * "Macha endpoint http://10.35.1.50:7438 failed: Macha playback request
     * failed: timed out waiting for first fragmented-MP4 segment" — two of
     * core's envelopes and an address. Three clients showed exactly that to
     * someone today, and one had written its own loop to strip prefixes until
     * none remained.
     *
     * Kept rather than reconstructed, because reconstructing means a client
     * matching on core's prefixes and going silent the next time one is
     * reworded. Read it through `playbackFailureDetail`.
     */
    public readonly detail?: string,
  ) {
    super(message);
  }

  /** From server 0.57.1: what has to be named; see `ParsedErrorEnvelope.choice`. */
  choice?: string;
  /** The candidates for `choice`: stream indexes, or container names. */
  choices?: Array<number | string>;
}

/** Server 0.57.1's code when a choice was left open. */
export const CHOICE_REQUIRED_CODE = 'choice_required';
/** Server 0.57.1's code when a choice names something the media lacks. */
export const CHOICE_NOT_AVAILABLE_CODE = 'choice_not_available';

/**
 * The preferences with an open choice answered by its first candidate, or
 * undefined when the error is not one core answers or the choice was already
 * answered once.
 */
function answeredChoice(
  error: unknown,
  sent: PlaybackPreferencesUpdate,
  capabilities: PlaybackCapabilities,
  answered: Set<string>,
): { preferences: PlaybackPreferencesUpdate; named: number | string } | undefined {
  if (!(error instanceof MachaPlaybackError) || error.code !== CHOICE_REQUIRED_CODE || !error.choice) return undefined;
  if (answered.has(error.choice)) return undefined;
  answered.add(error.choice);
  const first = error.choices?.[0];
  if (error.choice === 'container') {
    const container = segmentContainer(capabilities).container
      ?? (first === 'fmp4' || first === 'mpegts' ? first : undefined);
    if (!container) return undefined;
    return { preferences: { ...sent, container }, named: container };
  }
  if (typeof first !== 'number') return undefined;
  if (error.choice === 'video_stream') return { preferences: { ...sent, videoStream: first }, named: first };
  if (error.choice === 'audio_stream') return { preferences: { ...sent, audioStream: first }, named: first };
  return undefined;
}

function retryAfterMs(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(100, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(100, date - Date.now()) : 1_000;
}

export function newPlaybackIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Decided from the served MIME type, which is the server's own statement
 * about what it is handing over — not from the URL, whose extension is a
 * convention the server is free to change (0.32.12 turned `master.m3u8`
 * from a media playlist into a real master playlist without renaming it).
 */
const MANIFEST_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/dash+xml',
]);

export function isManifestMimeType(mimeType: string | undefined): boolean {
  return mimeType !== undefined && MANIFEST_MIME_TYPES.has(mimeType.split(';')[0].trim().toLowerCase());
}

/**
 * A container the server could not name arrives as `""`, not as an absent
 * key — six .avi files in the library report exactly that today. One shape
 * for "no answer" means consumers test one thing, and nothing downstream can
 * put an empty chip on screen.
 */
function reportedContainer(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Check the seek contract's invariant, once, for every client.
 *
 * `seek_ms + seek_offset_ms === seek_requested_ms`, exact integer milliseconds,
 * no tolerance. **This is the only place it is checked**, deliberately: every
 * client would otherwise write the same comparison, and a violation and an
 * ordinary clamp need opposite handling — a judgement no host should have to
 * duplicate. A client's job is to render what core reports.
 *
 * **A clamp cannot trip this.** Near the end of a title the server clamps the
 * request into `[0, duration - 1ms]` and reports the clamped value as
 * `seek_requested_ms`, so the sum still balances; the clamp shows up as
 * `seek_requested_ms` differing from what was *asked for*, which is a different
 * comparison and not a fault. That is precisely why the field exists, and
 * without it this check would raise a false alarm every time a viewer seeked
 * near the end.
 *
 * **Reported and never acted on.** Nothing here rejects a generation or
 * triggers a renegotiation. A violated invariant means the node's `seek_ms`
 * cannot be trusted, and asking the same node again is the least likely thing
 * to produce a better answer — that path livelocked once already, 147
 * negotiations in 33.3 s against an answer that never changed. Core carries on
 * with what it was given and says loudly that it did.
 */
function checkSeekInvariant(
  wire: WireSession,
  log: ReturnType<typeof createClientLogger>,
): void {
  const { seek_ms: seekMs, seek_offset_ms: offsetMs, seek_requested_ms: requestedMs } = wire;
  // Absent means the node predates 0.46.0 and cannot say. Nothing is wrong,
  // and nothing is *checked* either — which used to be indistinguishable from
  // a check that passed, since both produced silence. A client reading a
  // capture then has three readings to separate and only two records: the
  // node's arithmetic is wrong (the report below), the invariant held, or it
  // could never be tested. Recorded at `debug`, because an old node in a
  // mixed-version set is ordinary and this must not reach a failure screen.
  if (offsetMs === undefined || requestedMs === undefined) {
    log.debug('seek-invariant-not-stated', {
      sessionId: wire.session_id,
      mode: wire.mode,
      seekMs,
      // Which field is missing, because a node stating one and not the other
      // is a different fault from a node too old to state either.
      seekOffsetMs: offsetMs,
      seekRequestedMs: requestedMs,
    });
    return;
  }
  if (seekMs + offsetMs === requestedMs) return;
  log.error('seek-invariant-violated', {
    sessionId: wire.session_id,
    mode: wire.mode,
    seekMs,
    seekOffsetMs: offsetMs,
    seekRequestedMs: requestedMs,
    // The size and sign of the discrepancy is what tells a wrong baseline from
    // a wrong offset, and it is the first thing anyone reading this will want.
    differenceMs: requestedMs - (seekMs + offsetMs),
  });
}

function mapStream(stream: WireStream): PlaybackStreamInfo {
  return {
    index: stream.index,
    type: stream.type,
    codec: stream.codec,
    profile: stream.profile,
    language: stream.language,
    default: stream.default,
    forced: stream.forced,
    width: stream.width,
    height: stream.height,
    channels: stream.channels,
    sampleRate: stream.sample_rate,
    bitDepth: stream.bit_depth,
    bitrate: stream.bitrate,
    level: stream.level,
    colorTransfer: stream.color_transfer,
    dolbyVisionProfile: stream.dolby_vision_profile,
    dolbyVisionCompatibility: stream.dolby_vision_compatibility,
  };
}

/**
 * Session creation must state a mode. There is no server-side default and no
 * `auto` to fall back on, so a missing one is a caller bug — and a silent
 * fallback here would be the worst of both: `transcode` would quietly cost
 * every viewer quality, `direct` would quietly hand a TV a stream it cannot
 * decode. Failing loudly is the only option that cannot ship undetected.
 */
function requiredMode(mode: PlaybackMode | 'choose' | undefined): PlaybackMode {
  if (mode === 'choose') {
    throw new MachaPlaybackError(
      "'choose' is a client-side sentinel and is not a playback mode. Resolve it with choosePlaybackInstruction "
      + '(PlaybackCoordinator does this for you) before creating a session.',
      undefined,
      'mode_required',
    );
  }
  if (mode === undefined) {
    throw new MachaPlaybackError(
      'Playback session creation requires an explicit mode. Use choosePlaybackInstruction(profile, capabilities) '
      + 'to derive one from the source facts, or pass the viewer\'s chosen mode.',
      undefined,
      'mode_required',
    );
  }
  return mode;
}

/**
 * Resolve the one contradiction the server rejects outright.
 *
 * A copy instruction cannot be combined with `max_height` or `max_bitrate`:
 * copying is passing the encoded stream through untouched, so there is no
 * step at which a cap could be applied, and the server returns 400 rather
 * than silently ignoring one of them. Asking to cap quality is asking to
 * re-encode, so the cap wins and the video is transcoded.
 *
 * Resolved here rather than left to each caller because the two halves
 * usually come from different places — the cap from a viewer's quality
 * picker, the copy from `choosePlaybackInstruction` — so neither author sees
 * the contradiction they are creating.
 */
export function reconcileQualityCaps(preferences: PlaybackPreferencesUpdate): PlaybackPreferencesUpdate {
  const capped = (preferences.maxHeight ?? null) !== null || (preferences.maxBitrate ?? null) !== null;
  if (!capped) return preferences;
  if (preferences.video !== 'copy' && preferences.mode !== 'direct') return preferences;
  if (preferences.mode === 'choose') return preferences;
  return {
    ...preferences,
    video: 'transcode',
    mode: preferences.mode === 'direct' ? 'transcode' : preferences.mode,
  };
}

function wirePreferences(preferences?: PlaybackPreferencesUpdate): Record<string, unknown> | undefined {
  if (!preferences) return undefined;
  const out: Record<string, unknown> = {};
  if (preferences.mode !== undefined) out.mode = preferences.mode;
  if (preferences.maxHeight !== undefined) out.max_height = preferences.maxHeight;
  if (preferences.maxBitrate !== undefined) out.max_bitrate = preferences.maxBitrate;
  if (preferences.videoStream !== undefined) out.video_stream = preferences.videoStream;
  if (preferences.audioStream !== undefined) out.audio_stream = preferences.audioStream;
  if (preferences.subtitleStream !== undefined) out.subtitle_stream = preferences.subtitleStream;
  if (preferences.audioLanguage !== undefined) out.audio_language = preferences.audioLanguage;
  if (preferences.subtitleLanguage !== undefined) out.subtitle_language = preferences.subtitleLanguage;
  if (preferences.video !== undefined) out.video = preferences.video;
  if (preferences.audio !== undefined) out.audio = preferences.audio;
  if (preferences.container !== undefined) out.container = preferences.container;
  return out;
}

/**
 * The wire block, mapped, with every field required rather than optional.
 *
 * A partial block is dropped whole instead of being filled in: a rate built
 * from a present `produced_ms` and a missing `producing_ms` would be a number
 * nobody sent, and `production` is documented as absent-means-cannot-say, so
 * dropping it lands in a branch every consumer already has to handle.
 */
function productionFromWire(wire: {
  produced_ms: number;
  producing_ms: number;
  produced_age_ms: number;
  producer_parked: boolean;
} | undefined): PlaybackProduction | undefined {
  if (!wire) return undefined;
  const { produced_ms: producedMs, producing_ms: producingMs, produced_age_ms: producedAgeMs } = wire;
  if (typeof producedMs !== 'number' || typeof producingMs !== 'number' || typeof producedAgeMs !== 'number') {
    return undefined;
  }
  return { producedMs, producingMs, producedAgeMs, producerParked: wire.producer_parked === true };
}

export class MachaPlaybackResolver implements PlaybackResolver {
  readonly available = true;
  private readonly baseUrl: string;
  private readonly log = createClientLogger('playback.api');
  private requestSequence = 0;

  constructor(
    baseUrl: string,
    private readonly auth: AuthenticatedFetch = NO_AUTH,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /**
   * `capabilities` no longer goes on the wire. The server never acted on it,
   * so asking implied a check that did not exist; how to play the media is
   * the client's problem, and `choosePlaybackInstruction` is where that
   * problem is solved. The parameter stays because it is part of the
   * `PlaybackResolver` seam — a decorating resolver (an offline or local-file
   * one) legitimately needs to know what the host can decode — and because
   * it is worth having in the diagnostics beside the instruction it produced.
   */
  async resolve(
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs?: number,
    preferences?: PlaybackPreferencesUpdate,
    signal?: AbortSignal,
    idempotencyKey = newPlaybackIdempotencyKey(),
  ): Promise<PlaybackSession> {
    this.log.info('session-create', {
      mediaId: media.id,
      mediaKind: media.kind,
      platform: capabilities.platform,
      containers: capabilities.containers.join(', '),
      videoCodecs: capabilities.videoCodecs.join(', '),
      audioCodecs: capabilities.audioCodecs.join(', '),
      hlsFmp4: capabilities.hlsFmp4,
      hlsTs: capabilities.hlsTs ?? false,
      maxWidth: capabilities.maxWidth ?? 'none',
      maxHeight: capabilities.maxHeight ?? 'none',
      hdr: capabilities.hdr.length > 0 ? capabilities.hdr.join(', ') : 'not-advertised',
      seekMs: seekMs ?? 0,
      requestedPreferences: preferences,
    });
    // No item_id: from server 0.57.1 a title is not playable as such, its
    // files are, and naming the item is refused (item_id_not_accepted). A
    // 0.57.0 node plays the named media_id and needs no item either.
    const mode = requiredMode(preferences?.mode);
    // From 0.57.1 a remux or transcode names its segment container; the node
    // no longer defaults to fMP4. The coordinator always names one; a host
    // driving this directly gets the device's own preference.
    const container = preferences?.container
      ?? (mode === 'remux' || mode === 'transcode' ? segmentContainer(capabilities).container : undefined);
    let sent: PlaybackPreferencesUpdate = { ...preferences, mode, ...(container ? { container } : {}) };
    let key = idempotencyKey;
    // A choice the node refuses to make (0.57.1) is made here, once per kind:
    // the first candidate it lists. The coordinator names streams from the
    // facts before asking, so this is the safety net for a host driving the
    // resolver directly, or a start with no facts. Logged, because a host
    // should choose.
    const answered = new Set<string>();
    for (;;) {
      const body: Record<string, unknown> = { preferences: wirePreferences(reconcileQualityCaps(sent)) };
      if (seekMs !== undefined) body.seek_ms = Math.max(0, Math.round(seekMs));
      // The file the client chose. With it the node plays exactly that file.
      if (sent.mediaId) {
        body.media_id = sent.mediaId;
      } else if (media.mediaIds.length > 0) {
        // A caller that chose no file, such as a host driving the resolver
        // directly. The server chooses nothing, so name the first rather than
        // fail; loudly, because a host should choose (see `chooseAmongFiles`).
        body.media_id = media.mediaIds[0];
        if (media.mediaIds.length > 1) this.log.warn('media-unchosen-defaulted', { itemId: media.id, mediaId: media.mediaIds[0], files: media.mediaIds.length });
      }
      // Session admission deliberately has no profile preflight: immutable
      // profiles are advisory metadata and must not enter the viewer's critical
      // path. A non-conforming server response is surfaced immediately so the
      // cluster resolver can recover on another endpoint rather than polling it.
      try {
        const wire = await this.request<WireSession>(
          `/api/v1/playback/sessions?${queryString([['idempotency_key', key]])}`,
          {
            method: 'POST',
            body: JSON.stringify(body),
            signal,
          },
        );
        const session = this.mapSession(wire);
        this.log.info('session-created', this.sessionSummary(session));
        return session;
      } catch (error) {
        const next = answeredChoice(error, sent, capabilities, answered);
        if (!next) throw error;
        this.log.warn('stream-unchosen-defaulted', { itemId: media.id, choice: (error as MachaPlaybackError).choice, named: next.named });
        sent = next.preferences;
        // A refused create made nothing, so the retry is a new request.
        key = newPlaybackIdempotencyKey();
      }
    }
  }

  async update(sessionId: string, update: PlaybackUpdate, signal?: AbortSignal): Promise<PlaybackSession> {
    this.log.info('session-update', { sessionId, update });
    const body: Record<string, unknown> = {};
    const preferences = wirePreferences(update.preferences);
    if (preferences) body.preferences = preferences;
    if (update.seekMs !== undefined) body.seek_ms = Math.max(0, Math.round(update.seekMs));
    if (update.mediaId !== undefined) body.media_id = update.mediaId;
    const session = this.mapSession(await this.request<WireSession>(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      signal,
    }));
    this.log.info('session-updated', this.sessionSummary(session));
    return session;
  }

  async stop(sessionId: string, options: PlaybackStopOptions = {}): Promise<void> {
    this.log.info('session-stop', { sessionId, keepalive: options.keepalive ?? false });
    try {
      await this.request<void>(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        keepalive: options.keepalive,
      });
      this.log.info('session-stopped', { sessionId, keepalive: options.keepalive ?? false });
    } catch (error) {
      // Session expiry and explicit cleanup are equivalent from the client's point of view.
      if (error instanceof MachaPlaybackError && error.status === 404) {
        this.log.debug('session-stop-already-gone', { sessionId });
        return;
      }
      this.log.error('session-stop-failed', { sessionId, error });
      throw error;
    }
  }

  /**
   * Whether this node still holds the session — the one question that tells a
   * `404` on a fragment apart from a `404` on the plan.
   *
   * Both answer `404 not_found` and nothing in either body distinguishes them,
   * so the fragment's own status is not enough and neither is its body, which
   * in any case does not survive most fragment loaders. Asking the session
   * route does distinguish them, decisively, in one request.
   *
   * **Not a keepalive.** It runs when something has already gone wrong, never
   * on a timer. Polling a paused session would hold it open, and the transcode
   * entitlement belongs to the session rather than the pipeline — a viewer who
   * paused and walked away would pin the node's only video transcode slot for
   * as long as the tab stayed open. See `SERVER_SESSION_IDLE_MS`.
   *
   * A `404` is the answer, not an error: it resolves `false` and the caller is
   * expected to act on it. Anything else — unreachable, 5xx, a refused token —
   * throws, because "I could not find out" must not be mistaken for "it is
   * gone". Acting on the difference is what stops a node being condemned for
   * answering honestly.
   */
  /**
   * The session as the node describes it now, or undefined when the node no
   * longer holds it. Bounded like `sessionAlive`, and for the same reason.
   */
  async read(sessionId: string): Promise<PlaybackSession | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_LIVENESS_TIMEOUT_MS);
    try {
      const wire = await this.request<WireSession>(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      return this.mapSession(wire);
    } catch (error) {
      if (error instanceof MachaPlaybackError && error.status === 404) return undefined;
      if (controller.signal.aborted) {
        throw new MachaConnectionError(`Session ${sessionId} unanswered within ${SESSION_LIVENESS_TIMEOUT_MS} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async sessionAlive(sessionId: string): Promise<boolean> {
    // Bounded, because nothing below this was. The request went through the
    // host's plain fetch with no signal, so a node that had dropped off the
    // network -- packets lost rather than refused -- held the question for as
    // long as the platform lets a connection hang. It sits in front of a
    // failover now, so that wait would be the viewer's.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_LIVENESS_TIMEOUT_MS);
    try {
      await this.request<WireSession>(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      this.log.debug('session-alive', { sessionId });
      return true;
    } catch (error) {
      if (error instanceof MachaPlaybackError && error.status === 404) {
        this.log.info('session-gone', { sessionId });
        return false;
      }
      // A typed timeout rather than the abort: "could not find out", which the
      // caller already treats as no answer, never as the session being gone.
      if (controller.signal.aborted) {
        throw new MachaConnectionError(`Session ${sessionId} liveness unanswered within ${SESSION_LIVENESS_TIMEOUT_MS} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapSession(wire: WireSession): PlaybackSession {
    checkSeekInvariant(wire, this.log);
    const options: PlaybackOptions = {
      // Direct is an explicit user override, not a capability-derived offer.
      // Always expose it alongside the server-derived Remux/Transcode choices.
      modes: ['direct', ...wire.options.modes.filter((mode) => mode !== 'direct')],
      qualityHeights: wire.options.quality_heights,
      mediaIds: wire.options.media_ids ?? [],
      audioStreams: wire.options.audio_streams.map(mapStream),
      subtitleStreams: wire.options.subtitle_streams.map(mapStream),
      canSeek: wire.options.can_seek,
      canChangeQuality: wire.options.can_change_quality,
      canSwitchMedia: wire.options.can_switch_media ?? false,
    };
    const source: PlaybackSource = {
      mediaId: wire.media_id,
      url: this.streamUrl(wire.stream.url),
      subtitleUrl: wire.stream.subtitle_url ? this.streamUrl(wire.stream.subtitle_url) : undefined,
      mimeType: wire.stream.mime_type,
      isManifest: isManifestMimeType(wire.stream.mime_type),
      mode: wire.mode,
      durationMs: wire.duration_ms,
      sizeBytes: wire.source.size,
    };
    return {
      sessionId: wire.session_id,
      endpoint: { id: this.baseUrl || 'same-origin', baseUrl: this.baseUrl },
      itemId: wire.item_id,
      mediaId: wire.media_id,
      mode: wire.mode,
      mimeType: wire.stream.mime_type,
      source,
      lookAheadMs: wire.stream.look_ahead_ms,
      production: productionFromWire(wire.stream.production),
      seekOffsetMs: wire.seek_offset_ms,
      seekRequestedMs: wire.seek_requested_ms,
      durationMs: wire.duration_ms,
      seekMs: wire.seek_ms,
      preferences: {
        mode: wire.preferences.mode,
        maxHeight: wire.preferences.max_height,
        maxBitrate: wire.preferences.max_bitrate,
        videoStream: wire.preferences.video_stream ?? null,
        audioStream: wire.preferences.audio_stream,
        subtitleStream: wire.preferences.subtitle_stream,
        audioLanguage: wire.preferences.audio_language,
        subtitleLanguage: wire.preferences.subtitle_language,
      },
      sourceInfo: {
        path: wire.source.path,
        format: wire.source.format,
        container: reportedContainer(wire.source.container),
        size: wire.source.size,
        bitrate: wire.source.bitrate,
        streams: wire.source.streams.map(mapStream),
      },
      output: {
        format: wire.output.format,
        container: reportedContainer(wire.output.container),
        bitrate: wire.output.bitrate,
        video: wire.output.video ? {
          sourceStream: wire.output.video.source_stream,
          transform: wire.output.video.transform,
          codec: wire.output.video.codec,
          profile: wire.output.video.profile,
          width: wire.output.video.width,
          height: wire.output.video.height,
          bitrate: wire.output.video.bitrate,
          bitDepth: wire.output.video.bit_depth,
          level: wire.output.video.level,
          colorTransfer: wire.output.video.color_transfer,
        } : undefined,
        audio: wire.output.audio ? {
          sourceStream: wire.output.audio.source_stream,
          transform: wire.output.audio.transform,
          codec: wire.output.audio.codec,
          profile: wire.output.audio.profile,
          channels: wire.output.audio.channels,
          sampleRate: wire.output.audio.sample_rate,
          bitDepth: wire.output.audio.bit_depth,
          bitrate: wire.output.audio.bitrate,
        } : undefined,
      },
      selected: {
        videoStream: wire.selection.video_stream,
        audioStream: wire.selection.audio_stream,
        subtitleStream: wire.selection.subtitle_stream,
      },
      transform: {
        video: wire.output.video?.transform ?? 'omit',
        audio: wire.output.audio?.transform ?? 'omit',
      },
      options,
    };
  }

  private sessionSummary(session: PlaybackSession): Record<string, unknown> {
    return {
      sessionId: session.sessionId,
      itemId: session.itemId,
      mediaId: session.mediaId,
      mode: session.mode,
      mimeType: session.mimeType,
      durationMs: session.durationMs,
      seekMs: session.seekMs,
      preferenceMode: session.preferences.mode,
      sourceFormat: session.sourceInfo.format,
      sourceBitrate: session.sourceInfo.bitrate,
      sourceUrl: session.source.url,
      subtitleUrl: session.source.subtitleUrl,
      selected: session.selected,
      transform: session.transform,
      options: {
        modes: session.options.modes,
        canSeek: session.options.canSeek,
        canChangeQuality: session.options.canChangeQuality,
        canSwitchMedia: session.options.canSwitchMedia,
      },
    };
  }

  private streamUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (this.baseUrl) return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    // No configured node base: the same-origin deployment, where the client
    // is served by the node that issued this path. A host with no origin at
    // all (React Native) never reaches here, because it always talks to an
    // explicit endpoint — and if it somehow did, a relative stream URL would
    // fail later, somewhere with no evidence of why.
    const origin = machaHost().origin;
    if (origin) return new URL(path, origin).toString();
    throw new Error(`Cannot absolutize the stream URL "${path}": no node base URL and no host origin.`);
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const requestId = ++this.requestSequence;
    const method = init.method ?? 'GET';
    const started = machaHost().now();
    const headers = mergeRequestHeaders(init.headers, {
      Accept: 'application/json',
      'Content-Type': init.body !== undefined ? 'application/json' : undefined,
    });
    this.log.debug('http-request', { requestId, method, path, body: this.parseRequestBody(init.body) });
    try {
      const response = await this.auth.fetch(`${this.baseUrl}${path}`, { ...init, headers });
      const elapsedMs = Math.round((machaHost().now() - started) * 10) / 10;
      this.log.debug('http-response', {
        requestId,
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        elapsedMs,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        retryAfter: response.headers.get('retry-after'),
      });
      if (!response.ok) await this.throwResponseError(response, { requestId, method, path, elapsedMs });
      if (response.status === 204) return undefined as T;
      const body = await response.json() as unknown;
      if (response.status === 202) {
        const parsed = parseErrorEnvelope(body, 'Playback profile is pending.');
        if (parsed.code === 'profile_pending') {
          throw new MachaPlaybackError(
            `Macha playback request pending: ${parsed.message}`,
            response.status,
            parsed.code,
            retryAfterMs(response.headers.get('retry-after')),
          );
        }
      }
      return body as T;
    } catch (error) {
      if (!(error instanceof MachaPlaybackError)
        && !(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')) {
        this.log.error('http-failed', {
          requestId,
          method,
          path,
          elapsedMs: Math.round((machaHost().now() - started) * 10) / 10,
          error,
        });
      }
      throw error;
    }
  }

  private parseRequestBody(body: BodyInit | null | undefined): unknown {
    if (typeof body !== 'string') return body === undefined || body === null ? undefined : '<non-string-body>';
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }

  private async throwResponseError(
    response: Response,
    request: { requestId: number; method: string; path: string; elapsedMs: number },
  ): Promise<never> {
    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      // Keep the HTTP status if the response is not JSON.
    }
    const parsed = parseErrorEnvelope(body, `${response.status} ${response.statusText}`);
    this.log.error('http-error-response', {
      ...request,
      status: response.status,
      statusText: response.statusText,
      body,
    });
    const error = new MachaPlaybackError(
      `Macha playback request failed: ${parsed.message}`,
      response.status,
      parsed.code,
      retryAfterMs(response.headers.get('retry-after')),
      parsed.reason,
      parsed.detail,
    );
    if (parsed.choice) error.choice = parsed.choice;
    if (parsed.choices) error.choices = parsed.choices;
    throw error;
  }
}
