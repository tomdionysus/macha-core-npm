import type { ClusterNodeStatus, ClusterStatusSnapshot } from './ClusterStatusApi.js';

/** The first server release that runs an ingest job on the node it names. */
export const INGEST_PLACEMENT_VERSION = '0.91.1';

/** Why a node cannot be named for an ingest job now. */
export type IngestNodeUnavailableReason =
  /** Not `online` in the cluster's status. */
  | 'not_online'
  /** Before 0.91.1, or a version core cannot read: the server would refuse it as `node_not_ingest_capable`. */
  | 'before_placement';

/** A cluster member, for choosing where an ingest job runs. */
export interface IngestNode {
  nodeId: string;
  /** The operator's `node_name`, else the host. */
  name: string;
  version: string;
  /** Whether a job may be submitted for it now. */
  placeable: boolean;
  unavailableReason: IngestNodeUnavailableReason | null;
}

/**
 * The nodes an ingest job could be placed on, from the cluster's status.
 *
 * The server has no ingest counterpart of `GET /api/v1/torrents/nodes`, so
 * this reads what status already says of each member: online or not, and its
 * version, since a node before 0.91.1 cannot be named. Retired nodes are left
 * out. What status does not say is whether ingest is enabled on a node and
 * what its `ingest.source_roots` are: a path outside them, or ingest switched
 * off there, is the running node's own `400 bad_request`, with its sentence in
 * `detail`.
 */
export function ingestNodes(status: Pick<ClusterStatusSnapshot, 'nodes'>): IngestNode[] {
  return status.nodes
    .filter((node) => node.state !== 'retired')
    .map((node) => {
      const unavailableReason: IngestNodeUnavailableReason | null = node.state !== 'online'
        ? 'not_online'
        : versionAtLeast(node.version, INGEST_PLACEMENT_VERSION) ? null : 'before_placement';
      return {
        nodeId: node.id,
        name: nodeName(node),
        version: node.version,
        placeable: unavailableReason === null,
        unavailableReason,
      };
    });
}

function nodeName(node: ClusterNodeStatus): string {
  return typeof node.node_name === 'string' && node.node_name.trim() ? node.node_name.trim() : node.host;
}

/** Whether a dotted version is at least another, by its numeric parts; false for one that does not parse. */
function versionAtLeast(version: unknown, minimum: string): boolean {
  const parts = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? match.slice(1, 4).map(Number) : undefined;
  };
  const have = typeof version === 'string' ? parts(version) : undefined;
  const need = parts(minimum)!;
  if (!have) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
}
