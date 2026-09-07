import type { MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import type {
  IdentityAssociationResetRequest, IdentityAssociationResetResult, MachaDfsDirectory,
  ManageApi, ManualMetadata, ManualMetadataResult, MatchSearchResult, UnmatchedDetail, UnmatchedFile,
} from './ManageApi.js';
import { MachaManageApi } from './MachaManageApi.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';

export class ClusterManageApi implements ManageApi {
  private readonly apis = new Map<string, MachaManageApi>();
  constructor(private readonly router: ClusterEndpointRouter, private readonly auth: AuthenticatedFetch = NO_AUTH) {}

  unmatched(): Promise<UnmatchedFile[]> { return this.read((api) => api.unmatched()); }
  unmatchedDetail(id: string): Promise<UnmatchedDetail> { return this.read((api) => api.unmatchedDetail(id)); }
  prospectiveMatches(id: string, query?: string): Promise<MatchSearchResult> { return this.read((api) => api.prospectiveMatches(id, query)); }
  retry(id: string): Promise<void> { return this.write((api) => api.retry(id)); }
  match(id: string, catalogueItemId: string): Promise<void> { return this.write((api) => api.match(id, catalogueItemId)); }
  manual(id: string, metadata: ManualMetadata): Promise<ManualMetadataResult> { return this.write((api) => api.manual(id, metadata)); }
  deleteUnmatched(id: string): Promise<void> { return this.write((api) => api.deleteUnmatched(id)); }
  browse(path: string): Promise<MachaDfsDirectory> { return this.read((api) => api.browse(path)); }
  mkdir(path: string): Promise<void> { return this.write((api) => api.mkdir(path)); }
  rename(path: string, destination: string): Promise<void> { return this.write((api) => api.rename(path, destination)); }
  deletePath(path: string): Promise<void> { return this.write((api) => api.deletePath(path)); }
  resetIdentityAssociation(request: IdentityAssociationResetRequest): Promise<IdentityAssociationResetResult> {
    return this.write((api) => api.resetIdentityAssociation(request));
  }
  resetNodeIdentityAssociation(nodeId: string, host: string, port?: number, reason?: string): Promise<IdentityAssociationResetResult> {
    return this.write((api) => api.resetNodeIdentityAssociation(nodeId, host, port, reason));
  }

  private async read<T>(operation: (api: MachaManageApi) => Promise<T>): Promise<T> {
    return this.router.request((endpoint) => operation(this.api(endpoint)));
  }

  private async write<T>(operation: (api: MachaManageApi) => Promise<T>): Promise<T> {
    return this.router.mutation((endpoint) => operation(this.api(endpoint)));
  }

  private api(endpoint: MachaEndpoint): MachaManageApi {
    let api = this.apis.get(endpoint.id);
    if (!api) { api = new MachaManageApi(endpoint.baseUrl, this.auth); this.apis.set(endpoint.id, api); }
    return api;
  }
}
