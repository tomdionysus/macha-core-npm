/**
 * Accounts, roles, and who the current session belongs to.
 *
 * Roles are **capabilities, not a ladder**. `importer` does not imply
 * `manager`, and nothing here expands one into another: the server resolves a
 * user's roles when the session is minted and the array it returns is the
 * closed set. A client that infers "a manager can obviously also import" is
 * reimplementing policy the server already decided, and the two will drift.
 */
export type UserRole = 'media_viewer' | 'importer' | 'manager' | 'manage_users' | 'view_status';

/**
 * Declared as a record so the compiler enforces completeness. A role added to
 * `UserRole` and forgotten here would exist in the type and be invisible in
 * every client's role picker — a silent failure four clients would each have
 * to discover separately. Key order is the listing order; insertion order is
 * guaranteed for string keys.
 */
const ROLE_LISTING: Record<UserRole, true> = {
  media_viewer: true,
  importer: true,
  manager: true,
  manage_users: true,
  view_status: true,
};

export const USER_ROLES: readonly UserRole[] = Object.keys(ROLE_LISTING) as UserRole[];

/**
 * `view_status` gates the cluster and node status screens — `/api/v1/status`
 * and `/api/v1/status/*` from server 0.38.5.
 *
 * It gates the *diagnostic* view: the node roster, per-node capacity, and who
 * is being asked for what. It does not gate liveness. Whether a node is alive
 * is answered by `/api/v1/health`, which needs no session and no role, and
 * that is the route this package probes — so nothing about health, ranking or
 * failover depends on a viewer holding this.
 *
 * Every existing capability implies it, resolved at mint, so no account that
 * could read Status before loses it and there is no migration. The case it
 * changes is a session the cluster granted nothing, which is a legitimate
 * state for a registered-users-only deployment: that session gets a refusal
 * rather than the node roster.
 */

/**
 * What may be changed about this user, decided by the server and stated per
 * field.
 *
 * The root and anonymous accounts are ordinary users that happen to be
 * protected, and the protection is **not** knowable from the username. A
 * client that tests `username === 'root'` is wrong the moment those names
 * become configurable, and it disables the wrong controls everywhere at once.
 * Render what this block says and nothing else.
 *
 * Protection is also not the only reason a field can be locked: removing the
 * last account holding `manage_users` is refused, and `setRolesBlockedBy`
 * distinguishes that from an account that is protected, so the UI can explain
 * which it is rather than greying a control for no stated reason.
 */
export interface UserMutability {
  rename: boolean;
  delete: boolean;
  set_password: boolean;
  set_roles: boolean;
  /** Present when `set_roles` is false because of the last-manager rule rather than protection. */
  set_roles_blocked_by?: 'last_user_manager';
}

/** Exact JSON shape exposed by Macha's users API. */
export interface MachaUser {
  id: string;
  username: string;
  roles: UserRole[];
  created_unix_ms: number;
  updated_unix_ms: number;
  /**
   * Bumped by a password or role change. Every session minted before the bump
   * stops validating cluster-wide, which is why a role change signs the user
   * out — a demotion that took up to thirty days to bite would not be a
   * demotion.
   */
  credential_generation: number;
  /** Last-write-wins counter, for optimistic concurrency once `If-Match` is wired. */
  version: number;
  mutable: UserMutability;
}

/**
 * Rules the server enforces on a password, so the client can check inline
 * rather than keeping its own copy.
 *
 * An object rather than a bare number so rules can be added without breaking
 * readers. Treat every field as optional and an absent one as "no such rule":
 * a client that requires a field it does not understand fails closed on a
 * server that is merely newer.
 */
export interface PasswordPolicy {
  min_password_length?: number;
}

/**
 * Who the current token belongs to and what it may do.
 *
 * This is the whoami. It needs a valid token and **no role at all**, which is
 * what makes it usable both for validating a cached session on reload and as
 * a health probe — including on a node whose catalogue is still recovering
 * and would answer anything else with a 503.
 */
export interface CurrentSession {
  /**
   * Identity, where the server states it.
   *
   * Optional because a deployed 0.37.2 node answers this route with `id`,
   * `roles` and two timestamps and nothing else: it has sessions but not yet
   * accounts. Typing these as required would be a promise about every server
   * that some servers do not keep, and a reader would discover it as the word
   * `undefined` rendered into the page rather than as a type error.
   */
  user_id?: string;
  username?: string;
  roles: UserRole[];
  expires_unix_ms: number;
  password_policy?: PasswordPolicy;
}

