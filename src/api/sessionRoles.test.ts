import { describe, expect, it } from 'vitest';
import { sessionLockedOut, sessionPermits } from './UsersApi.js';

describe('what a role list means', () => {
  describe('sessionPermits', () => {
    it('permits everything while the roles are unknown', () => {
      // A session record that has not answered — still in flight, node
      // unreachable, node too old to have the route — must not read as a
      // session with no privileges, or a client's navigation empties for
      // everyone the moment one node is slow. Guessing permissively gives a
      // control that errors when pressed; guessing the other way gives an
      // application that looks empty, which is indistinguishable from a
      // broken server.
      expect(sessionPermits(undefined, 'media_viewer')).toBe(true);
      expect(sessionPermits(undefined, 'manage_users')).toBe(true);
    });

    it('permits nothing once the answer is an empty list', () => {
      expect(sessionPermits([], 'media_viewer')).toBe(false);
    });

    it('is a membership test and expands nothing', () => {
      // Roles are capabilities, not a ladder. A client inferring that a
      // manager can obviously also import is reimplementing policy the server
      // already decided, and the two drift.
      expect(sessionPermits(['manager'], 'manager')).toBe(true);
      expect(sessionPermits(['manager'], 'importer')).toBe(false);
      expect(sessionPermits(['manage_users'], 'manager')).toBe(false);
    });
  });

  describe('sessionLockedOut', () => {
    it('locks out a session the cluster granted nothing', () => {
      // A real mintable state since server 0.38.4: removing media_viewer from
      // the anonymous account is how a registered-users-only deployment is
      // configured, and the mint returns a valid token with no roles.
      expect(sessionLockedOut([])).toBe(true);
    });

    it('never locks out a session whose roles are merely unknown', () => {
      // The distinction is the whole point. Collapsing it puts a login wall
      // in front of a viewer whose only problem is a slow node — one client
      // built exactly that and removed it before it shipped.
      expect(sessionLockedOut(undefined)).toBe(false);
    });

    it('does not lock out a session holding any role at all', () => {
      expect(sessionLockedOut(['media_viewer'])).toBe(false);
      expect(sessionLockedOut(['view_status'])).toBe(false);
    });
  });
});
