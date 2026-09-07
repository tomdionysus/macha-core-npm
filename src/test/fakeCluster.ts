import { vi } from 'vitest';
import { normalizeBaseUrl } from '../api/httpCompat.js';
import { bootstrapEndpoints, EndpointRegistry, type MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterPlaybackResolver } from '../playback/ClusterPlaybackResolver.js';
import type { PlaybackMode } from '../types.js';

export interface WireSessionOverrides {
  mode?: PlaybackMode;
  itemId?: string;
  mediaId?: string;
  seekMs?: number;
  durationMs?: number;
}

/**
 * Build a wire-shaped `/api/v1/playback/sessions` response, matching the
 * server contract `MachaPlaybackResolver` parses. Transformed modes get an
 * `.m3u8` stream URL so a queued session can also stand in for HLS manifest
 * admission.
 */
export function wireSession(id: string, overrides: WireSessionOverrides = {}): unknown {
  const mode = overrides.mode ?? 'direct';
  const transformed = mode !== 'direct';
  const mediaId = overrides.mediaId ?? 'macha:media';
  return {
    session_id: id,
    item_id: overrides.itemId ?? 'macha:movie:1',
    media_id: mediaId,
    mode,
    duration_ms: overrides.durationMs ?? 600_000,
    seek_ms: overrides.seekMs ?? 0,
    preferences: {
      mode: 'direct', max_height: null, max_bitrate: null,
      audio_stream: null, subtitle_stream: null, audio_language: '', subtitle_language: '',
    },
    selection: { video_stream: 0, audio_stream: 1, subtitle_stream: -1 },
    source: { path: '/movie', format: transformed ? 'matroska' : 'mp4', size: 1_000_000, bitrate: 1_000_000, streams: [] },
    output: {},
    stream: {
      url: transformed ? `/api/v1/playback/stream/${id}/index.m3u8` : `/api/v1/playback/stream/${id}`,
      mime_type: transformed ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      subtitle_url: null,
    },
    options: {
      modes: [mode], quality_heights: [], media_ids: [mediaId],
      audio_streams: [], subtitle_streams: [], can_seek: true, can_change_quality: transformed, can_switch_media: false,
    },
  };
}

type QueuedResponse =
  | { kind: 'session'; id: string; overrides?: WireSessionOverrides }
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'network'; message?: string }
  | { kind: 'hang' };

export interface FakeClusterNode {
  readonly baseUrl: string;
  /** Queue a successful session-admission/update response. */
  queueSession(id: string, overrides?: WireSessionOverrides): void;
  /** Queue a bare HTTP status (e.g. 204 for a DELETE, or a 5xx/429 server error). */
  queueStatus(status: number, body?: unknown): void;
  /** Queue a transport failure (connection refused, DNS, CORS) — a TypeError, matching real `fetch`. */
  queueNetworkFailure(message?: string): void;
  /** Queue a request that never settles, to exercise client-side deadlines. */
  queueHang(): void;
}

export interface FakeCluster {
  readonly registry: EndpointRegistry;
  readonly resolver: ClusterPlaybackResolver;
  readonly fetchMock: ReturnType<typeof vi.fn>;
  /** Every intercepted request, in order, for assertions on attempt order/routing. */
  readonly calls: Array<{ url: string; method: string }>;
  node(baseUrl: string): FakeClusterNode;
}

/**
 * A deterministic multi-node fake of the Macha playback HTTP API, wired to
 * the real `EndpointRegistry` and `ClusterPlaybackResolver` behind a stubbed
 * global `fetch`. Each node gets its own FIFO response queue so a test can
 * script exactly which node fails at which attempt (request creation,
 * update, teardown) without touching global browser events or the route.
 *
 * Caller is responsible for `vi.unstubAllGlobals()` in `afterEach`.
 */
export function createFakeCluster(baseUrls: readonly string[]): FakeCluster {
  const endpoints: MachaEndpoint[] = bootstrapEndpoints(baseUrls);
  const registry = new EndpointRegistry(endpoints);
  const resolver = new ClusterPlaybackResolver(registry);
  const queues = new Map<string, QueuedResponse[]>(endpoints.map((endpoint) => [endpoint.baseUrl, []]));
  const calls: Array<{ url: string; method: string }> = [];

  function endpointFor(url: string): MachaEndpoint {
    const endpoint = endpoints.find((candidate) => url.startsWith(`${candidate.baseUrl}/`) || url === candidate.baseUrl);
    if (!endpoint) throw new Error(`fakeCluster: no configured node matches ${url}`);
    return endpoint;
  }

  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const endpoint = endpointFor(url);
    const queue = queues.get(endpoint.baseUrl)!;
    const next = queue.shift();
    if (!next) throw new Error(`fakeCluster: node ${endpoint.baseUrl} has no queued response left for ${method} ${url}`);
    switch (next.kind) {
      case 'session':
        return new Response(JSON.stringify(wireSession(next.id, next.overrides)), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      case 'status':
        return new Response(next.body !== undefined ? JSON.stringify(next.body) : null, {
          status: next.status,
          headers: next.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        });
      case 'network':
        throw new TypeError(next.message ?? 'fake network failure');
      case 'hang':
        return new Promise<Response>(() => undefined);
    }
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    registry,
    resolver,
    fetchMock,
    calls,
    node(baseUrl: string): FakeClusterNode {
      const normalized = normalizeBaseUrl(baseUrl);
      const endpoint = endpoints.find((candidate) => candidate.baseUrl === normalized);
      if (!endpoint) throw new Error(`fakeCluster: ${baseUrl} was not one of the configured nodes`);
      const queue = queues.get(endpoint.baseUrl)!;
      return {
        baseUrl: endpoint.baseUrl,
        queueSession: (id, overrides) => queue.push({ kind: 'session', id, overrides }),
        queueStatus: (status, body) => queue.push({ kind: 'status', status, body }),
        queueNetworkFailure: (message) => queue.push({ kind: 'network', message }),
        queueHang: () => queue.push({ kind: 'hang' }),
      };
    },
  };
}
