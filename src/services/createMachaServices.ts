import { ClusterAcquisitionApi } from '../api/ClusterAcquisitionApi.js';
import { ClusterPlaybackFactsApi } from '../api/ClusterPlaybackFactsApi.js';
import type { PlaybackFactsApi } from '../api/PlaybackFactsApi.js';
import type { AcquisitionApi } from '../api/AcquisitionApi.js';
import type { CatalogueApi } from '../api/CatalogueApi.js';
import type { ClusterStatusApi } from '../api/ClusterStatusApi.js';
import { ClusterStatusRouter } from '../api/ClusterStatusRouter.js';
import { ClusterCatalogueApi } from '../api/ClusterCatalogueApi.js';
import { ClusterManageApi } from '../api/ClusterManageApi.js';
import type { ManageApi } from '../api/ManageApi.js';
import { MachaMediaApi } from '../api/MachaMediaApi.js';
import type { MediaApi } from '../api/MediaApi.js';
import type { ServerApi } from '../api/MachaServerApi.js';
import { ClusterServerApi } from '../api/ClusterServerApi.js';
import { ClusterPlaybackResolver } from '../playback/ClusterPlaybackResolver.js';
import type { PlaybackResolver } from '../playback/PlaybackResolver.js';
import type { EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { NO_AUTH, type AuthenticatedFetch } from '../api/SessionManager.js';

export interface MachaServices {
  catalogueApi: CatalogueApi;
  manageApi: ManageApi;
  mediaApi: MediaApi;
  playbackResolver: PlaybackResolver;
  serverApi: ServerApi;
  clusterStatusApi: ClusterStatusApi;
  acquisitionApi: AcquisitionApi;
  /**
   * Source facts and per-node operations, routed per call. Feed it to
   * `PlaybackRuntime`'s `facts` option rather than building one against a
   * fixed base URL — see `ClusterPlaybackFactsApi`.
   */
  playbackFactsApi: PlaybackFactsApi;
  /** False when a caller substituted its own `MediaApi`; management screens are then meaningless. */
  managementAvailable: boolean;
}

export interface MachaServicesOptions {
  endpointRegistry: EndpointRegistry;
  auth?: AuthenticatedFetch;
  apiOverride?: MediaApi;
  playbackOverride?: PlaybackResolver;
}

/**
 * Build the whole service set over one endpoint registry.
 *
 * Every service authenticates through `auth` at request time — the real one is
 * the application-wide session singleton, so a refresh (expiry, 401) is never
 * a reason to rebuild these; rebuilding them would orphan an active playback
 * generation's node ownership. They only need rebuilding when routing itself
 * changes, so a caller should memoize this on `endpointRegistry` and `auth`.
 */
export function createMachaServices(options: MachaServicesOptions): MachaServices {
  const { endpointRegistry, apiOverride, playbackOverride } = options;
  const auth = options.auth ?? NO_AUTH;
  const endpointRouter = new ClusterEndpointRouter(endpointRegistry);
  const catalogueApi = new ClusterCatalogueApi(endpointRouter, auth);

  return {
    catalogueApi,
    manageApi: new ClusterManageApi(endpointRouter, auth),
    mediaApi: apiOverride ?? new MachaMediaApi(catalogueApi),
    playbackResolver: playbackOverride ?? new ClusterPlaybackResolver(endpointRouter, auth),
    serverApi: new ClusterServerApi(endpointRouter, auth),
    clusterStatusApi: new ClusterStatusRouter(endpointRouter, auth),
    acquisitionApi: new ClusterAcquisitionApi(endpointRouter, auth),
    playbackFactsApi: new ClusterPlaybackFactsApi(endpointRouter, auth),
    managementAvailable: !apiOverride,
  };
}
