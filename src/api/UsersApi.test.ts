import { describe, expect, it } from 'vitest';
import { USER_ROLES, type UserRole } from './UsersApi.js';

describe('USER_ROLES', () => {
  it('lists every role, in the order a picker should show them', () => {
    // Four clients render their role pickers from this array, so both its
    // contents and its order are a contract rather than an implementation
    // detail. It is derived from a `Record<UserRole, true>` so the compiler
    // catches a role added to the type and forgotten here — this pins the
    // half the compiler cannot see, that key order survives the derivation.
    expect(USER_ROLES).toEqual([
      'media_viewer',
      'importer',
      'manager',
      'manage_users',
      'view_status',
    ]);
  });

  it('is a closed set with no duplicates', () => {
    expect(new Set(USER_ROLES).size).toBe(USER_ROLES.length);
  });

  it('holds view_status, which gates the diagnostic view and nothing else', () => {
    // Server 0.38.5 gates /api/v1/status and /api/v1/status/* behind it.
    // Liveness is /api/v1/health, which needs no session and no role, so
    // nothing about health, ranking or failover depends on a viewer holding
    // this — see LIVENESS_PATH.
    const role: UserRole = 'view_status';
    expect(USER_ROLES).toContain(role);
  });
});
