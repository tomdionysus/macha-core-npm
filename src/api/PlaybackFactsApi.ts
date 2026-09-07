import type { MediaTechnicalProfile } from '../types.js';

/**
 * What this node's build can actually perform for this source.
 *
 * The missing half of the contract. The chooser reasons about the media and
 * the device; without this it is guessing about the executor — and a wholly
 * correct instruction can still be refused because *this* build cannot copy
 * this codec into fragmented MP4. Reported per media, because the answer
 * depends on the source's codecs as well as the encoders present.
 */
export interface PlaybackOperations {
  /** Whether the source can be served whole, as bytes. */
  direct: boolean;
  /** Whether each stream can be copied into a fragmented-MP4 segment. */
  copyIntoFmp4: { video: boolean; audio: boolean };
  transcodeVideo: boolean;
  transcodeAudio: boolean;
}

/**
 * Everything the chooser needs: what the media is, and what this node can do
 * with it.
 *
 * `operations` is optional here so a host with only a catalogue profile can
 * still satisfy the seam — the chooser then assumes the node can perform
 * whatever it is asked, which is how it behaved before the facts endpoint
 * existed. The facts endpoint always supplies it, and `PlaybackMediaFacts`
 * below requires it.
 */
export interface PlaybackDecisionFacts {
  profile: MediaTechnicalProfile;
  operations?: PlaybackOperations;
}

export interface PlaybackMediaFacts extends PlaybackDecisionFacts {
  mediaId: string;
  itemId?: string;
  path?: string;
  sizeBytes?: number;
  operations: PlaybackOperations;
}

/**
 * Probes a source and reports what it is and what can be done with it,
 * without creating a session or starting a pipeline.
 *
 * This resolves a mutable path identity the same way session creation does,
 * so it answers for media that has no immutable catalogue profile.
 */
export interface PlaybackFactsApi {
  facts(ref: { itemId?: string; mediaId?: string }, signal?: AbortSignal): Promise<PlaybackMediaFacts[]>;
}
