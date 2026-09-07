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

function reportedVersion(body: Record<string, unknown>, headers: Headers): string | null {
  for (const key of ['server_version', 'version', 'macha_version']) {
    const value = stringValue(body[key]);
    if (value) return value;
  }

  const server = objectValue(body.server);
  const nested = server ? stringValue(server.version) : undefined;
  if (nested) return nested;

  for (const key of ['x-macha-version', 'x-server-version']) {
    const value = headers.get(key)?.trim();
    if (value) return value;
  }

  const serverHeader = headers.get('server')?.trim() ?? '';
  const match = /^macha(?:\/|\s+)([^\s]+)$/i.exec(serverHeader);
  return match?.[1] ?? null;
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
      version: reportedVersion(playback, response.headers),
      playback,
      playbackAvailable: response.ok,
      httpStatus: response.status,
      message,
    };
  }
}