/**
 * What a session may do, where "we have not been told yet" is a third answer.
 *
 * Both of the rules below were written independently in two clients before
 * they were written here, which is the strongest argument for their being
 * policy rather than presentation: if two clients disagree about what a role
 * list means, the same account behaves differently on a television and a
 * phone, and nobody finds that quickly because neither client looks wrong on
 * its own.
 *
 * The unknown state is `undefined` rather than a separate `known` flag, so it
 * cannot be forgotten at a call site. A caller holding `roles` it has not
 * fetched has `undefined`, and gets the permissive answer by construction.
 */

/**
 * Whether this session may do the thing `role` gates.
 *
 * **Unknown is not none.** A session record that has not answered — still in
 * flight, the node unreachable, or a node too old to have the route — must
 * never read as a session with no privileges, or a client's navigation empties
 * for everyone the moment one node is slow. The failure of guessing wrong in
 * the permissive direction is a control that errors when pressed; the failure
 * of guessing wrong the other way is an application that appears to have
 * nothing in it. The first is recoverable and explains itself, the second
 * looks exactly like a broken server.
 *
 * Roles are capabilities and not a ladder, so this is a membership test and
 * deliberately expands nothing: see the note at the top of this file.
 */
export function sessionPermits(roles: readonly UserRole[] | undefined, role: UserRole): boolean {
  if (roles === undefined) return true;
  return roles.includes(role);
}

/**
 * Whether this session may do nothing at all, and so must be asked to sign in.
 *
 * An empty role array is a real state a server mints, not an error and not an
 * absence: from server 0.38.4, removing `media_viewer` from the anonymous
 * account is how a registered-users-only deployment is configured, and the
 * mint then returns a valid token alongside no roles. A client that reads that
 * as "something went wrong" shows an error for a cluster behaving exactly as
 * its operator intended.
 *
 * Distinct from `undefined`, which is the unknown state and is never locked
 * out — see `sessionPermits`. The distinction is the whole point: a client
 * that collapses them puts a login wall in front of a viewer whose only
 * problem is a slow node, and one of the four clients built exactly that and
 * removed it before it shipped.
 */
export function sessionLockedOut(roles: readonly UserRole[] | undefined): boolean {
  return roles !== undefined && roles.length === 0;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  roles: readonly UserRole[];
}

export interface UpdateUserRequest {
  username?: string;
  roles?: readonly UserRole[];
  password?: string;
}

export interface UsersApi {
  /** Every account. Requires `manage_users`. */
  list(signal?: AbortSignal): Promise<MachaUser[]>;
  get(id: string, signal?: AbortSignal): Promise<MachaUser>;
  create(request: CreateUserRequest): Promise<MachaUser>;
  /** Partial update. Omitted fields are left alone; a rejected field is a 403, never a silent no-op. */
  update(id: string, request: UpdateUserRequest): Promise<MachaUser>;
  remove(id: string): Promise<void>;
  /** The signed-in user's own record. Any authenticated user, no role needed. */
  me(signal?: AbortSignal): Promise<MachaUser>;
  /**
   * Change your own password.
   *
   * Accepts a password and nothing else — a roles change here would be an
   * escalation route open to every viewer. Returns a fresh token, because the
   * change invalidates the session that made it and being signed out by your
   * own password change is a bug, not a security measure.
   */
  changeOwnPassword(password: string): Promise<{ token: string; expires_unix_ms: number }>;
  /** Who this token is, what it may do, and the server's password rules. No role required. */
  currentSession(signal?: AbortSignal): Promise<CurrentSession>;
  /**
   * End this session server-side.
   *
   * Dropping the token locally is not a logout: the session stays valid
   * everywhere until it expires, and anyone holding the token keeps the
   * access. This revokes it, and the revocation propagates to every node.
   */
  logout(): Promise<void>;
}

/**
 * The account an empty set of credentials authenticates.
 *
 * Fixed rather than configurable: it is one of the two accounts the server
 * refuses to rename, which is what makes comparing against it safe. Nothing
 * about its *session* is special — it carries roles and is validated like any
 * other — but a viewer holding one has not chosen to be anyone, so the UI
 * offers them a way to sign in rather than an account to manage.
 */
export const ANONYMOUS_USERNAME = 'anonymous';

/**
 * Whether this session represents a person who has signed in.
 *
 * False for the anonymous account, and false where the server names no user
 * at all — an older node with sessions but no accounts cannot say who this
 * is, and offering "change your password" for a user it does not model would
 * be a promise nothing can keep.
 */
export function isSignedIn(session: Pick<CurrentSession, 'username'> | undefined): boolean {
  const username = session?.username?.trim();
  return username !== undefined && username !== '' && username !== ANONYMOUS_USERNAME;
}

/** Whether `roles` permits `role`. A plain membership test, stated once so no caller invents implication. */
export function hasRole(roles: readonly UserRole[] | undefined, role: UserRole): boolean {
  return roles?.includes(role) ?? false;
}
