import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, readJsonBody, readResponseBody } from './httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import { isGatewayConnectionFailure, serverUnreachable } from './serverConnection.js';
import type {
  CreateUserRequest,
  CurrentSession,
  MachaUser,
  UpdateUserRequest,
  UsersApi,
} from './UsersApi.js';

/**
 * Codes the users API returns that a screen should place against a specific
 * field rather than show as a general failure.
 *
 * Named here rather than spelled at each call site: "which input was wrong"
 * is the whole value of an error code, and a toast at the top of a form
 * throws it away.
 */
export type UsersApiErrorCode =
  | 'username_taken'
  | 'reserved_username'
  | 'reserved_user'
  | 'password_rejected'
  | 'password_required'
  | 'last_user_manager'
  | 'cannot_delete_self'
  | 'too_many_users';

export class MachaUsersApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    /** The server's own sentence, for a host that shows it. Never core's text; `message` is for a log. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'MachaUsersApiError';
  }

  /**
   * Whether this is a permission refusal rather than a dead session.
   *
   * The distinction is load-bearing rather than cosmetic. A 401 means the
   * token is gone and re-minting is the right response; a 403 means the token
   * is fine and the user simply may not do this, so re-minting would loop
   * forever and present as a broken session instead of a refused action.
   */
  get forbidden(): boolean {
    return this.status === 403;
  }
}

/**
 * The account list.
 *
 * **`items` is the envelope.** It was `users` — this comment stated that as
 * fact, and the server has since moved the list under `items` like every
 * other collection in this API. `users` is kept because a node may be
 * stranded on an older build, and mixed-version clusters are the ordinary
 * case here; it is legacy, not an alternative spelling, and it goes when no
 * reachable node still answers that way.
 *
 * Being generous about the envelope is what made that change a non-event, and
 * it is why the accepted shapes are listed rather than assumed: single records
 * come back bare while collections come wrapped. Getting it wrong is silent —
 * reading a key a payload does not have yields `undefined`, which is not an
 * error anywhere downstream, so the screen renders its heading and nothing
 * else and looks broken rather than reporting a bad answer. An unrecognised
 * shape throws for exactly that reason.
 */
function userList(response: unknown): MachaUser[] {
  if (Array.isArray(response)) return response as MachaUser[];
  const envelope = response as { users?: unknown; items?: unknown } | null;
  for (const candidate of [envelope?.items, envelope?.users]) {
    if (Array.isArray(candidate)) return candidate as MachaUser[];
  }
  throw new MachaUsersApiError('The server returned an unrecognised user list.', 502, 'invalid_user_list');
}

export class MachaUsersApi implements UsersApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly auth: AuthenticatedFetch = NO_AUTH) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async list(signal?: AbortSignal): Promise<MachaUser[]> {
    const response = await this.request<unknown>('/api/v1/users', { method: 'GET', cache: 'no-store', signal });
    return userList(response);
  }

  get(id: string, signal?: AbortSignal): Promise<MachaUser> {
    return this.request(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'GET', signal });
  }

  create(request: CreateUserRequest): Promise<MachaUser> {
    return this.json('/api/v1/users', 'POST', {
      username: request.username,
      password: request.password,
      roles: [...request.roles],
    });
  }

  update(id: string, request: UpdateUserRequest): Promise<MachaUser> {
    // Only what the caller actually set. Sending `username: undefined` as an
    // explicit null would read as "clear it" to a server that distinguishes
    // absent from null, and a rename nobody asked for is a bad way to find out.
    const body: Record<string, unknown> = {};
    if (request.username !== undefined) body.username = request.username;
    if (request.roles !== undefined) body.roles = [...request.roles];
    if (request.password !== undefined) body.password = request.password;
    return this.json(`/api/v1/users/${encodeURIComponent(id)}`, 'PATCH', body);
  }

  async remove(id: string): Promise<void> {
    await this.request(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  me(signal?: AbortSignal): Promise<MachaUser> {
    return this.request('/api/v1/users/me', { method: 'GET', cache: 'no-store', signal });
  }

  changeOwnPassword(password: string): Promise<{ token: string; expires_unix_ms: number }> {
    return this.json('/api/v1/users/me', 'PATCH', { password });
  }

  currentSession(signal?: AbortSignal): Promise<CurrentSession> {
    return this.request('/api/v1/session', { method: 'GET', cache: 'no-store', signal });
  }

  async logout(): Promise<void> {
    await this.request('/api/v1/session', { method: 'DELETE' });
  }

  private json<T>(path: string, method: string, body: unknown): Promise<T> {
    return this.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetchWithTimeout(
      (url, requestInit) => this.auth.fetch(url, requestInit),
      `${this.baseUrl}${path}`,
      { ...init, headers: mergeRequestHeaders(init.headers, { Accept: 'application/json' }) },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) {
      const { body, wasJson } = await readResponseBody(response);
      if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
      const parsed = parseErrorEnvelope(body, `${response.status} ${response.statusText}`);
      throw new MachaUsersApiError(`Macha users request failed: ${parsed.message}`, response.status, parsed.code, parsed.detail);
    }
    if (response.status === 204) return undefined as T;
    return await readJsonBody<T>(response);
  }
}
