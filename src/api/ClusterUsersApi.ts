import type { MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { MachaUsersApi } from './MachaUsersApi.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import type {
  CreateUserRequest,
  CurrentSession,
  MachaUser,
  UpdateUserRequest,
  UsersApi,
} from './UsersApi.js';

/**
 * Users across the cluster: reads fail over, mutations execute once.
 *
 * The same split every other cluster API uses, and for the same reason — a
 * read retried elsewhere costs nothing, while a create retried after an
 * ambiguous failure makes a second account. Users replicate on change rather
 * than on a tick, so a read that follows a write by more than the propagation
 * hop sees it; there is deliberately no read-your-writes guarantee across
 * nodes, so a screen that creates and immediately re-reads should use the
 * record it was handed back rather than re-listing.
 */
export class ClusterUsersApi implements UsersApi {
  private readonly apis = new Map<string, MachaUsersApi>();

  constructor(private readonly router: ClusterEndpointRouter, private readonly auth: AuthenticatedFetch = NO_AUTH) {}

  list(signal?: AbortSignal): Promise<MachaUser[]> { return this.read((api) => api.list(signal), signal); }
  get(id: string, signal?: AbortSignal): Promise<MachaUser> { return this.read((api) => api.get(id, signal), signal); }
  me(signal?: AbortSignal): Promise<MachaUser> { return this.read((api) => api.me(signal), signal); }
  currentSession(signal?: AbortSignal): Promise<CurrentSession> { return this.read((api) => api.currentSession(signal), signal); }

  create(request: CreateUserRequest): Promise<MachaUser> { return this.write((api) => api.create(request)); }
  update(id: string, request: UpdateUserRequest): Promise<MachaUser> { return this.write((api) => api.update(id, request)); }
  remove(id: string): Promise<void> { return this.write((api) => api.remove(id)); }
  changeOwnPassword(password: string): Promise<{ token: string; expires_unix_ms: number }> {
    return this.write((api) => api.changeOwnPassword(password));
  }

  // A revoke executes once, like any other mutation. It propagates from
  // whichever node accepts it, so retrying it elsewhere would revoke nothing
  // new and could mask the first attempt having worked.
  logout(): Promise<void> { return this.write((api) => api.logout()); }

  private read<T>(operation: (api: MachaUsersApi) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.router.request((endpoint) => operation(this.api(endpoint)), signal);
  }

  private write<T>(operation: (api: MachaUsersApi) => Promise<T>): Promise<T> {
    return this.router.mutation((endpoint) => operation(this.api(endpoint)));
  }

  private api(endpoint: MachaEndpoint): MachaUsersApi {
    let api = this.apis.get(endpoint.id);
    if (!api) { api = new MachaUsersApi(endpoint.baseUrl, this.auth); this.apis.set(endpoint.id, api); }
    return api;
  }
}
