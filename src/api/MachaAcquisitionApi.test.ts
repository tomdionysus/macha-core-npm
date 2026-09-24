import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaAcquisitionApi } from './MachaAcquisitionApi.js';
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
