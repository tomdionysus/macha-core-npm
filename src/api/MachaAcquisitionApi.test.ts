import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquisitionError, MachaAcquisitionApi, torrentHeldBy } from './MachaAcquisitionApi.js';
import { endpointFailure, playbackFailureCode } from '../cluster/endpointFailure.js';
import { fixedBearerToken } from './SessionManager.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MachaAcquisitionApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the acquisition snapshot from the four server endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ enabled: true, staging: { path: '/stage', limit_bytes: 100, disk_bytes: 10, reserved_bytes: 5, accounted_bytes: 15 } }))
      .mockResolvedValueOnce(jsonResponse({ enabled: true, build_available: true, search_enabled: false }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new MachaAcquisitionApi('http://macha:8080/', fixedBearerToken('secret'));
    const snapshot = await api.snapshot();

    expect(snapshot.ingestStatus.enabled).toBe(true);
    expect(snapshot.torrentStatus.build_available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://macha:8080/api/v1/ingest/status');
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toMatchObject({ Authorization: 'Bearer secret', Accept: 'application/json' });
  });

  it("carries a failed placement's reason and code, from server 0.56.0", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      status: 'placement_failed',
      error: { code: 'placement_failed', message: 'node did not accept the torrent', reason: 'node_refused' },
    }, 409)));
    await expect(new MachaAcquisitionApi('http://macha:8080').submitMagnet('magnet:?xt=urn:btih:abc'))
      .rejects.toMatchObject({ status: 409, code: 'placement_failed', reason: 'node_refused', detail: 'node did not accept the torrent' });
  });

  it("reads 0.56.0 job envelopes with the new status key and each job's error_code", async () => {
    const job = { id: 'j1', error: 'no media found', error_code: 'no_supported_media' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', enabled: true, staging: { path: '/stage', limit_bytes: 100, disk_bytes: 10, reserved_bytes: 5, accounted_bytes: 15 } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', enabled: true, build_available: true, search_enabled: false }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', jobs: [job] }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await new MachaAcquisitionApi('http://macha:8080').snapshot();
    expect(snapshot.ingestJobs[0]?.error_code).toBe('no_supported_media');
  });

  it('says which array a job envelope is missing rather than failing at .map', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ enabled: true, staging: { path: '/stage', limit_bytes: 100, disk_bytes: 10, reserved_bytes: 5, accounted_bytes: 15 } }))
      .mockResolvedValueOnce(jsonResponse({ enabled: true, build_available: true, search_enabled: false }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await new MachaAcquisitionApi('http://node.test').snapshot().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: 'invalid_response' });
    expect((error as Error).message).toContain('jobs');
  });

  it('submits filesystem paths without deleting the source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'ingest-1' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const api = new MachaAcquisitionApi('');
    await expect(api.submitPath('/media/usb/Movies')).resolves.toBe('ingest-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/ingest/jobs', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: '/media/usb/Movies', remove_source: false }),
    }));
  });

  it('submits magnets and maps controls to the server job actions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'torrent-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: 'torrent-1', state: 'paused' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'torrent-1', state: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'torrent-1', state: 'importing' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'torrent-1', state: 'cancelled' }))
      .mockResolvedValueOnce(jsonResponse({ cleared: true }))
      .mockResolvedValueOnce(jsonResponse({ cleared: true }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new MachaAcquisitionApi('');
    await api.submitMagnet('magnet:?xt=urn:btih:abc');
    await api.pauseTorrent('torrent-1');
    await api.resumeTorrent('torrent-1');
    await api.retryTorrent('torrent-1');
    await api.cancelTorrent('torrent-1');
    await api.clearTorrent('torrent-1');
    await api.clearIngest('ingest-1');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/torrents/jobs',
      '/api/v1/torrents/jobs/torrent-1/pause',
      '/api/v1/torrents/jobs/torrent-1/resume',
      '/api/v1/torrents/jobs/torrent-1/retry',
      '/api/v1/torrents/jobs/torrent-1/cancel',
      '/api/v1/torrents/jobs/torrent-1/clear',
      '/api/v1/ingest/jobs/ingest-1/clear',
    ]);
  });
});

