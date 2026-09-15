import { ClusterAcquisitionApi } from '../api/ClusterAcquisitionApi.js';
import { ClusterPlaybackFactsApi } from '../api/ClusterPlaybackFactsApi.js';
import type { PlaybackFactsApi } from '../api/PlaybackFactsApi.js';
import type { AcquisitionApi } from '../api/AcquisitionApi.js';
import type { CatalogueApi } from '../api/CatalogueApi.js';
import type { ClusterStatusApi } from '../api/ClusterStatusApi.js';
import { ClusterStatusRouter } from '../api/ClusterStatusRouter.js';
import { ClusterCatalogueApi } from '../api/ClusterCatalogueApi.js';
import { ClusterManageApi } from '../api/ClusterManageApi.js';
import { ClusterUsersApi } from '../api/ClusterUsersApi.js';
import type { UsersApi } from '../api/UsersApi.js';
import type { ManageApi } from '../api/ManageApi.js';
import { MachaMediaApi } from '../api/MachaMediaApi.js';
import type { MediaApi } from '../api/MediaApi.js';
import type { ServerApi } from '../api/MachaServerApi.js';
import { ClusterServerApi } from '../api/ClusterServerApi.js';
import { ClusterPlaybackResolver } from '../playback/ClusterPlaybackResolver.js';
import type { PlaybackResolver } from '../playback/PlaybackResolver.js';
import type { EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { EndpointBandwidth } from '../cluster/EndpointBandwidth.js';
import { setTransferRecorder } from '../api/httpCompat.js';
import { MachaClientConfiguration } from '../runtime/configuration.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { NO_AUTH, type AuthenticatedFetch } from '../api/SessionManager.js';

export interface MachaServices {
  catalogueApi: CatalogueApi;
  manageApi: ManageApi;
  usersApi: UsersApi;
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
  /**
   * Opt out of core recording throughput for you.
   *
   * Only for a host that deliberately wants the axis dark — supplying your own
   * `EndpointBandwidth` to the registry is already respected without this,
   * since `attachBandwidth` will not replace one.
   */
  recordThroughput?: boolean;
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
  if (options.recordThroughput !== false) wireThroughput(endpointRegistry);
  const catalogueApi = new ClusterCatalogueApi(endpointRouter, auth);

  return {
    catalogueApi,
    manageApi: new ClusterManageApi(endpointRouter, auth),
    usersApi: new ClusterUsersApi(endpointRouter, auth),
    mediaApi: apiOverride ?? new MachaMediaApi(catalogueApi),
    playbackResolver: playbackOverride ?? new ClusterPlaybackResolver(endpointRouter, auth),
    serverApi: new ClusterServerApi(endpointRouter, auth),
    clusterStatusApi: new ClusterStatusRouter(endpointRouter, auth),
    acquisitionApi: new ClusterAcquisitionApi(endpointRouter, auth),
    playbackFactsApi: new ClusterPlaybackFactsApi(endpointRouter, auth),
    managementAvailable: !apiOverride,
  };
}

/**
 * Record throughput without the host wiring anything.
 *
 * **Core already had every piece and asked a host to connect them.** It times
 * every transfer in `readJsonBody`, it owns `EndpointBandwidth`, and the
 * registry knows which endpoint a URL belongs to — but the axis only ranked if
 * a host built the store, passed it as an optional third constructor argument,
 * installed a recorder, and matched URLs to endpoints itself. Four steps, three
 * invisible from the call site, for the axis the cascade documents as
 * outranking latency. Two of three clients did none of it and neither noticed,
 * because a missing axis degrades silently to latency.
 *
 * `attachBandwidth` will not replace a store the host already supplied, so the
 * two clients that wired their own keep them — **two instances would serialise
 * the same record map to `macha-client-bandwidth:<clientId>` and clobber each
 * other**, which is the collision the phone client raised before this landed.
 */
function wireThroughput(registry: EndpointRegistry): void {
  if (!registry.throughputRecordable) {
    registry.attachBandwidth(new EndpointBandwidth(new MachaClientConfiguration().clientId()));
  }
  setTransferRecorder((url, bytes, durationMs) => registry.recordTransferByUrl(url, bytes, durationMs));
}
