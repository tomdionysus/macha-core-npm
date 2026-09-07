import type { AcquisitionApi, AcquisitionSnapshot, IngestJob, TorrentJob } from './AcquisitionApi.js';
import type { MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { MachaAcquisitionApi } from './MachaAcquisitionApi.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';

export class ClusterAcquisitionApi implements AcquisitionApi {
  private readonly apis = new Map<string, MachaAcquisitionApi>();
  constructor(private readonly router: ClusterEndpointRouter, private readonly auth: AuthenticatedFetch = NO_AUTH) {}

  snapshot(): Promise<AcquisitionSnapshot> { return this.read((api) => api.snapshot()); }
  submitPath(path: string): Promise<string> { return this.write((api) => api.submitPath(path)); }
  submitMagnet(magnet: string): Promise<string> { return this.write((api) => api.submitMagnet(magnet)); }
  pauseIngest(id: string): Promise<IngestJob> { return this.write((api) => api.pauseIngest(id)); }
  resumeIngest(id: string): Promise<IngestJob> { return this.write((api) => api.resumeIngest(id)); }
  cancelIngest(id: string): Promise<IngestJob> { return this.write((api) => api.cancelIngest(id)); }
  clearIngest(id: string): Promise<void> { return this.write((api) => api.clearIngest(id)); }
  pauseTorrent(id: string): Promise<TorrentJob> { return this.write((api) => api.pauseTorrent(id)); }
  resumeTorrent(id: string): Promise<TorrentJob> { return this.write((api) => api.resumeTorrent(id)); }
  retryTorrent(id: string): Promise<TorrentJob> { return this.write((api) => api.retryTorrent(id)); }
  cancelTorrent(id: string): Promise<TorrentJob> { return this.write((api) => api.cancelTorrent(id)); }
  clearTorrent(id: string): Promise<void> { return this.write((api) => api.clearTorrent(id)); }

  private async read<T>(operation: (api: MachaAcquisitionApi) => Promise<T>): Promise<T> {
    return this.router.request((endpoint) => operation(this.api(endpoint)));
  }

  private async write<T>(operation: (api: MachaAcquisitionApi) => Promise<T>): Promise<T> {
    return this.router.mutation((endpoint) => operation(this.api(endpoint)));
  }

  private api(endpoint: MachaEndpoint): MachaAcquisitionApi {
    let api = this.apis.get(endpoint.id);
    if (!api) { api = new MachaAcquisitionApi(endpoint.baseUrl, this.auth); this.apis.set(endpoint.id, api); }
    return api;
  }
}