describe('a torrent a job already holds (server 0.63.0)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('carries the holding job and its node, through the cluster wrapping too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      status: 'torrent_already_added',
      error: { code: 'torrent_already_added', message: 'job j-7 already holds this torrent' },
      id: 'j-7', node_id: 'gbni-1',
    }, 409)));
    const error = await new MachaAcquisitionApi('http://node.test', fixedBearerToken('t')).submitMagnet('magnet:?xt=urn:btih:abc').catch((e: unknown) => e);
    expect(torrentHeldBy(error)).toEqual({ id: 'j-7', nodeId: 'gbni-1' });
    const wrapped = endpointFailure('fi-1', 'http://node.test', error);
    expect(playbackFailureCode(wrapped)).toBe('torrent_already_added');
    expect(acquisitionError(wrapped)).toMatchObject({ status: 409, code: 'torrent_already_added' });
    expect(torrentHeldBy(wrapped)).toEqual({ id: 'j-7', nodeId: 'gbni-1' });
  });

  it('reads no holder from any other refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'placement_failed', message: 'no', reason: 'add_failed' }, id: 'x' }, 409)));
    const error = await new MachaAcquisitionApi('http://node.test', fixedBearerToken('t')).submitMagnet('magnet:?').catch((e: unknown) => e);
    expect(torrentHeldBy(error)).toBeUndefined();
    // The reason of any refusal, found behind the router's wrapping.
    expect(acquisitionError(endpointFailure('fi-1', 'http://node.test', error))?.reason).toBe('add_failed');
  });
});

describe('cluster torrents (server 0.64.0)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const job = { id: 't-1', name: 'x', info_hash: 'ab', phase: 'awaiting_node', state: 'awaiting_node', desired: 'active', desired_applied: false, node_id: null, pinned_node_id: 'gbni-1', bytes_total: null, bytes_completed: null, download_rate: null, upload_rate: null, uploaded_total: null, peers: null, seeds: null, eta_seconds: null, progress: null, live_as_of_unix_ms: null, ingest_job_id: null, created_unix_ms: 1, updated_unix_ms: 1, error: null };

  it('adds with a pin and a removal delay, and answers with the job', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', id: 't-1', info_hash: 'ab', node_id: 'gbni-1', job }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MachaAcquisitionApi('').submitMagnet('magnet:?', { nodeId: 'gbni-1', removeAfterMs: 0 });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ magnet: 'magnet:?', node_id: 'gbni-1', remove_after_ms: 0 });
    expect(result).toMatchObject({ id: 't-1', infoHash: 'ab', pinnedNodeId: 'gbni-1', job: { phase: 'awaiting_node' } });
  });

  it('leaves the pin and the delay to the cluster when not given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 't-1', node_id: null }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MachaAcquisitionApi('').submitMagnet('magnet:?');
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ magnet: 'magnet:?' });
    expect(result).toEqual({ id: 't-1', infoHash: null, pinnedNodeId: null });
  });

  it('updates the removal delay or the pin with a PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(job));
    vi.stubGlobal('fetch', fetchMock);
    await new MachaAcquisitionApi('').updateTorrent('t-1', { removeAfterMs: null, nodeId: null });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/torrents/jobs/t-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ remove_after_ms: null, node_id: null });
  });

  it('lists the torrent-capable nodes with the cluster default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      status: 'ok', refresh_interval_ms: 5000, default_remove_after_ms: null,
      nodes: [{ node_id: 'gbni-1', host: 'gbni-1', local: false, reachable: false, as_of_unix_ms: null, max_active: 3, active_jobs: 0, accepting: false, not_accepting_reason: 'unreachable', staging: { limit_bytes: 1, disk_bytes: 1, reserved_bytes: 0, free_bytes: 1 } }],
    })));
    const nodes = await new MachaAcquisitionApi('').torrentNodes();
    expect(nodes).toMatchObject({ refreshIntervalMs: 5000, defaultRemoveAfterMs: null, nodes: [{ node_id: 'gbni-1', accepting: false, not_accepting_reason: 'unreachable' }] });
  });

  it("carries the lists' sources and refresh interval on the snapshot", async () => {
    const sources = [{ node_id: 'fi-1', local: true, reachable: true, as_of_unix_ms: 5 }, { node_id: 'gbni-1', local: false, reachable: false, as_of_unix_ms: null }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/status')) return jsonResponse({});
      return jsonResponse({ jobs: url.includes('torrents') ? [job] : [], sources, refresh_interval_ms: 5000 });
    }));
    const snapshot = await new MachaAcquisitionApi('').snapshot();
    expect(snapshot).toMatchObject({ refreshIntervalMs: 5000, torrentSources: sources, ingestSources: sources, torrentJobs: [{ id: 't-1', node_id: null }] });
  });
});

