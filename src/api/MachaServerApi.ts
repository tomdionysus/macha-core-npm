import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, readResponseBody } from './httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { isGatewayConnectionFailure, serverUnreachable } from './serverConnection.js';
export interface ServerStatus {
  version: string | null;
  playback: Record<string, unknown>;
  playbackAvailable: boolean;
  httpStatus: number;
  message: string | null;
}

export interface ServerApi {
  status(): Promise<ServerStatus>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The node's version, from the body alone.
 *
 * There was a header fallback here — `x-macha-version`, then
 * `x-server-version`, then parsing a `Server` header. **All three were read and
 * none was ever sent.** Verified against the server source and against a live
 * 0.36.9 node, which emits no `Server` header at all. It was three links of a
 * chain reaching for something that had never existed, and it survived because
 * a fallback that never fires looks exactly like a fallback that is never
 * needed.
 *
 * Removing it also settles a property worth keeping: this package now reads no
 * custom response header anywhere. Macha requires no custom request header
 * either — a node advertises the whole set it will accept as
 * `Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, Range`,
 * which is checkable with one request rather than by auditing source.
 *
 * The version is not one universal field across every endpoint — it is
 * `server_version` on the playback and catalogue status calls, and
 * `nodes[].version` on cluster status — so this stays tolerant of several
 * spellings rather than demanding one.
 */
function reportedVersion(body: Record<string, unknown>): string | null {
  for (const key of ['server_version', 'version', 'macha_version']) {
    const value = stringValue(body[key]);
    if (value) return value;
  }
  const server = objectValue(body.server);
  return (server ? stringValue(server.version) : undefined) ?? null;
}

export class MachaServerApi implements ServerApi {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly auth: AuthenticatedFetch = NO_AUTH,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async status(): Promise<ServerStatus> {
    const response = await fetchWithTimeout(
      (url, init) => this.auth.fetch(url, init),
      `${this.baseUrl}/api/v1/playback/status`,
      { method: 'GET', headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }) },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    const parsed = await readResponseBody(response);
    const playback = objectValue(parsed.body) ?? {};
    if (isGatewayConnectionFailure(response, parsed.wasJson)) throw serverUnreachable();

    const message = stringValue(playback.message)
      ?? stringValue(playback.error)
      ?? (response.ok ? null : `${response.status} ${response.statusText}`);

    return {
      version: reportedVersion(playback),
      playback,
      playbackAvailable: response.ok,
      httpStatus: response.status,
      message,
    };
  }
}
