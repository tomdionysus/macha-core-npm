import type { ClusterStartupStatus, StartupSubsystemState } from './ClusterStatusApi.js';

export interface StartupSubsystem {
  key: keyof Pick<ClusterStartupStatus,
    'control_plane' | 'api' | 'data_storage' | 'control_storage' | 'cache' | 'retention' | 'metadata' | 'services'>;
  label: string;
  state: StartupSubsystemState;
}

const labels: Array<[StartupSubsystem['key'], string]> = [
  ['api', 'Status API'],
  ['control_plane', 'Cluster control'],
  ['data_storage', 'DATA storage'],
  ['control_storage', 'CONTROL storage'],
  ['cache', 'Cache'],
  ['retention', 'Retention'],
  ['metadata', 'Metadata'],
  ['services', 'Local services'],
];

export function startupSubsystems(startup: ClusterStartupStatus): StartupSubsystem[] {
  return labels.map(([key, label]) => ({ key, label, state: startup[key] }));
}

export function startupReadyCount(startup: ClusterStartupStatus): number {
  return startupSubsystems(startup).filter((item) => item.state === 'ready').length;
}

export function startupPhaseLabel(startup: ClusterStartupStatus): string {
  switch (startup.phase) {
    case 'ready': return 'Ready';
    case 'recovering': return 'Recovering';
    case 'failed': return 'Startup failed';
    default: return 'Starting';
  }
}
