/**
 * The one place a completed transfer is observed — how many bytes, how long
 * the body took — so throughput evidence comes from traffic the client was
 * making anyway rather than from synthetic probes.
 *
 * **Internal. Not exported from the package index, on purpose.** There is one
 * slot, and it used to be a public seam that hosts installed into. That made
 * the throughput axis the host's problem in four steps, three of them
 * invisible from the call site, and two of three clients wired none of it.
 * Core installs the recorder now, in `createMachaServices`, pointed at the
 * registry it is building. A host with media-byte evidence — which core never
 * sees, since it only reads its own JSON — feeds it through
 * `EndpointRegistry.recordTransferByUrl` rather than by replacing this.
 */
export type TransferRecorder = (url: string, bytes: number, durationMs: number) => void;

let transferRecorder: TransferRecorder | undefined;

export function setTransferRecorder(recorder: TransferRecorder | undefined): void {
  transferRecorder = recorder;
}

export function currentTransferRecorder(): TransferRecorder | undefined {
  return transferRecorder;
}
