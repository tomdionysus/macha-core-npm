/**
 * macha-client — the generic, platform-independent client core for Macha.
 *
 * Everything a Macha client does that is not presentation: talking to the
 * server API families, choosing and failing over between cluster endpoints,
 * resolving and coordinating playback, and persisting client-side state.
 *
 * It has no runtime dependencies and reaches for no browser global. What it
 * genuinely needs from a host — storage, a clock, an id generator, a base
 * origin — is supplied through `configureMachaHost`; what it needs from the
 * network arrives as an `AuthenticatedFetch`. Presentation, navigation and
 * media element/view handling stay with each platform.
 */

// ---------------------------------------------------------------- runtime
export {
  configureMachaHost,
  machaHost,
  memoryStorage,
  resetMachaHost,
  defaultNow,
  type MachaHost,
} from './runtime/host.js';
export {
  publishConnectionState,
  subscribeConnectionState,
  type ConnectionStateEvent,
  type ConnectionStateKind,
  type ConnectionStateListener,
} from './runtime/events.js';
export {
  MachaClientConfiguration,
  parseEndpointList,
  normalizeUrl,
  normalizeUrls,
  type MachaClientConfigurationOptions,
} from './runtime/configuration.js';
export {
  MACHA_STORAGE_KEYS,
  MACHA_STORAGE_KEY_PREFIXES,
  MACHA_STORAGE_PROBE_KEY,
  isMachaStorageKey,
} from './runtime/storageKeys.js';

// ------------------------------------------------------------------ model
export * from './types.js';

// -------------------------------------------------------------------- api
export * from './api/AcquisitionApi.js';
export * from './api/CatalogueApi.js';
export * from './api/ClusterAcquisitionApi.js';
export * from './api/ClusterCatalogueApi.js';
export * from './api/ClusterManageApi.js';
export * from './api/ClusterServerApi.js';
export * from './api/ClusterStatusApi.js';
export * from './api/ClusterStatusRouter.js';
export * from './api/episodeNeighbours.js';
export * from './api/errorEnvelope.js';
export * from './api/httpCompat.js';
export * from './api/MachaAcquisitionApi.js';
export * from './api/MachaCatalogueApi.js';
export * from './api/MachaManageApi.js';
export * from './api/identification.js';
export * from './api/MachaMediaApi.js';
export * from './api/ClusterPlaybackFactsApi.js';
export * from './api/MachaPlaybackFactsApi.js';
export * from './api/PlaybackFactsApi.js';
export * from './api/MachaServerApi.js';
export * from './api/ManageApi.js';
export * from './api/UsersApi.js';
export { MachaUsersApi, MachaUsersApiError, type UsersApiErrorCode } from './api/MachaUsersApi.js';
export { ClusterUsersApi } from './api/ClusterUsersApi.js';
export * from './api/MediaApi.js';
export * from './api/serverConnection.js';
export * from './api/SessionAuth.js';
export * from './api/SessionManager.js';
export * from './api/startupStatus.js';

// ---------------------------------------------------------------- cluster
export * from './cluster/EndpointBandwidth.js';
export * from './cluster/endpointFailure.js';
export * from './cluster/EndpointHealthMonitor.js';
export * from './cluster/EndpointRegistry.js';
export * from './cluster/endpointRouting.js';

// --------------------------------------------------------------- playback
export * from './playback/BufferedTimeline.js';
export * from './playback/choosePlaybackInstruction.js';
export * from './playback/playbackVersions.js';
export * from './playback/ClusterPlaybackResolver.js';
export * from './playback/generationStart.js';
export * from './playback/hlsWalk.js';
export * from './playback/MachaPlaybackResolver.js';
export * from './playback/MediaTechnicalProfile.js';
export * from './playback/MediaWatchdog.js';
export * from './playback/PlaybackCoordinator.js';
export * from './playback/PlaybackResolver.js';
export * from './playback/PlaybackRuntime.js';
export * from './playback/PlaybackStatus.js';
export * from './playback/streamProtocol.js';

// ------------------------------------------------------------------ state
export * from './state/artworkHost.js';
export * from './state/continueWatching.js';
export * from './state/continueWatchingMigration.js';
export * from './state/musicPlaylist.js';
export * from './state/playlist.js';
export * from './state/playbackQueue.js';
export * from './state/progressWrite.js';
export * from './state/storage.js';

// --------------------------------------------------------------- platform
export * from './platform/Platform.js';
export * from './platform/platformTraits.js';
export * from './platform/platformSurface.js';

// --------------------------------------------------------------- services
export * from './services/createMachaServices.js';
export * from './connection/connectionConfiguration.js';

// ------------------------------------------------------- routing and sort
export * from './routing.js';
export * from './playbackRoute.js';
export * from './mediaSort.js';
export * from './recentMedia.js';
export * from './searchCategories.js';
export * from './searchTerms.js';
export * from './titleIndex.js';

// ------------------------------------------------------------ diagnostics
export * from './diagnostics/ClientLog.js';
export * from './errors.js';
