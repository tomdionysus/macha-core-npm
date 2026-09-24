import type { ClusterStartupStatus, StartupPhase, StartupSubsystemState } from './ClusterStatusApi.js';

export interface StartupSubsystem {
  /** What a host keys its own wording on. Core writes no viewer text. */
  key: keyof Pick<ClusterStartupStatus,
    'control_plane' | 'api' | 'data_storage' | 'control_storage' | 'cache' | 'retention' | 'metadata' | 'services'>;
  state: StartupSubsystemState;
}

/** The order the subsystems are listed in. */
const SUBSYSTEM_ORDER: ReadonlyArray<StartupSubsystem['key']> = [
  'api', 'control_plane', 'data_storage', 'control_storage', 'cache', 'retention', 'metadata', 'services',
];

export function startupSubsystems(startup: ClusterStartupStatus): StartupSubsystem[] {
  return SUBSYSTEM_ORDER.map((key) => ({ key, state: startup[key] }));
}

export function startupReadyCount(startup: ClusterStartupStatus): number {
  return startupSubsystems(startup).filter((item) => item.state === 'ready').length;
}

/**
 * The phase a node is in, for a host to word. A phase core has never heard
 * of reads as `starting`: a server adding one must not leave an old client
 * with nothing to say, and something being in progress is the safe reading.
 */
export function startupPhase(startup: ClusterStartupStatus): StartupPhase {
  switch (startup.phase) {
    case 'ready':
    case 'recovering':
    case 'failed':
      return startup.phase;
    default:
      return 'starting';
  }
}
