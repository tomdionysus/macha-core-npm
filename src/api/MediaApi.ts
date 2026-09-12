import type { ArtworkSource, CatalogueMediaProfile, CatalogueStatus } from './CatalogueApi.js';
import type { ArtworkRef, LibraryHome, MediaDetails, MediaSummary } from '../types.js';

/** UI-facing catalogue facade. It contains no playback or per-client state. */
export interface MediaApi {
  status(signal?: AbortSignal): Promise<CatalogueStatus>;
  home(signal?: AbortSignal): Promise<LibraryHome>;
  movies(signal?: AbortSignal): Promise<MediaSummary[]>;
  shows(signal?: AbortSignal): Promise<MediaSummary[]>;
  artists(signal?: AbortSignal): Promise<MediaSummary[]>;
  albums(signal?: AbortSignal): Promise<MediaSummary[]>;
  tracks(signal?: AbortSignal): Promise<MediaSummary[]>;
  details(id: string, signal?: AbortSignal): Promise<MediaDetails>;
  search(query: string, signal?: AbortSignal): Promise<MediaSummary[]>;
  artwork(ref: ArtworkRef, signal?: AbortSignal): Promise<Blob>;
  /**
   * Where this artwork can be fetched from, best first.
   *
   * The ref's own signed capability URL leads when it has one: it carries its
   * own authority, so it is both the cheapest path and the only one usable
   * from a context that cannot set headers. The same capability re-hosted on
   * every other node follows, and needs no header either — its signature
   * covers the artwork id and expiry, never the host, and it is checked with
   * the shared cluster key, so every node honours it and any of them serves
   * the same content-addressed bytes. That is what lets a caller which cannot
   * set headers fail over from a node that is down instead of losing the
   * image. Per-node catalogue URLs come last and do need the client's
   * `Authorization` header — check `requiresAuthorization` rather than
   * assuming, or a caller that cannot send one silently 401s on every entry
   * after the first.
   *
   * An expired capability is not re-hosted: every node would refuse it, so a
   * caller holding one has only its own entry (the browser may still have the
   * image cached under it) and then the authenticated URLs.
   */
  artworkUrls(ref: ArtworkRef): ArtworkSource[];
  invalidateArtwork?(ref: ArtworkRef): void;
  mediaProfile?(mediaId: string, signal?: AbortSignal): Promise<CatalogueMediaProfile | undefined>;
}
