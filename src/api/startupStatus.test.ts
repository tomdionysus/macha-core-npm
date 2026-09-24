import { describe, expect, it } from 'vitest';
import type { ClusterStartupStatus } from './ClusterStatusApi.js';
import { startupPhase, startupReadyCount, startupSubsystems } from './startupStatus.js';

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

describe('startup status', () => {
  it('keeps connectivity/API readiness separate from backend recovery', () => {
    expect(startupPhase(recovering)).toBe('recovering');
    expect(startupReadyCount(recovering)).toBe(3);
    expect(startupSubsystems(recovering)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'api', state: 'ready' }),
      expect.objectContaining({ key: 'control_plane', state: 'ready' }),
      expect.objectContaining({ key: 'data_storage', state: 'recovering' }),
      expect.objectContaining({ key: 'metadata', state: 'recovering' }),
    ]));
  });

  it('reports a failed startup without losing subsystem detail', () => {
    const failed = { ...recovering, phase: 'failed' as const, error: 'metadata recovery failed' };
    expect(startupPhase(failed)).toBe('failed');
    expect(startupSubsystems(failed).every((subsystem) => !('label' in subsystem))).toBe(true);
    expect(startupSubsystems(failed)).toHaveLength(8);
  });
});

describe('naming the phase a node is in', () => {
  const at = (phase: string) => startupPhase({ phase } as unknown as ClusterStartupStatus);

  it('names each phase the server states', () => {
    expect(at('ready')).toBe('ready');
    expect(at('recovering')).toBe('recovering');
    expect(at('failed')).toBe('failed');
  });

  it('reads a phase it has never heard of as starting', () => {
    // A server adding a phase must not leave an old client with nothing to
    // say. Starting is the safe reading: something is in progress.
    expect(at('reindexing')).toBe('starting');
    expect(at('')).toBe('starting');
  });
});
