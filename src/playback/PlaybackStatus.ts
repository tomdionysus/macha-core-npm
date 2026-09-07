import type { PlaybackSession, PlaybackStreamInfo } from './PlaybackResolver.js';

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

function copyModeLabel(session: PlaybackSession): string {
  return session.mode === 'direct' ? 'DIRECT' : 'REMUX';
}

export interface PlaybackStatusDescription {
  endpoint?: string;
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

function endpointDescription(session: PlaybackSession, activeStreamOrigin?: string): string | undefined {
  if (!session.endpoint) return undefined;
  const apiOrigin = safeOrigin(session.endpoint?.baseUrl);
  const streamOrigin = safeOrigin(activeStreamOrigin) ?? safeOrigin(session.source.url, session.endpoint?.baseUrl);
  const endpointId = session.endpoint?.id;
  const endpointIdOrigin = safeOrigin(endpointId);
  const node = endpointId && endpointIdOrigin !== apiOrigin ? endpointId : undefined;
  if (!node && apiOrigin && apiOrigin === streamOrigin) return `NODE/STREAM ${apiOrigin}`;
  const parts: string[] = [];
  if (node) parts.push(`NODE ${node}`);
  if (apiOrigin) parts.push(`API ${apiOrigin}`);
  if (streamOrigin) parts.push(`STREAM ${streamOrigin}`);
  return parts.join(' · ') || undefined;
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
  const result: PlaybackStatusDescription = { endpoint: endpointDescription(session, activeStreamOrigin) };

  if (video && session.transform.video !== 'omit') {
    const source = sourceVideoParts(session, video);
    const output = outputVideoParts(session);
    if (session.transform.video === 'transcode') {
      const sourceDescription = ['VIDEO TRANSCODE', 'SOURCE', ...source].join(' · ');
      result.video = output.length ? `${sourceDescription} → ${output.join(' · ')}` : sourceDescription;
    } else if (session.transform.audio === 'copy') {
      result.video = [copyModeLabel(session), ...source].join(' · ');
    } else {
      result.video = ['VIDEO COPY', ...source].join(' · ');
    }
  }

  if (audio && session.transform.audio !== 'omit') {
    const source = audioParts(audio);
    const output = outputAudioParts(session);
    if (session.transform.audio === 'transcode') {
      const sourceDescription = ['AUDIO TRANSCODE', 'SOURCE', ...source].join(' · ');
      result.audio = output.length ? `${sourceDescription} → ${output.join(' · ')}` : sourceDescription;
    } else {
      result.audio = ['AUDIO COPY', ...source].join(' · ');
    }
  }

  if (subtitle) {
    result.subtitle = ['SUBTITLES', ...subtitleParts(subtitle)].join(' · ');
  }

  // Audio-only playback still needs a meaningful overall mode when everything is copied.
  if (!result.video && result.audio && session.transform.audio === 'copy') {
    result.audio = [copyModeLabel(session), ...result.audio.split(' · ').slice(1)].join(' · ');
  }

  return result;
}
