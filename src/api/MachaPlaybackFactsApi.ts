import { mergeRequestHeaders, normalizeBaseUrl, queryString, readResponseBody } from './httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import { MachaApiError } from './MachaCatalogueApi.js';
import type { MediaTechnicalProfile, MediaTechnicalStream } from '../types.js';
import type { PlaybackFactsApi, PlaybackMediaFacts, PlaybackOperations } from './PlaybackFactsApi.js';

interface WireFactsStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  profile?: string;
  language?: string;
  default?: boolean;
  forced?: boolean;
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

function mapStream(stream: WireFactsStream): MediaTechnicalStream {
  return {
    index: stream.index,
    type: stream.type,
    codec: stream.codec,
    profile: stream.profile ?? '',
    language: stream.language ?? '',
    default: stream.default ?? false,
    forced: stream.forced ?? false,
    width: stream.width || undefined,
    height: stream.height || undefined,
    channels: stream.channels || undefined,
    sampleRate: stream.sample_rate || undefined,
    bitDepth: stream.bit_depth || undefined,
    bitrate: stream.bitrate || undefined,
    level: stream.level || undefined,
    colorTransfer: stream.color_transfer || undefined,
    dolbyVisionProfile: stream.dolby_vision_profile,
    dolbyVisionCompatibility: stream.dolby_vision_compatibility,
  };
}

function streamPair(field: unknown): { video: boolean; audio: boolean } {
  const pair = (field && typeof field === 'object' ? field : {}) as Record<string, unknown>;
  return { video: pair.video === true, audio: pair.audio === true };
}

function mapOperations(value: unknown): PlaybackOperations {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  // Absent reads as "cannot", not "can". This gates instructions, so an
  // unknown answer must never be optimistic — the whole point is to stop
  // asking for something the node will refuse.
  return {
    direct: record.direct === true,
    copyIntoFmp4: streamPair(record.copy_into_fmp4),
    copyIntoMpegts: streamPair(record.copy_into_mpegts),
    transcodeVideo: record.transcode_video === true,
    transcodeAudio: record.transcode_audio === true,
  };
}

export class MachaPlaybackFactsApi implements PlaybackFactsApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly auth: AuthenticatedFetch = NO_AUTH) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async facts(ref: { itemId?: string; mediaId?: string }, signal?: AbortSignal): Promise<PlaybackMediaFacts[]> {
    const query = queryString([
      ['item_id', ref.itemId],
      ['media_id', ref.mediaId],
    ]);
    if (!query) throw new MachaApiError('Playback facts need an item id or a media id.', 400, 'invalid_request');

    const response = await this.auth.fetch(`${this.baseUrl}/api/v1/playback/media?${query}`, {
      method: 'GET',
      headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }),
      signal,
    });
    const { body } = await readResponseBody(response);
    if (!response.ok) {
      const parsed = parseErrorEnvelope(body, `${response.status} ${response.statusText}`);
      throw new MachaApiError(`Macha playback facts failed: ${parsed.message}`, response.status, parsed.code, parsed.detail);
    }

    const record = body as { item_id?: string; media?: unknown[] } | undefined;
    const media = Array.isArray(record?.media) ? record.media : [];
    return media.flatMap((entry) => {
      const item = entry as Record<string, unknown>;
      const mediaId = typeof item.media_id === 'string' ? item.media_id : undefined;
      if (!mediaId) return [];
      const streams = Array.isArray(item.streams) ? item.streams as WireFactsStream[] : [];
      const profile: MediaTechnicalProfile = {
        mediaId,
        format: typeof item.format === 'string' ? item.format : '',
        // `""` is the server's answer for a container it cannot name — an
        // absent value, not a value. Normalised here so one shape reaches
        // every consumer.
        container: (typeof item.container === 'string' ? item.container.trim() : '') || undefined,
        durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : 0,
        bitrate: typeof item.bitrate === 'number' ? item.bitrate : 0,
        sizeBytes: typeof item.size === 'number' ? item.size : undefined,
        streams: streams.map(mapStream),
      };
      return [{
        mediaId,
        itemId: typeof record?.item_id === 'string' ? record.item_id : undefined,
        path: typeof item.path === 'string' ? item.path : undefined,
        sizeBytes: profile.sizeBytes,
        profile,
        operations: mapOperations(item.operations),
      }];
    });
  }
}
