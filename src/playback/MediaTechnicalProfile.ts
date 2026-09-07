import type { CatalogueMediaProfile } from '../api/CatalogueApi.js';
import type { MediaTechnicalProfile, MediaTechnicalStream } from '../types.js';
import type { PlaybackSession, PlaybackStreamInfo } from './PlaybackResolver.js';

function normalizedStream(stream: CatalogueMediaProfile['streams'][number] | PlaybackStreamInfo): MediaTechnicalStream {
  return {
    index: stream.index,
    type: stream.type,
    codec: stream.codec,
    profile: stream.profile,
    language: stream.language,
    width: stream.width || undefined,
    height: stream.height || undefined,
    channels: stream.channels || undefined,
    sampleRate: 'sample_rate' in stream ? stream.sample_rate || undefined : stream.sampleRate,
    bitDepth: 'bit_depth' in stream ? stream.bit_depth || undefined : stream.bitDepth,
    bitrate: stream.bitrate || undefined,
    default: stream.default,
    forced: stream.forced,
  };
}

export function technicalProfileFromCatalogue(profile: CatalogueMediaProfile): MediaTechnicalProfile {
  return {
    mediaId: profile.media_id,
    format: profile.format,
    durationMs: profile.duration_ms,
    bitrate: profile.bitrate,
    streams: profile.streams.map(normalizedStream),
  };
}

export function technicalProfileFromSession(session: PlaybackSession): MediaTechnicalProfile {
  return {
    mediaId: session.mediaId,
    format: session.sourceInfo.format,
    durationMs: session.durationMs,
    bitrate: session.sourceInfo.bitrate,
    sizeBytes: session.sourceInfo.size,
    streams: session.sourceInfo.streams.map(normalizedStream),
    negotiated: {
      mode: session.mode,
      mimeType: session.mimeType,
      format: session.output.format,
    },
  };
}
