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
import { setTransferRecorder } from '../api/transferRecorder.js';
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
  wireThroughput(endpointRegistry);
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
 * Wire the throughput axis. Every time, for every host.
 *
 * **Core already had every piece and used to ask a host to connect them.** It
 * times every JSON read, it owns `EndpointBandwidth`, and the registry knows
 * which endpoint a URL belongs to — yet the axis only ranked if a host built
 * the store, passed it to the registry, installed a recorder, and matched URLs
 * to endpoints itself. Four steps, three invisible from the call site, for the
 * axis the cascade documents as outranking latency. Two of three clients did
 * none of it and neither noticed, because a missing axis degrades silently.
 *
 * So it is not optional and it is not conditional. The store is attached
 * unless this registry already has one (services are rebuilt when routing
 * changes, and `attachBandwidth` refuses a second store rather than letting
 * two write the same storage key). The recorder is installed pointed at this
 * registry — the newest services own it, which is right, because a rebuild
 * means the previous registry is being retired.
 *
 * **The store is keyed lazily, and core never mints the id.** It reads
 * `existingClientId()` at the moment it writes, not at construction. The
 * phone client builds its services during its first render, before its
 * storage has hydrated — so an eager `clientId()` here would read an
 * unhydrated key, fail to tell it from absent, mint a fresh identity and
 * persist it, on every cold start. The previous bandwidth record would be
 * orphaned each time, two samples would never accumulate, and the axis would
 * silently never rank: indistinguishable from the feature not existing. A
 * read that finds nothing is harmless; a write that invents an identity is
 * not. Until an id exists the estimate lives in memory, which costs almost
 * nothing — a restored record re-enters at one sample against a threshold of
 * two, so persisted throughput never ranks on its own regardless.
 *
 * What core cannot do is see media bytes; it never fetches media. A host that
 * has them feeds `EndpointRegistry.recordTransferByUrl`. That is the whole of
 * a host's involvement.
 */
function wireThroughput(registry: EndpointRegistry): void {
  if (!registry.throughputRecordable) {
    const configuration = new MachaClientConfiguration();
    registry.attachBandwidth(new EndpointBandwidth(() => configuration.existingClientId()));
  }
  setTransferRecorder((url, bytes, durationMs) => registry.recordTransferByUrl(url, bytes, durationMs));
}