describe('a node with no namespace yet (server 0.88.0)', () => {
  // `metadata_unavailable` no longer means every node's metadata is
  // unwritable: only that this node is still joining.
  it('is walked to the next node, which may have one, and charged nothing', async () => {
    const { failureBlamesEndpoint, retryableEndpointFailure } = await import('../cluster/endpointFailure.js');
    const refusal = Object.assign(new Error('metadata snapshot not yet available'), { status: 503, code: 'metadata_unavailable' });
    expect(retryableEndpointFailure(refusal)).toBe(true);
    expect(failureBlamesEndpoint(refusal)).toBe(false);
  });
});

describe('adding a torrent paused (server 0.71.0)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends paused only when asked', async () => {
    // A 0.71.0 node, which records the job paused when asked.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const paused = JSON.parse(String(init?.body ?? '{}')).paused === true;
      return jsonResponse({ id: 't-1', node_id: null, job: { id: 't-1', desired: paused ? 'paused' : 'active' } }, 202);
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaAcquisitionApi('');
    await api.submitMagnet('magnet:?', { paused: true });
    await api.submitMagnet('magnet:?', { paused: false });
    const bodies = (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toEqual({ magnet: 'magnet:?', paused: true });
    expect(bodies[1]).toEqual({ magnet: 'magnet:?' });
  });
});

describe('a paused add on a node that ignores paused', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pauses the job at once when the node started it anyway', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/pause')
      ? jsonResponse({ id: 't-1', desired: 'paused', state: 'queued' }, 202)
      : jsonResponse({ id: 't-1', node_id: null, job: { id: 't-1', desired: 'active', state: 'awaiting_node' } }, 202)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MachaAcquisitionApi('').submitMagnet('magnet:?', { paused: true });
    expect((fetchMock.mock.calls as Array<[string]>).map(([url]) => url)).toEqual(['/api/v1/torrents/jobs', '/api/v1/torrents/jobs/t-1/pause']);
    expect(result).toMatchObject({ id: 't-1', pausedAfterAdd: true, job: { desired: 'paused' } });
  });

  it('leaves a job the node recorded paused alone', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ id: 't-1', node_id: null, job: { id: 't-1', desired: 'paused', state: 'awaiting_node' } }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MachaAcquisitionApi('').submitMagnet('magnet:?', { paused: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.pausedAfterAdd).toBeUndefined();
  });
});

describe('a paused add whose follow-up pause fails', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers the add, saying the pause did not take, rather than failing the add', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/pause')
      ? jsonResponse({ error: { code: 'internal', message: 'boom' } }, 500)
      : jsonResponse({ id: 't-1', node_id: null, job: { id: 't-1', desired: 'active', state: 'awaiting_node' } }, 202)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MachaAcquisitionApi('').submitMagnet('magnet:?', { paused: true });
    expect(result).toMatchObject({ id: 't-1', pausedAfterAdd: false, job: { desired: 'active' } });
    expect(result.pauseError).toBeDefined();
  });
});
