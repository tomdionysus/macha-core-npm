import { describe, expect, it } from 'vitest';
import type { ClusterNodeStatus } from './ClusterStatusApi.js';
import { ingestNodes } from './ingestNodes.js';

const node = (fields: Partial<ClusterNodeStatus>): ClusterNodeStatus => ({
  id: 'n', state: 'online', version: '0.91.1', host: 'corvus-fi-1', node_name: null, ...fields,
} as ClusterNodeStatus);

describe('ingestNodes', () => {
  it('names the members a job can be placed on, and why the rest cannot be', () => {
    expect(ingestNodes({ nodes: [
      node({ id: 'fi-1', node_name: 'Corvus FI-1', version: '0.91.1' }),
      node({ id: 'gbni-1', host: 'macnessa', version: '0.92.0', state: 'offline' }),
      node({ id: 'es-1', host: 'es-1', version: '0.90.96' }),
      node({ id: 'old', state: 'retired' }),
      node({ id: 'odd', host: 'odd', version: 'unknown' }),
    ] })).toEqual([
      { nodeId: 'fi-1', name: 'Corvus FI-1', version: '0.91.1', placeable: true, unavailableReason: null },
      { nodeId: 'gbni-1', name: 'macnessa', version: '0.92.0', placeable: false, unavailableReason: 'not_online' },
      { nodeId: 'es-1', name: 'es-1', version: '0.90.96', placeable: false, unavailableReason: 'before_placement' },
      { nodeId: 'odd', name: 'odd', version: 'unknown', placeable: false, unavailableReason: 'before_placement' },
    ]);
  });

  it('compares versions by number, not as text', () => {
    expect(ingestNodes({ nodes: [node({ version: '0.100.0' }), node({ version: '1.0.0' }), node({ version: '0.91.0' })] })
      .map(({ placeable }) => placeable)).toEqual([true, true, false]);
  });
});
