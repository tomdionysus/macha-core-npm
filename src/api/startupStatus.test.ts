import { describe, expect, it } from 'vitest';
import type { ClusterStartupStatus } from './ClusterStatusApi.js';
import { startupPhaseLabel, startupReadyCount, startupSubsystems } from './startupStatus.js';

const recovering: ClusterStartupStatus = {
  phase: 'recovering',
  control_plane: 'ready',
  api: 'ready',
  data_storage: 'recovering',
  control_storage: 'ready',
  cache: 'recovering',
  retention: 'recovering',
  metadata: 'recovering',
  services: 'recovering',
  started_at_unix_ms: 1,
  ready_at_unix_ms: null,
  error: null,
};

describe('startup status presentation', () => {
  it('keeps connectivity/API readiness separate from backend recovery', () => {
    expect(startupPhaseLabel(recovering)).toBe('Recovering');
    expect(startupReadyCount(recovering)).toBe(3);
    expect(startupSubsystems(recovering)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'api', state: 'ready' }),
      expect.objectContaining({ key: 'control_plane', state: 'ready' }),
      expect.objectContaining({ key: 'data_storage', state: 'recovering' }),
      expect.objectContaining({ key: 'metadata', state: 'recovering' }),
    ]));
  });

  it('labels a failed startup without losing subsystem detail', () => {
    const failed = { ...recovering, phase: 'failed' as const, error: 'metadata recovery failed' };
    expect(startupPhaseLabel(failed)).toBe('Startup failed');
    expect(startupSubsystems(failed)).toHaveLength(8);
  });
});

describe('naming the phase a node is in', () => {
  const at = (phase: string) => startupPhaseLabel({ phase } as unknown as ClusterStartupStatus);

  it('names each phase the server states', () => {
    expect(at('ready')).toBe('Ready');
    expect(at('recovering')).toBe('Recovering');
    expect(at('failed')).toBe('Startup failed');
  });

  it('calls a phase it has never heard of "Starting"', () => {
    // A server adding a phase must not produce a blank label on an old
    // client. "Starting" is the safe reading: something is in progress.
    expect(at('reindexing')).toBe('Starting');
    expect(at('')).toBe('Starting');
  });
});
