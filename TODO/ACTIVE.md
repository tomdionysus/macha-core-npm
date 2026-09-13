# Active

Open work for `@macha/core`. Items land here when they are decided-but-undone, or undecided-and-blocking. Anything finished moves to [COMPLETED.md](COMPLETED.md) with the version it shipped in.

An item says who it is waiting on. "Tom" means a decision rather than an implementation; "core" means it is mine to build; a client name means the evidence has to come from there before this can move.

---

## THE CURRENT PIECE OF WORK — one account model, no special anonymous

**Decided by Tom on 2026-09-13. This is `0.10.0` and it is a hard cut.** Every client refactors against it; there are no aliases, shims or staged migrations (three in-house consumers, rebuild them).

### STATUS: implemented on `develop`, NOT tagged — waiting on a client to go green

**All six steps are built and committed.** Version bumped to `0.10.0`, `dist` rebuilt, **719 tests in 60 files**, all five gates pass. Every client has been sent a tailored refactor brief.

**Do not tag until at least one client has swapped and run its suite.** That is not caution, it is the cheapest test available — the Android TV client found four real `hlsWalk` defects this morning purely by porting onto it, three of which came from the swap rather than from reading the code, and one would have destroyed every warm standby on that platform silently.

**Two judgement calls made during implementation that went beyond the letter of this plan**, both easy to reverse if Tom disagrees:
1. **`MachaHost.ephemeralStorage` was removed, not merely unused.** `SessionManager` was its only reader. Leaving a seam nothing reads would let a host set it expecting session behaviour and get none, which is worse than no seam.
2. **`signOut()` throws when the revoke fails**, after clearing local state unconditionally. The plan said "forget, then revoke" without saying what a failed revoke does. Swallowing it would let a client show "signed out" while the token is still live cluster-wide.

**Found during the rollout, before any client wrote a line of the port.** The phone client, scoping its migration against its own three-state gate (`unknown`/`granted`/`denied`), predicted the cold-start ordering would shift and that this is where a privileged viewer ends up on a login screen. It was right, and the defect was core's: **`settle()` ran at the top of `adopt()`, so the first notification a subscriber received carried `isReady === true` with no token and no roles** — momentarily indistinguishable from a session the cluster granted nothing. The window always existed; a *restored signed-in* session is what turned a harmless flicker into a signed-in administrator being shown a sign-in screen. Fixed, confirmed red first. **721 tests.**

*Worth generalising: that bug was found by a client reading a brief and comparing it against the shape of its own state machine, not by running anything. Writing the brief was what surfaced it.*

**One latent defect the clients must check for themselves.** The lossy cache meant a restored session lost its `username`. The phone client never saw it because it re-reads `currentSession` on every token change rather than trusting the cached record. **A client that trusted the cache was showing a signed-in viewer as anonymous after every restart.** `0.10.0` fixes it either way, but an affected client has user-visible behaviour about to silently correct itself and should know that rather than meet it as an unexplained change. Both remaining clients asked.

**What is waiting:** client swaps; then tag.

### The principle, in Tom's words

> The anonymous account is special in exactly three places, all server-side: it can't be renamed or deleted, it has no password, and it can mint a session with no credentials if allow-anonymous is enabled. **In every other respect, and especially for core — which shouldn't enforce even those edge cases — it is just another account, with variable roles.**

Core violated this in naming and, through the naming, in behaviour. The type is `AnonymousSession` and it is used for every session. `mintAnonymousSessionAnyNode(registry, credentials)` is a function called "mint anonymous" that takes a password. Everything below follows from that one wrong word: the cache drops `username`/`roles` on load (why keep them for anonymous?), storage is ephemeral for everything (an anonymous session's lifetime is the tab's), and a 401 re-mints and adopts whatever comes back without checking whose session it now holds (all sessions are anonymous, so who cares). **Four defects, one assumption.**

The corrected model is *simpler*, not more elaborate: **one `Session`, one mint, one storage policy, one post-mint check — did the account change?** No `kind` field. No branch on the account name. A comparison.

### What changes in core, in the order it lands

**1. Rename. Hard cut.** `src/api/SessionAuth.ts`, `src/api/SessionManager.ts`; 71 references in core.
- `AnonymousSession` → `Session`
- `mintAnonymousSession` → `mintSession`; `mintAnonymousSessionAnyNode` → `mintSessionAnyNode`
- `validateAnonymousSession` → `validateSession`; `validateAnonymousSessionAnyNode` → `validateSessionAnyNode`
- `SessionManager`'s class comment ("Owns the client's anonymous session end to end") and every comment that says "anonymous" where it means "a session" — fix as they are met. `isSessionRefusal`'s comment references the old name.

**2. The cache keeps the whole session.** `loadCachedSession` (`SessionManager.ts:313-323`) reconstructs `{ token, expiresAtMs }` and discards `username` and `roles` that `cacheSession` already wrote. Restore all of it. A restored session must be as informative as a freshly minted one, or core cannot do step 4.

**3. One storage policy, through one optional host seam.**
- `MachaHost` gains `secureStorage?: StorageLike`. **Every session goes there**, not only credentialed ones — a session is a session. Falls back to `storage` (persistent), **not** to `ephemeralStorage`. `SessionManager` stops reading `ephemeralStorage` entirely.
- The key becomes **`macha.session.v1`**, joining the dotted convention. Renaming costs nothing here because the storage move already forces one fresh mint on every client; doing it later would cost a second one. Record the retirement of `macha-session` and the remaining hyphenated keys as the next candidates.
- Consequence on web: sessions land in `localStorage` (was `sessionStorage`), so tabs share one and it survives a tab close. That is the model — a session is worth keeping — and the XSS exposure is unchanged *in kind*. The httpOnly-cookie path is a **separate, later** piece of work on the transport axis (`AuthenticatedFetch`, `credentials: 'include'`, core holding no bearer); it does not go through this seam and does not block this.
- Consequence on Tizen: app-private storage is the ceiling; it supplies nothing and falls back. **Say so in the seam's comment** rather than implying parity — core cannot make a platform safer than it is, only use what the host offers.

**4. The post-mint identity check — the general rule that replaces every special case.** After *any* re-obtained session — the 401 path in `fetch()`, the refresh timer, `mintNow` after a failure retry — **compare `username` before and after.** Same account → carry on silently (anonymous→anonymous included; nothing special about it). Different account → the session's identity changed; core records it and notifies, and the application decides what to show. Shape: `SessionManager.lastIdentityChange?: { from?: string; to?: string; at: number }`, cleared on the next `signIn`. **Core does not throw and does not guess at wording** — "your session ended", "your account changed", "you were signed out elsewhere" are all possible causes and the application knows its viewer. This is the fix for the silent administrator-to-anonymous downgrade, arrived at without a `kind` flag: tom→anonymous is a change, and that is all core needs to know.

   Core still *attempts* the credential-less re-mint on a 401 for a non-anonymous session, deliberately: the only thing it can present is nothing, and a session for whatever account nothing authenticates to is better than no session — anonymous browsing is still allowed. If the cluster refuses, `lastMintFailure` already says so. The check makes the outcome visible; it does not prevent it.

**5. `signOut()` is a server logout, and a fresh session is a separate call.** Per Tom's earlier ruling ("explicit server logout; then a separate call to get an anonymous token *if required*"). Today `signOut()` drops the token and **unconditionally** mints anonymous (`SessionManager.ts:234-244`). It becomes: `DELETE /api/v1/session` with the current token against any node (mutation semantics — once, not walked on refusal), then forget locally, then notify. **It does not mint.** The application calls `start(registry)` again when it wants a session, which bootstraps and mints with nothing. `UsersApi.logout()` stays for callers with no `SessionManager`, and its doc comment states the composition.

**6. Discoverable keys.** Export the list of storage keys core owns (`MACHA_STORAGE_KEYS` or similar, with the two conventions named until they are one), so a host filtering its own namespace can be correct without grepping a dependency. This is the fix for the phone client's silently-lost-session defect, which was caused by core shipping two conventions and naming neither.

### What does not change

`sessionPermits`, `sessionLockedOut`, `hasRole` — already role-based, already right. `roles`, `lastMintFailure`, `isReady`, `subscribe`, `AuthenticatedFetch`. `SessionCredentials`. The `0.9.0` refusal-versus-unreachable distinction.

### Nothing still Tom's — the refusal walk stays

- **The refusal walk** (`SessionAuth.ts:158-180`) — **decided 2026-09-13: keep.** On a 403 during mint, with credentials core stops (replicated table, every node agrees); without credentials it tries the next node, because allow-anonymous is per-node and one stale node must not speak for the cluster (observed live by the Android TV client). It is keyed on "was a credential presented", not on the account name, and it is a cluster rule rather than an anonymous rule — but it is core reasoning about a server edge case. **Recommendation: keep it.** Tom to confirm.
- ~~**`isSignedIn()` and `ANONYMOUS_USERNAME`**~~ — **decided, keep.** See *What the clients SHOULD special-case* below: it is the one display hint for "this session belongs to someone who chose to be someone", the users-screen special-casing is driven by the server's per-record `mutable` instead, and core enforces nothing.

### What the clients SHOULD special-case — and what they should not

**Tom, 2026-09-13:** the root and anonymous accounts *are* special in the UI, where it is obvious, and clients should treat them so. **There should be no option to rename or delete them; anonymous has no password and no change-password.** The web client already does this correctly and is the reference.

**The rule is "render what the server says is mutable", not "know the account's name".** Every `MachaUser` carries `mutable: { rename, delete, set_password, set_roles, set_roles_blocked_by? }` (`UsersApi.ts:61-68`), stated per record by the server, which is the only party that knows which accounts are protected and why. A client that greys a control because `mutable.rename === false` is right for root, right for anonymous, and right for whatever the server protects next; a client that greys it because `username === 'anonymous'` is right today and wrong the first time the rule moves. `set_roles_blocked_by` exists precisely so the UI can say *why* — protected account versus last-manager rule — rather than greying for no stated reason.

So:
- **Users screen** (`manage_users` role): rename, delete and set-password controls follow `mutable` per row. Anonymous and root will arrive with `rename: false`, `delete: false`; anonymous with `set_password: false`. **Do not hard-code the names.** Do not hide the rows — a manager should see that the accounts exist and see them as protected.
- **Account screen** (the signed-in user's own): a change-password control belongs to a session whose account has a password. `isSignedIn()` (`UsersApi.ts:244`) is the one core hint for this — it says "this session belongs to a person who chose to be someone" — and stays. It is the only place core compares against `ANONYMOUS_USERNAME`, it is a *display* hint, and its own comment already says the session itself is not special. **This closes the second open item above: keep it, as the hint it is.**
- **Core enforces nothing.** It does not refuse a rename of root, does not strip a password change for anonymous, does not filter the list. A client that sends one gets the server's `403` with `reserved_user` / `reserved_username` (`MachaUsersApiError` codes, `MachaUsersApi.ts:21-29`), which is the correct source of the refusal. Core's job is to carry `mutable` and the error code faithfully, which it does.

**Per client, against this:**
- **Web** — reference implementation. Nothing to change here; re-check only that it reads `mutable` rather than the name, since either passes today.
- **Phone** — has an account screen and a sign-in flow; verify change-password is gated on `isSignedIn()` and that no rename/delete UI exists for the protected rows if it has a users screen.
- **Android TV** — likely no users screen yet. When one is built, build it from `mutable` from the start.
- **Tizen** — the web client's build; inherits the reference behaviour.

### Every client refactors. Notes per client.

**All four:**
- Import renames, if they import `AnonymousSession` or the mint/validate functions directly. Most go through `SessionManager` and are unaffected by the rename.
- **A cold start is no longer an anonymous session.** Sessions persist and are validated on reload. Anything that assumes "app launched ⇒ nobody is signed in" is now wrong. Check onboarding, first-run, and any "sign in" prompt shown unconditionally at launch.
- **Subscribe to `lastIdentityChange`** and decide what to show. The phone client re-reads `currentSession` on every notification so its marker self-corrects; it should now read the explicit signal instead of inferring from the marker moving. Web and both TVs have nothing here today and will silently downgrade an administrator until they add it.
- **`signOut()` no longer mints.** Call `start(registry)` after it if the screen wants an anonymous session. A client that calls `signOut()` and then renders "signed out" while expecting to keep browsing will find itself with no token until it does.
- **Playback must be stopped before `signIn` and `signOut`** — unchanged obligation, now stated on both doc comments. A session created under the old identity cannot be closed after the token changes and holds a transcode slot for `session_idle`.

**Web client** (`macha-client`):
- Supplies no `secureStorage`. Sessions move from `sessionStorage` to `localStorage`: **tabs now share a session** and a session survives closing the tab. Its `useSession` and anything keyed on tab lifetime should be reviewed. This is the intended behaviour.
- `AccountMenu.signOut` (`src/components/AccountMenu.tsx:51-64`) calls `api.logout()` and never `sessionManager.signOut()`, so it carries a revoked token until a later 401. It becomes `sessionManager.signOut()` then `sessionManager.start(...)`. It has already agreed to land this *after* core states the composition, because today every logout fires the downgrade path by design.
- The httpOnly-cookie question is **its** future work with the server, on the transport axis. Not this release.

**Phone client** (`macha-client-rn`):
- Supplies `expo-secure-store` as `secureStorage`. **The bearer is in AsyncStorage plaintext today** — readable on a rooted device or in a backup — and this is the change that fixes it.
- Its AsyncStorage hydration filter (fixed 2026-09-13 to accept both `macha.` and `macha-`) keeps working; after the key rename the session is under `macha.session.v1` and the hyphenated branch becomes dead code it can drop when the last hyphenated key is retired.
- Drop the `stop()`/`start()` probe workaround for `probeNow()` (already told; unrelated but same refactor pass).

**Android TV client** (`macha-client-androidtv`):
- Supplies a Keystore-backed store as `secureStorage` (`expo-secure-store` runs on Android TV). If it cannot, it supplies nothing and falls back to app-private storage — say so in its own notes rather than assume.
- Has no identity-change handling today. On a D-pad UI with no console, a silent downgrade is the worst possible failure shape: sections vanish, nothing explains why. This is the client most in need of step 4.

**Tizen** (the web client's Samsung build):
- Supplies nothing. App-private storage, no hardware backing. Document the ceiling; do not pretend parity.

**Server** (`macha-server`): nothing required. Worth asking for: a `code` on the 401 that distinguishes *expired* from *invalidated by `credential_generation`* from *revoked*, so core can pass a cause through `lastIdentityChange` rather than only the fact. Not blocking.

### Sequencing

One release. Steps 1–6 are one model change and splitting them would ship an intermediate model nobody wants. Land on `develop`, name the surface to all four clients, **let at least one swap and run its suite before tagging** (see the rule under *Start here*: a client porting onto a seam is the cheapest fuzzer for it). Then `0.10.0`.

### Superseded by this plan

The items further down titled *Persisting a sign-in*, *Session manager state gaps* (sub-items 1–3 and the 401 downgrade), *Two clients disagree about what logout means*, and *Core ships two storage-key conventions* are all absorbed here. They are left in place for their reasoning and marked as superseded; do not work them separately.

---

## Start here if you are new to this

**Where things stand.** `0.9.0` is the current version, bumped on `develop` and **not yet merged to `main` or tagged** — that is the first thing to do if you are picking this up. Work happens on `develop`; a release is an annotated bare-semver tag (`0.9.0`, never `v0.9.0`) on `main`, and the version bump goes *inside* the release commit so the tag points at exactly what ships. Sixteen tags exist, `0.2.0` through `0.8.1`.

**How to check you have not broken anything:** `npm run typecheck`, `npm run lint:platform` (the no-DOM gate — this is the one that catches a browser global sneaking into core), `npx vitest run`, `npm run build`, `npm run dist:check`. The suite is **656 tests in 59 files, all passing** as of 2026-09-13. Run all five; `dist:check` is the one that catches a source change nobody built.

**Never put Claude attribution in a commit message.** No `Co-Authored-By`, no `Claude-Session`, no generated-with line. A commit message ends with its last line of prose. This cost a full history rewrite of 16 commits across `main`, `develop` and two release tags on 2026-09-13.

**Four clients consume this package** — a web/TV app, a Samsung Tizen build of the same, a React Native phone app, and a React Native Android TV app. **All four now resolve it through a `file:` link** — the web client was switched to a symlink on 2026-09-13 (`"@machafoundation/core": "file:../macha-ts"`, `node_modules/@machafoundation/core` → `../../../macha-ts`), which retires the long-standing note here that it held a real installed copy. *That note was stale and this file asserted it for a whole session; the web client corrected it.*

**But the link does not mean they see your working tree.** It resolves through `"main": "./dist/index.js"`, so every client compiles against your **last build**. A change on `develop` is invisible to all four until `npm run build` runs here. The web client's `pretest` runs `cd ../macha-ts && npm run dist:check`, which catches a stale `dist` — **at test time only, not at typecheck time**, so a client can typecheck green against bytes that do not match this tree. Build after changing source or you silently block their suites.

Most of the defects below were found *from outside*, by those clients; that is the normal way this package learns it is wrong.

**Two clients do not use `PlaybackCoordinator` at all.** The phone client calls `ClusterPlaybackResolver.failover` directly and never prepares an alternate. So a fix landed in the coordinator reaches three clients of four, and a defect on the coordinator path does not reach the phone. **Check which layer a client actually uses before telling it a fix matters to it.**

**How to find out you are wrong, cheaply: ship a seam to a client before releasing it.** On 2026-09-13 the Android TV client swapped onto core's new `hlsWalk` and ran its existing suite against it, and **three of its four findings came from the swap rather than from reading the code** — including one that would have destroyed every warm standby on that platform silently. The `blob()` defect surfaced only because that client's test doubles were shaped around `arrayBuffer()`, which its deleted implementation had used. *A client porting onto shared code is a cheap fuzzer for the assumptions in it*, and it works because the seam is on `develop` where a `file:` link picks it up, not behind a release. Do this deliberately: land the seam, name it to the client, let it swap, and fix what the swap finds before tagging.

**How to be wrong here, in the three ways this project keeps finding.** Each has cost real time:

1. *Inferring a difference instead of reading both bodies.* Two findings in the 2026-09-12 review were wrong this way. `codegraph_explore` returns both bodies in one call.
2. *Attributing a measurement to the wrong node.* Two separate findings on 2026-09-13 were measurements of `inverbeg` (gbni-2, still on 0.38.1) reported as another host, and the same mistake cost the DTS/TrueHD investigation a day in September. The host is in the URL — record which one served the number.
3. *Reading a transient as a steady state.* A `503 starting` read as a permanent gate, a `403` mid-deployment read as a configuration. Both on 2026-09-13, both retracted.

**The rule that settles most boundary questions** (Tom's): *would nearly every conceivable client be required to do this? If yes, core. If not, theirs.* And the one that settles most design questions: no component may assume another is live or healthy, and a dying component's evidence is not evidence.

---

## P0 — nothing open

All five P0s from the 2026-09-12 review shipped in `0.9.0`. The last of them, the connection-gate lockout, was waiting on the server to choose between two fixes; server 0.38.5 answered it with `GET /api/v1/health`.

---

## Shipped on `develop` since `0.9.0`, not yet released

All of it is built, so the four `file:`-linked clients see it now; none of it is tagged. Run the five gates before releasing. **702 tests in 61 files.**

- **`hlsWalk.ts`** — both HLS walks absorbed over one shared target primitive, with the five client divergences resolved. See the audit item below for the two that were defects rather than differences.
- **`EndpointHealthMonitor.probeNow()`** — the off-cycle probe. Coalesces with a cycle in flight; does not resurrect a stopped monitor.
- **`PlaybackQueueStore` / `ContinueWatchingStore`** — reactive-safe. Two of the four the file named needed nothing; see that item.
- **`MediaStallWatchdog`** — the timeline-discontinuity fix, the re-arm after `suspend()`, and the budget comment that overclaimed.
- **`ArtworkRef` / `ArtworkSource` comments** — the artwork id is the cache key. See the artwork item; core ships nothing else there.

---

## P1 — correctness

**The order Tom set on 2026-09-13**, and the only thing in this file that is a sequencing instruction rather than a judgement: work the *Android TV audit* items first — the HLS preflight walk, then volume and mute, then the artwork source plan — and **then** the watchdog item below.

**That order survived the decisions of the same day with one change.** Audit item 3, artwork, is no longer core's to build on its own schedule: Tom rejected lifting the clients' policy and wants a better approach, so it is blocked on evidence from the clients and from the server. It therefore **stops being third in this queue** and becomes a design item that runs alongside. What remains strictly ordered is: HLS preflight walk, then volume and mute, then the watchdog.

**The `probeNow()` question was asked again and Tom asked back** whether there was something more important. There is — the watchdog's backward-seek defect is live on a client today, and `probeNow()`'s absence has a workaround that works. But `probeNow()` is twenty lines against a client that is working around it now, so the honest answer is that it is not *more important* and is still worth doing in the same sitting rather than queueing behind a week of work. Do not ask a third time.

The watchdog's first sub-item is a live defect on the Android TV client rather than a latent one, which is why it comes before the rest of P1 once the audit is done.

### ~~Watchdog blind spots on the platform it was written for~~ — all three shipped
**Waiting on:** nobody. Shipped on `develop` 2026-09-13; kept here until released.

The discontinuity fix turned out **not to be rewind-specific**: a forward seek landing short of the old high-water mark fails identically, so the test is "did the position or the buffered end move *backwards*", either of which means the timeline being measured no longer exists and ordinary playback can do neither. Both re-base the mark and count as progress in their own right, because a seek is not a stall. All three were confirmed red first.

The original description follows, since the reasoning is what makes the tests readable. `src/playback/MediaWatchdog.ts`.

1. **Backward seek defeats the baseline — take this one first.** `lastBufferedEndMs` is a running max, so after a backward seek buffer growth at the new position never counts as advancing and a healthy below-realtime transcode is evicted 7 s later, which is the eviction the class comment says it exists to avoid. **On Android TV the D-pad *is* the seek affordance** and `PlayerScreen.nudge()` commits a `runtime.seek` after every rewind burst, so it would condemn healthy nodes as ordinary viewing, not as an edge case. The observable would be a failover roughly 7 s after any rewind. Web and phone have scrubbers people touch rarely, which is what kept it invisible.

   **This is derived from reading the code, not observed. Do not describe it as a live defect.** This file previously called it "a live defect on the Android TV client rather than a latent one" and cited that client as the evidence. Asked directly on 2026-09-13, that client answered that **nothing has ever played on that television** — not one film started, no watchdog fired, no failover seen — so its not having observed this is worth nothing either way, and core had been leaning on a confirmation that never existed. The reasoning about why it lands hardest there still stands; the field evidence is **zero on every client**. When a set does answer, a rewind→failover pairing is one of three causes that client will be separating (the others: the missing hold-aware 500 retry on the same node, and a genuine node fault), and fixing the second will change what the first looks like.
2. **No re-arm after `suspend()`.** `lastPositionMs` is kept and only `note()` re-arms, but `note()` returns early unless something advanced. Pause, node dies, resume: nothing advances, nothing arms, frozen forever. Only "paused is not stalled" is tested.
3. **The +1 s margin comment overclaims.** It says the budget only has to outlast the hold, but the watchdog reads only `currentTime`/`buffered` and a `500` carries no bytes; hold + player retry delay + first byte exceeds 7 s. Either record the real relationship or say plainly that holds do trip it and that is accepted.

### ~~No way to ask for an off-cycle probe~~ — shipped
**Waiting on:** the phone client to drop its `stop()`/`start()` workaround; it has been told. Shipped on `develop` 2026-09-13.

Two decisions worth keeping: a cycle already in flight is **awaited rather than duplicated**, because two concurrent cycles would probe every endpoint twice and race each other's persist; and a **stopped monitor stays stopped**, because resurrecting a torn-down loop makes teardown conditional on nobody holding a reference. The re-base test was confirmed red against a version that left the pending timer in place.

The original description follows. `src/cluster/EndpointHealthMonitor.ts`.

A mobile client watching the radio knows the network came back well before the next 10 s cycle, and there is no way to say so. `stop()` then `start()` works and is safe — `stop()` aborts the controller and clears it, `start()` returns early only when a controller exists, and the in-flight cycle discards its results at the abort check — but it throws away a probe already in flight and restarts the interval from zero. The phone client is doing exactly that.

Wanted: a `probeNow()` that runs a cycle immediately without tearing the loop down, and re-bases the interval from that probe. A radio coming back is the one moment the cluster's state is most likely to have changed and the viewer is most likely to be waiting, so the ten seconds is a real cost rather than a tidy-up (Law 2).

Worth pairing with a decision about whether the monitor should watch anything itself. It cannot see a radio — that is a host fact — so the seam is right; only the trigger is missing.

### `GET /api/v1/users` changes envelope — core is already right, the comment will not be
**Waiting on:** core, for a comment. `src/api/MachaUsersApi.ts:50-72`.

The server is changing the list envelope from `{"users": [...]}` to `{"items": [...]}`, matching every other collection in the API. It asked whether to hold the change until core is ready. **It does not need to hold anything:** `userList` already accepts a bare array, `users`, or `items`, and throws a typed `invalid_user_list` on anything else. Being generous about the envelope was written in deliberately and has just paid for itself. Single records from POST/PATCH stay bare and are unaffected.

What *does* need doing is the doc comment above it, which currently states as fact that "the server wraps this collection under `users` — not `items`". After the server ships, that is **inverted** — the same trap as `Platform.ts:13` below, where an accurate-when-written comment becomes an instruction to do the wrong thing. Rewrite it to say `items` is the envelope and `users` is the legacy one, kept because **`gbni-2` is stranded on `0.38.1` and still emits it**. That is the only reason the tolerance survives, so it belongs in the comment — otherwise a later session deletes the branch as dead and breaks the one node nobody can upgrade.

**The ownership half is already true and was reported as if it were not.** The operator asked core to "take ownership of that endpoint and give the web client a typed accessor". `UsersApi`, `MachaUsersApi` and `ClusterUsersApi` have been exactly that since `0.8.0`.

**And the shim is not the web client's.** It checked rather than recalled: `api/v1` appears four times in its `src`, none of them a request — two in comment prose, two in a playback test fixture — and it consumes users entirely through core's `UsersApi` via `createMachaServices`. So it gets the envelope change for free without knowing it happened, which is what the accessor is for. **The accept-either shim is sitting unremarked in one of the other three trees** (phone, or one of the two TV clients) and the server session has been told to chase it there. Worth chasing rather than shrugging at: a client that hand-handles a wire format will not notice the *next* change either. Same pattern as the register's closing note — a client routes around core, and nobody goes back once core is right.

### Background discovery records real routing evidence
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:230`; `src/services/createMachaServices.ts:67`; `src/cluster/endpointRouting.ts:144-166`.

`clusterStatusApi` routes through `route()`, so each 10 s discovery call does `recordSuccess`/`recordFailure`. A status timeout permanently un-sticks the preferred endpoint — precisely what `recordProbeFailure` exists to avoid — and a success elsewhere steals preference. Contradicts `EndpointHealthMonitor.ts:192` ("owns no server or playback state") and `endpointRouting.ts:21-23`. Fix: an advisory path using the probe variants.

### A storage write error kills the health loop silently
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:237-238`; `src/runtime/configuration.ts:148-151`.

`persistConfirmedEndpoints` → `setItem` is uncaught. A `QuotaExceededError` (TVs) rejects `cycle()`, the `void` swallows it as an unhandled rejection, no reschedule runs, and `running` stays `true`. `EndpointBandwidth.write()` catches for exactly this reason — two copies of one rule, disagreeing. Fix: try/catch the persist, reschedule in a `finally`.

### `Platform.ts:13` inverts the hold status for adapter authors
**Waiting on:** core. One-line doc fix.

It says a hold answers `503 segment_not_ready`, while `streamProtocol.ts:42` says 503 is a broken generation and terminal, and `:54` maps 503 with 404 to `stream`. **Not merely inconsistent — inverted.** An author following the public seam makes both mistakes at once and in opposite directions: retrying the terminal status, and condemning the node on the benign one. Both shipped adapters are already right (`PlayerEngine.kt:450` retries 500), so this is a trap for the next author rather than a live defect. Fix the comment, not the docs: `docs/writing-a-player.md` is already correct and is what people actually read.

### Persisting a sign-in — the cache is lossy in the field that decides everything
**SUPERSEDED — absorbed into the plan at the top of this file. Kept for its reasoning; do not work separately.**
**Waiting on:** Tom, on the scheme. Raised by the phone client 2026-09-13, relaying a requirement from Tom that **signing in be permanent until logout across all four clients**. *That requirement reached core second-hand; confirm it before changing how a bearer is stored.*

**The finding, and it is core's:** `cacheSession` serialises the whole `AnonymousSession`, but `loadCachedSession` (`SessionManager.ts:313-323`) reconstructs only `{ token, expiresAtMs }` — `username` and `roles` are parsed and discarded. **A restored session is structurally indistinguishable from an anonymous one**, so after a reload core cannot tell it was ever signed in.

That one gap explains three items this file has been treating separately:
1. **Sign-in does not survive a restart.** `signIn` (`:219-222`) caches into `this.storage`, which is `machaHost().ephemeralStorage` — `sessionStorage` on web. A credentialed session dies with the tab *by construction*.
2. **The silent anonymous downgrade** in the item below. Core answers a 401 by re-minting, and a re-mint without credentials is an anonymous mint; it cannot do better while it does not know the session was credentialed.
3. **The storage-tier question.** "Anonymous is disposable, credentialed is worth keeping" is unanswerable while core cannot tell them apart at the point of persistence.

**Core's position, given to the phone client:**
- **First, and needing no new seam: the session must know what kind it is.** Record the kind in the cached record, route persistence by kind, restore it on load. Entirely internal, and **every candidate scheme needs it**, so it lands first regardless of what Tom picks — and it unblocks the 401 fix at the same time.
- **Then `secureStorage?: StorageLike`**, optional, credentialed-only, falling back to `storage`. The host names its own safe place (Keychain/Keystore via `expo-secure-store`) rather than core guessing; a host supplying nothing keeps today's behaviour. *The phone client stores the bearer in AsyncStorage plaintext today — readable on a rooted device or in a backup.*
- **Not the callback alternative**, for now: it still hands the host a token, so it does not solve the web case that partly motivates it, and it makes the common case harder — three clients wanting a safer slot would each write a store.
- **The web httpOnly-cookie answer is a different axis and must not be forced through `StorageLike`.** A cookie means core holds no bearer at all, which is transport and auth (`AuthenticatedFetch`, the `Authorization` header, `send()`), not storage. A storage seam contorted to express "no storage" cannot say what it means. If web goes cookie-based the shape is a mode where core holds no token plus `credentials: 'include'`; **separate work, must not block this.** Put to the server session by the phone client.
- **Tizen has no hardware backing** — app-private storage only. Document that core cannot make a platform safer than it is, only use what the host offers, rather than implying parity.

### Core ships two storage-key conventions and documents neither
**SUPERSEDED — absorbed into the plan at the top of this file. Kept for its reasoning; do not work separately.**
**Waiting on:** core for the doc/export; Tom for any rename.

Audited 2026-09-13, every literal in the package:
- **`macha-` hyphenated:** `macha-session`, `macha-client-id`, `macha-server-url`, `macha-bootstrap-endpoints-v1`, `macha-discovered-endpoints-v1`, `macha-server-endpoints-v1`, `macha-probe`, `macha-storage-probe`
- **`macha.` dotted:** `macha.continueWatching.v1.*`, `macha.playbackQueue.v1.*`, `macha.playlists.v1.*`, `macha.musicPlaylist.v1.*`, `macha.volume.v1.*`

**This cost the phone client a real defect.** It namespaces its own keys `macha.` and hydrated AsyncStorage with a `startsWith('macha.')` filter — which matches one of core's two conventions exactly and misses the other, **including the session**. The token was written faithfully on every launch and never read back. Nothing errored and nothing logged, because an anonymous session re-mints in milliseconds; the only symptom was *a person* being signed out on every cold start, which nobody notices until an account matters. **Not a careless filter — a foreseeable consequence of core shipping two conventions and naming neither.**

Fix now: **make core's owned keys discoverable** — documented and exported — so a host filtering its own namespace can be correct without grepping a dependency. **Do not rename yet:** `macha-session` is the key whose rename signs out every user on every client simultaneously, so it belongs with the storage scheme above and its migration, not ahead of it.

### Session manager state gaps, and the roles work landing on them
**SUPERSEDED — absorbed into the plan at the top of this file. Kept for its reasoning; do not work separately.**
**Waiting on:** core. `src/api/SessionManager.ts`. **Take these three together — they are all the mint and re-mint paths, and fixing them twice would be worse than once.**

1. `authorization()` hands out the dead token during a reactive re-mint, because `mint()` never clears the rejected token. The doc on `fetch()` claims the opposite.
2. `start()` during an in-flight bootstrap adopts the *old* registry's result and never contacts the new one; `mintNow` then reports the corrected config as unreachable. The doc "safe to call again if the registry changes" is false in that window.
3. Refresh timers overwritten without clearing; `stop()` clears only the last.

**Item 3 of the original four shipped in `0.9.0`** — refusals are no longer charged as endpoint failures or reported as unreachable, and `lastMintFailure` carries the real error. Only the three above remain.

**And the one the accounts work adds:** a 401 no longer means only "expired". A password or role change bumps `credential_generation` and invalidates every earlier session cluster-wide, deliberately, so a mid-session 401 is now normal. `SessionManager` answers a 401 by re-minting, and a re-mint with no credentials is an *anonymous* mint — so an administrator whose roles change is **silently downgraded to anonymous**: sections vanish, writes fail, and nothing says they were signed out. It disguises an auth event as a UI bug. The session must remember whether it was authenticated: anonymous 401 keeps re-minting invisibly; an authenticated 401 must stop, surface that the session ended, and let the application choose. The cached-session path on reload needs the same distinction.

The phone client has covered the *display* half — it re-reads `currentSession` on every notification so the marker self-corrects — and deliberately did not invent a "you were signed out" event, because the cause is core's.

**`0.9.0` supplies the parts this needs but does not do it.** `SessionManager.roles` now tracks what the session may do and clears when the token goes, and `lastMintFailure` distinguishes a refusal from an outage — so the remaining work is the *decision* the session has to make: remember whether it was authenticated, keep re-minting invisibly for an anonymous 401, and stop and surface the end of the session for an authenticated one. The server session confirmed a 401 from `GET /api/v1/session` can mean the account changed underneath the token rather than expiry, so a client must not tell a viewer their session timed out.

### Two clients disagree about what logout means — decided
**SUPERSEDED — absorbed into the plan at the top of this file. Kept for its reasoning; do not work separately.**
**Waiting on:** core. `src/api/UsersApi.ts:128-135` (`logout`), `src/api/SessionManager.ts:148-166` (`signOut`).

**Tom decided on 2026-09-13:** if you know you have revoked a token, you should not be using it at all. So logout is an *explicit server logout*, and obtaining an anonymous token afterwards is a **separate call, made only if one is actually required**. The phone client's composition is the correct one; the web client is wrong, has confirmed it (`AccountMenu.signOut` calls `api.logout()` and never `sessionManager.signOut()`), and will change. State it on the `UsersApi.logout` and `SessionManager.signOut` doc comments — the only place all four clients read. The conditional half is the part a client will otherwise get wrong: the web client's instinct was to always re-mint.

**This interacts with the 401 downgrade below, and the two want to land in one order.** The web client's observation, which core had not made: because it keeps the revoked token, the *first* request after signing out 401s and re-mints anonymously — so **the silent-downgrade path fires on every single logout today, by design rather than by accident**. Once it moves to the ruled composition, the logout case stops depending on that path and the role-change case becomes the only caller, which makes the downgrade fix easier to reason about and easier to test. So: **core states the composition first, the client follows.**

They are different operations and both are needed. `logout()` revokes server-side and the revocation propagates; `signOut()` drops the token locally, clears the cache and mints a fresh anonymous session. Core's own comment says dropping the token locally is not a logout.

The phone client calls `logout()` then `signOut()`, and reports a failed revoke rather than swallowing it. The web client calls `logout()` and never `signOut()`, so it holds a revoked token until a later 401 forces a re-mint, and every request in between carries a token the server has already revoked.

One of them is wrong and core is why: it ships two operations whose correct composition is written down nowhere. **Do not merge the behaviours or pick by preference** — compare the cases and state the answer on the API, the only place both clients read. The phone client's reading matches core's own comment, which is the stronger position.

### Playback must be stopped before sign-in and sign-out, and nothing says so
**Waiting on:** core. Doc change at minimum.

Changing identity does not close playback sessions — nothing connects them — and **after the token changes, a session created under the old identity can no longer be closed.** The node then holds it against `max_video_transcodes` until `session_idle`, 30 minutes, on nodes with one slot. The ordering is an obligation on every caller, the fix is cheap, and the failure is invisible from the client that causes it. That combination should not be left for four clients to rediscover. Belongs on the `signIn` and `signOut` doc comments; same slot arithmetic as *Teardown has a ceiling* below.

### Smaller correctness items
**Waiting on:** core.

- **README seeding snippet defeats discovered-endpoint persistence.** `README.md:89-92` seeds discovered endpoints through `bootstrapEndpoints([...])`, labelling them `bootstrap`, so `applyAdvertisement` never marks them `discovered`, `persistConfirmedEndpoints` persists `[]`, and discovered history is wiped on every second start. Fix: `bootstrapEndpoints(discovered, 'discovered')`, plus a seed-then-persist round-trip test.
- **An emptied bootstrap set is persisted and treated as configured.** `runtime/configuration.ts:78`, `:88-93`, `:102-106`. `setBootstrapEndpoints([])` writes `{urls: []}`; `[]` is truthy, so `environmentEndpoints` is never consulted again and the client is permanently unconfigured after a "clear". `setDiscoveredEndpoints` already removes the key when empty — the two setters disagree.
- **`TorrentJob.catalogue` is declared required but version-gated.** `api/AcquisitionApi.ts:72`, "since 0.28.1", and the package supports mixed-version endpoint sets with no runtime check. Make it optional; absent stays absent.
- **Success bodies are assumed to be the envelope.** `MachaCatalogueApi.ts:61-62,127-128,191-203`, `MachaAcquisitionApi.ts:41-52,99-109`, `MachaManageApi.ts:32-33`. A 200 with HTML throws a raw `SyntaxError` the router treats as non-retryable, so "Unexpected token <" reaches the viewer with no failover; a JSON 200 missing `items`/`jobs` throws `TypeError` at `.map`, which the router treats as a *transport* failure and cools down the node for a schema mismatch. Fix: validate shape and throw a typed `invalid_response`, as `mediaProfile` already does at `:88`.
- **`ClusterPlaybackFactsApi` records per-title faults as endpoint evidence.** `:63-67` lacks the `!isPerTitleFailure(error)` guard `ClusterPlaybackResolver.create:268` has, so one unreadable extent demotes the node for every title.

---

## Decided by Tom on 2026-09-13 — asked for by clients, not core's to decide

Four client sessions reported into core on 2026-09-13. The defects among their findings shipped in `0.9.0`; what was left was where the boundary falls, and a boundary decided unilaterally is how four clients end up adapting to the wrong thing.

**Every question in this file was put to Tom on 2026-09-13 and every one came back.** Nothing here is waiting on him now. The decisions are recorded at their items, and the two he answered with "no" or "later" — shared TV navigation, and the pairing/QR format — are recorded as **closed** rather than deleted, so they are not raised a third time. The one item he turned into a question of his own, `probeNow()`'s priority, is answered in the P1 preamble above.

**Settled, recorded so they are not raised again.** `view_status` is in `UserRole`. A role-less session learning no cluster membership is *correct* — it sees only the endpoint it was configured with. `sessionPermits`/`sessionLockedOut` and the session's roles are in core, so both clients delete their copies. And `MODE_TRANSFORMS` **does not move**: the server session confirmed core's recorded 0.34.0 behaviour is current in 0.39.1 — `parse_preferences` resets `video`, `audio`, `max_height` and `max_bitrate` the moment `mode` is named, so the contradiction that rule guards against cannot be assembled. The client **has deleted its copy** (2026-09-13), without being able to run the PATCH test — driving a live PATCH needs a `media_viewer` credential and the anonymous account has none, which is the same wall the server session hit. It deleted rather than holding it pending a test because it had never observed the refusal itself: the rule was inherited from the web client and written up as established. If a refusal ever does appear, the evidence to capture is the exact body, status and `code`.

### The web client moved to `0.9.0` — done, and it cost nothing
**Waiting on:** nobody. Closed on 2026-09-13.

**Tom decided yes; the web client had already done it.** It reports `npm run typecheck` clean and 44 files / 291 tests passing against `0.9.0` on `develop`. Tom was also right that it had been switched to a **symlink** — the "real installed copy" claim at the top of this file was stale and is now corrected there.

**The predicted break did not happen, and the rule it came from was wrong.** This file said the cost would be `view_status` failing the build of its `Record<UserRole, string>` maps, and that both RN clients passed *because they hold no such map*. The web client holds **three** (`ROLE_LABELS` and `ROLE_DESCRIPTIONS` in `src/screens/UsersScreen.tsx:24,32`, `ROLE_LABELS` in `AccountScreen.tsx:15`) and passed anyway, because `0.14.0`'s role-gated navigation had already put `view_status` in all of them. So the rule is **"clients that already knew about `view_status` passed"**, not "clients with no map passed" — a difference that matters the next time a `UserRole` is added, because the map is not the hazard, ignorance of the role is. *Recorded as a correction: core predicted a breakage in a client from the outside and got the mechanism wrong.*

Still on the table for the web client, as gains rather than obligations: deleting its `sessionPermits`/`sessionLockedOut` copies against core's, picking up `SessionManager.roles`, `lastMintFailure` for its connection gate, and `EndpointCandidate.ready`.

The two React Native clients resolve core through a `file:` link and were moved onto `0.9.0` silently when one of them rebuilt `dist` on 2026-09-13; both have since built against it cleanly and reported the specifics. The web client has a **real installed copy** in `node_modules`, so it sees none of this until someone rebuilds and reinstalls, which is a dependency change it will not make unilaterally.

What it costs when it happens: `view_status` fails the build of its `Record<UserRole, string>` label maps until it adds a label and a description. That is the whole of the breakage — both RN clients passed precisely *because* they hold no such map. Everything else it reads (`candidate.health` in StatusScreen) is unchanged.

What it gains: `sessionPermits`/`sessionLockedOut` and `SessionManager.roles` to delete its own copies against, `lastMintFailure` so its connection gate stops being raised by a refusal, and `EndpointCandidate.ready` for the Cooling down / Retry eligible split.

### The Android TV audit — all three decided on 2026-09-13
**Waiting on:** core for the first two; the clients for the third. In the order to take them:

1. **~~The HLS preflight walk~~ — shipped as `hlsWalk.ts`, both walks.** Exported from the package root: `preflightHlsSource`, `probeHlsReadiness`, `hlsWalkTargets`, `resolveUrl`, plus `HLS_WALK_TIMEOUT_MS` and the parse helpers. **Two of the five divergences were defects, not differences** — the non-manifest answer (core ships the TV client's `true`; the web client's `false` was destroying promotable standbys), and a deadline of 5 s in *both* copies against a 6 s `SERVER_SEGMENT_HOLD_MS`, so a node producing its first fragment could never pass and a standby seconds from servable was destroyed as unreachable. The new constant asserts the inequality rather than a number, so it cannot drift back. Neither client deletes its copy until it has swapped and run its suite. The reasoning that got it here follows.

   **The HLS preflight walk — into core. Decided.** Tom's reasoning was the boundary rule applied plainly: if it is everywhere, it is core's. Duplicated in two clients today — `preflightWebHlsSource` in the web client (`macha-client/src/platform/WebPlatform.ts:71-144`), `src/player/preflight.ts` on Android TV. Manifest one variant deep, `Range: bytes=0-65535` each media target, require bytes. Core keeps the `Player.preflightSource` seam and additionally ships the walk, which a host calls.

   **Take BOTH walks, over one shared target-extraction primitive — not preflight alone.** The web client's readiness walk (`WebPlatform.ts:146-215`: `probeFirstFragment`, `NATIVE_HLS_FIRST_FRAGMENT_TIMEOUT_MS`, `statedRetryMs`, `refusal`) is built on the *same* target extraction, differing mainly in `Range: bytes=0-0` and in treating `500 segment_not_ready` as a **hold with a `Retry-After`** rather than a failure. The Android TV client was told by Tom to build that walk there on 2026-09-13 — moving to `expo-video` lost `PlayerEngine.kt:450`'s same-node hold-aware retry and it now fails over spuriously under load — so a *fourth* copy is imminent. Taking preflight alone leaves the manifest walk half in core and half in two clients, and leaves the hold semantics duplicated. **The hold semantics are a protocol rule about what a node means by a 500, not presentation**, and core already documents them wrongly in one of the two places an author reads (see the `Platform.ts:13` inversion below) — duplicating them into a third tree is how that inversion spreads. The Android TV client has been told to build against core's seam rather than free-standing.

   **The five real divergences, read off both trees by the Android TV client on 2026-09-13** — two were known, three were not, and one of the three is a *decision* rather than a merge:

   - **Relative URL resolution.** RN's `URL` strips one trailing slash from the base and concatenates (`Libraries/Blob/URL.js:112-121`), so `.../abc/index.m3u8` + `seg1.m4s` becomes `.../abc/index.m3u8seg1.m4s`. **Core ships a real RFC 3986 §5.3 resolver with `.`/`..` normalisation and does not call the host's `URL`.** Explicitly *not* an injected seam — if both clients inject the same correct implementation, core has absorbed nothing. (Core's original plan was to inject only `fetch` and leave resolution to the platform. That was wrong.)
   - **Cache suppression.** RN's `fetch` is an XHR polyfill and silently ignores the `cache` option, so it needs `Cache-Control: no-cache, no-store` + `Pragma: no-cache` as request headers. **A cache-busting query parameter is specifically wrong here**: media is reached by signed capability URLs and appending a parameter alters what was signed. Record that, because it looks like the obvious fix to anyone who does not know the signing scheme.
   - **The non-manifest answer is inverted, and core is taking the Android TV answer.** Web returns `false` for `!source.isManifest`; Android TV returns `true`. `false` means "this node will not serve" and the coordinator destroys the standby on it (`PlaybackCoordinator.ts:1305`) — but a non-manifest source is one the walk **cannot assess**, not one it has judged. `isManifest` is stated by the resolver and `types.ts:265` says in as many words never to infer it from the extension or the mode, so the two answers are only guaranteed identical in a browser. **Reporting an inability to measure as a failure is the same error that once made every Samsung standby fail its own validation**, and is the third entry in this file's own how-to-be-wrong list. Core ships `true`. Shipping the web answer would have started throwing away promotable standbys on the TV client.
   - **Header forwarding.** Android TV forwards `source.headers` on the manifest fetch and each media fetch; the web copy forwards nothing beyond `Range`. Build the union *with* headers. **`Range` must be non-overridable** — the TV client currently spreads `{ Range, ...NO_CACHE, ...source.headers }`, so a source header could override `Range` and silently turn a range probe into a full segment fetch that nobody would notice until a television pulled the lot. Core applies `Range` last; source headers beat cache headers.
   - **Body-reader guard.** Android TV guards `!body?.getReader`, not just `!response.body`; RN can hand back a `body` that exists without a `getReader`, which the web check sails past and then throws. Both fall back to `arrayBuffer().byteLength > 0` — and on RN **that buffered path is the normal one, not the fallback**, which is worth saying in the comment because the web-shaped reading is that it is rare.

   Everything else is line-for-line the same shape: two-level descent, `#EXT-X-STREAM-INF` detection, `#EXT-X-MAP` URI extraction, first-non-tag-line playlist pick, dedupe, 5 s `AbortController`, `finally clearTimeout`. **Neither client deletes its copy until core's version has landed and the signature has been named to them.**
2. **Volume and mute — REVERSED on the same day. Core ships nothing.** Tom first said "explicit mute please"; shown the proposed model, he reversed it: *"Don't second guess the client. If the user muted, or starts with zero volume, that's what you do. That's not core. In fact, why is this in core at all? It's player logic."* **So there is no mute concept in core and `state/volume.ts` is unchanged.** The Android TV client's `{effective, setting, muted}` model was right and stays in its tree.

   He is also right about the boundary, and the code agrees more than the first reading did: `VolumeStore` is 27 lines that clamp a number and write it to storage, and `PlaybackRuntime.setVolume` forwards straight to the player **without ever reading the store** — the two were already disconnected. **Whether `VolumeStore` is deleted outright is open and Tom's**; it has one caller. Deleting it is a hard cut across four clients, so it waits on him rather than on the hard-cuts rule alone.

   **What followed, and it goes further than the mute question.** The web client audited everything volume-shaped in core and found four things of unequal merit:
   - **`VolumeStore` — MOVE OUT, one copy per client. Two consumers, confirmed. Waiting only on Tom.** Verified: **zero consumers inside this package**, only its own file and test — so core genuinely has no stake. **Exactly two consumers outside**: the web client (`App.tsx:263`), and the Android TV client, which wired it *on 2026-09-13* (`MachaProvider.tsx:95`, `hooks/usePlayerVolume.ts`). **The phone client is not a third** — confirmed with corroborating evidence rather than a bare absence: it imports neither `VolumeStore` nor `setVolume`, and its `PlaybackProvider` holds a constant `intendedVolumeRef` whose comment states the client offers no in-app volume control because a phone has hardware buttons and a system slider. So: **web and Android TV, one local copy each**, which is what the per-client `macha.volume.v1.<clientId>` key shape implied from the start. Sequence: both clients take their copy, *then* core deletes — no build breaks at any point. The first report said "the only consumer in the world"; that was wrong, and the grep behind it was probably *right when it ran* — the second consumer appeared the same day. **When the consumer is a separate repo with its own session, ask the session; do not grep the tree.** No amount of care with the search would have helped. The phone client has not answered, so a third consumer is still possible. And it cannot be universal by core's own evidence — `SamsungWebPlatform.initialVolume()` returns 1 with a comment saying the television owns volume and a stale persisted value must not be inherited; a phone is the same. So it is a browser-page preference living in a package whose whole claim is that it assumes no browser. **Waiting on Tom** (a cross-client hard cut) and on the two RN clients confirming they do not import it. Sequence agreed with the web client: it takes a local copy *first*, then core deletes, so the code never exists nowhere.
   - **`Player.setVolume` — made optional. Shipped 2026-09-13, with a doc comment corrected hours later.** The change stands; the *reason* first published for it did not. It is optional because **whether a host has an app-level volume is platform-specific** — a Tizen widget has none and leaves it to the set, an Android TV player on Media3 has a real one independent of the television's own output stage — **not** because no host implements it. The first comment claimed televisions and phones leave volume to the hardware so only a browser has an app-level level: that is one television (Samsung, where `initialVolume()` returning 1 is correct) generalised into all televisions. It also argued from core's three `Player` fakes implementing the member emptily. **A fake implementing something emptily says nothing about what real hosts need** — a shipped adapter implements this for real, setting the level *and* remembering it, because a warm standby is primed at `0` and must come up audible when promoted. That inference is now *warned against* in the comment rather than quietly removed: two people found it convincing enough to publish, which is the definition of something needing a note.
   - **`PlaybackRuntime.setVolume`** — a one-line passthrough that exists only to carry the above. Goes with the store, if the store goes.
   - **`Platform.initialVolume?()` — keep.** It is the one that earns its place: *whether the host owns audio at all* is a genuine cross-client fact, and it already expresses the only part of volume that varies by platform. It is also what makes the other three unnecessary.

   *Recorded as a process note: core proposed matching a client's model and told that client so before the decision was made. The client was told of the reversal.* The original reasoning, now superseded, was: `state/volume.ts` persists a bare clamped number and has no concept of mute, so each client decides what to write when a viewer mutes — and writing `0` is indistinguishable from turning the sound down, so the next launch comes up silent with nothing explaining why.

   **The Android TV client has already solved this and core is matching its model rather than inventing one** (`src/player/volume.ts`; it has never written `0`). Every one of these is a correctness rule about the store, not a preference:

   - State is a **triple, not a number**: `{ effective, setting, muted }`. `effective` is what the player is set to (0 while muted); `setting` is what persists and what unmuting restores, and is **never 0 because of a mute**.
   - **Adjusting the volume while muted unmutes.** A control that moves a number while staying silent reads as broken.
   - **Unmuting a `setting` of 0 restores to a `MINIMUM_AUDIBLE` floor** (0.1 there), not to 0 — otherwise unmute is a control that visibly does nothing.
   - `VOLUME_STEP = 0.05`; a non-finite input clamps to 1.

   **Mute does not persist across launches — the level does.** This sub-decision was not in Tom's instruction and is core's reading, agreed with the Android TV client: persisting mute reintroduces the silent-launch failure through the front door, since a set that comes up muted with no explanation is the same bug as one that comes up at level 0, and "the television is broken" is the same wrong conclusion. **Flagged to Tom as the one open sub-decision.** If he wants mute persisted, core must additionally require clients to surface a launched-muted state on screen rather than leave it silent.

   An independent argument for mute being its own concept, from the same client: `0` **already** carries a second unrelated meaning inside the player — `ExpoVideoAdapter.setVolume` caches the level because a standby is primed at `volume = 0` so it cannot be heard behind the active source, and must come up at the real volume on promotion. One number carrying "muted", "turned down" and "primed standby" is overloaded three ways.
3. **The artwork source plan — not a straight lift. Decided against; redesign pending evidence.** Tom's position: the caching is inadequate and he wants a better approach, rather than core enshrining the policy both clients already invented. So the original proposal — lift the drop-header/walk-nodes/remember-the-last-URL policy as-is — is **not** what happens. See the item below, which now carries the mechanism.

#### Artwork caching — the mechanism, from the web client
**Waiting on:** the server, for one measurement; then core, to design.

**The cause is a wire-format decision, not a client failing to cache.** The server **re-signs a capability URL's `exp`/`sig` on every catalogue fetch of the same artwork**, even when nothing changed and the previous signature is still valid. A signed URL is therefore a **new HTTP cache key on every catalogue read**, so `Cache-Control` never gets the chance to matter — the key is churning, not revalidating.

The web client's countermeasure, all in `src/components/LazyArtwork.tsx`: a module-level `lastLoadedUrlById` map of the last URL that *actually loaded*, placed ahead of the fresh candidates from `artworkUrls()` so a same-image resign is ignored and the browser's copy is reused; a failure deletes the entry and walks to the same capability on the next node; once every node refuses, it falls back to an authenticated Blob path that carries the bearer token and so survives an expired signature.

**Three distinct holes — do not design against the first alone:**
- `lastLoadedUrlById` is **in-memory and module-scoped**, so it dies on reload and does not exist in a new tab. Within one page life a revisit is a cache hit; across a reload every poster is a cold download of bytes the browser already holds.
- It only works where an `<img src>` is the loader. It cannot help the Blob path, a cold start, or any client that is not a browser with an HTTP cache. **That is the argument for a stable cache key rather than a smarter client**, and therefore for the fix being partly the server's.
- Tom's bar, verbatim: images "load slowly, and when 'cached' they're just less slow. Changing anything or waiting for a minute or two, and they all load from scratch again. It's crap." The *waiting a minute or two* half is **unexplained** — the remembered-URL map should survive that within a page, so either something remounts or `Cache-Control` is short or absent. **Not measured. Do not design around a guess** (the third way to be wrong, at the top of this file).

**The requirement, stated best by the Android TV client: core needs to expose an identity for the BYTES that is separate from the URL that fetches them.** A content hash, an etag, an id+version — anything stable across a re-sign. Then a client keys its image cache on identity and treats the signed URL as a transport detail. **That single absence explains every symptom in this item.** Its sharpest evidence is a lint suppression: that client's memo is a `useMemo` whose dependency list is `[api, artwork?.id]` while the body reads `artwork.url`, carrying an `eslint-disable-next-line react-hooks/exhaustive-deps`. The rule is telling the truth — the correct React dependency is precisely the thing that destroys the cache — so the code has to lie. That is a design smell, not a style problem.

**Two clients independently built the same hack with the same two holes** (module-scoped, so unbounded within a session and empty across a restart). Android TV adds four more, all verified on its tree: a whole class of artwork **cannot be displayed there at all** — refs with no `url` and every source with `requiresAuthorization` are dropped, because a native `Image` cannot carry a header and there is no `URL.createObjectURL` for the web client's Blob fallback, so they render as a letter placeholder; `Image.onError` **carries no HTTP status**, so "expired signature" and "this node refused" are indistinguishable; the node walk is **one-way and never recovers** (`index` only increments, no retry or backoff, so a wifi blip blanks a poster for the life of the mount — the web client's `artworkRetry` is not ported); and memory/disk behaviour on the panel is **unmeasured**, with no instrumentation and nothing ever having played on that set.

**Answered by the server on 2026-09-13, and core ships nothing.** The whole item resolves to one server change plus both clients keying on a hash they already had:

- **The stable identity already exists.** `ArtworkRef.id` **is** the SHA-256 of the artwork bytes — content-addressed, identical on every node, identical across every re-sign, and already on the wire. Core's own `MachaMediaApi` has been caching Blobs on it all along. Both clients had the key and neither could see it, because nothing said so. **Fixed: the comments on `ArtworkRef` and `ArtworkSource` now say it.** No new API.
- **Header-free URLs are already guaranteed**, and the Android TV report that a class of artwork is unrenderable cannot be caused by the `requiresAuthorization` drop: `artworkUrls` emits the signed capability, then that capability re-hosted onto every node, all header-free, before any authenticated URL. The residue is refs arriving with no `url` at all. Client asked to re-check; **treat "a whole class cannot be displayed" as unverified.**
- **`Cache-Control` was never the problem** — already `public, max-age=86400, immutable`, tied to the capability TTL. No `ETag` on that route, deliberately.
- **The re-sign is the bug and is the server's.** `exp` was computed per call at millisecond granularity, so there was **no window in which the URL was stable** — no bucket length for anyone to hunt for. Fixed server-side in `0.40.0` (built, tested, **not deployed**): `exp` rounds up to the bucket *after* next, so a URL is byte-identical within a bucket and still carries 24–48 h of validity rather than dying in a client's hand; identity across the separately-signing list and item routes is pinned by test.
- **Core predicted the wrong consequence and was corrected.** I said the expired-capability path would fire *more* often under bucketing. It fires *less*: `exp` is never nearer than a full TTL at signing, and it is the *stability* window the bucket bounds, not *validity*. The case that does fire — a payload held across a boundary in persisted state — is already covered by `MachaMediaApi.test.ts`'s "re-hosts an expired capability nowhere", which does not depend on why `exp` passed.
- **One symptom remains unexplained, and must not be quietly counted as fixed.** Tom's "waiting a minute or two and they all load from scratch" was **never** the bucket expiring, because there was no bucket. Its cause is unmeasured. The web client is taking one poster across a reload and across a minute. **Take it before `0.40.0` deploys** — afterwards the URL churn stops and, if the cause is a remount, the symptom becomes invisible while remaining real.

The original questions, now all answered:
1. What `Cache-Control` does a node actually send on an artwork response? If it is not long-lived and `immutable`, no client-side scheme saves this.
2. Is the per-fetch re-signing necessary at all?
3. **Is `exp` bucketed, or does the same id signed twice differ within one second?** The web client's question, and it may explain Tom's complaint better than the re-sign story alone: a coarse bucket gives a cache key that is stable for a while and then churns — which is exactly "cached ones are just less slow, and after a minute or two they all load from scratch again". The bucket length would then be the number that matters.
4. Can a stable byte-identity be exposed (hash/etag/id+version)?
5. Can a **header-free URL form** be guaranteed? If yes, the `requiresAuthorization` drop and the blob-to-file work disappear everywhere. If not, core must own a blob-to-file policy and say so, since the implementation is platform-specific but the policy is not.

The framing that follows: media posters are content-addressed, immutable, and any node serves the same bytes, so **a signed URL with a per-fetch expiry is the wrong shape for a cache key**. Fix the shape and the clients' memos delete themselves; leave it and four clients write that memo forever.

**Declined:** `REASON_TEXT`. The strings are presentation. The real risk is an unmapped `PlaybackDecisionReason` rendering as a raw identifier, and the cheap answer is a non-localised fallback sentence as `errorMessage` already does — not a string table in core. The client did not push for it either.

**Not asked for, listed so the boundary stays visible:** the spatial focus scorer (geometry deciding what a viewer looks at next is presentation) and the alphabet strip (pure rendering over `titleIndex`).

---

## P1 — design and contract

### Speaker layout is not a concept core has
**Waiting on:** Android TV client (measurement), then core.

`choosePlaybackInstruction` decides audio purely on codec and never reads `channels`. `PlaybackCapabilities` has a field for what a device can *decode* and none for what its output can *render*. So a 5.1 track on a device that lists `eac3` is copied through untouched, and whether it is folded down to two speakers is entirely the device's business.

There is a live report of exactly that — 5.1 playing into stereo with no downmix — and it is unresolved. The Android TV client is the best evidence available: it builds capabilities from `MediaCodecList`, so it correctly reports `ac3`/`eac3`/`ac4`, and it will show whether Media3 folds down cleanly. Either answer is useful. If it does not, this is core's gap rather than a device setting.

If it becomes real work, the shape is roughly: a render-capability field on `PlaybackCapabilities`, and a channel target on the instruction — which needs the server to accept one, so it is a wire question too.

### ~~Four state stores are not safe for a reactive caller~~ — two fixed, two did not need it
**Waiting on:** nobody. Shipped on `develop` 2026-09-13; all four clients told.

**It was two, not four, and this file was wrong about the other two.** `PlaybackQueueStore` and `ContinueWatchingStore` now have `subscribe` and a stable `getSnapshot`, matching `PlaylistStore`; both identity tests were confirmed red. (`ContinueWatchingStore` **currently** has one consumer rather than being safe — the same accident of who happens to read it that the queue enjoyed until a second controller arrived.) But **`VolumeStore` returns a number**, and a primitive is stable by value, so it had no identity problem — and Tom ruled the same day that volume behaviour is player logic that does not belong in core at all, so extending it would have built in the wrong direction. **`MusicPlaylistStore` is superseded** by `PlaylistStore`, which adopts its key on first read; giving a store that should be deleted a new reactive surface would entrench it. *Another instance of the file's own rule: two of four were asserted to disagree without both being read.*

**The web client checked and found the real shape, which was not the predicted one.** It had never subscribed, so no memo was going stale — but `PlaybackQueueStore` **already has two consumers**, not the hypothetical future second one this file assumed: one owner holding `load()` in `useState`, and a music controller that calls `load()` then `insertNext`/`append` and hands the result back through a single `onQueueChange` callback. Correct today, held together by that one callback, asserted by no test. So **the queue is where a client's subscription work should start, not the playlist** — the playlist was the original evidence but is the case with one owner. Worth recording that the finding was reached only because the client was told to look, and that what it found was not what was predicted.

`PlaylistStore` exposes `getSnapshot()` with a stable reference, as `useSyncExternalStore` requires. `playbackQueue`, `continueWatching`, `musicPlaylist` and `volume` return a fresh array or object on every call. Fine for imperative callers, wrong for reactive ones, and **all four clients are reactive**.

The failure is not theoretical and is not merely untidy: a hook that subscribes to a revision counter and then calls `list()` memoises on the store, whose identity never changes, so the list freezes at whatever it first computed. Code that looks correct, producing a list that silently stops updating. The web client's playlist controller works today only because exactly one component owns it — a second consumer would diverge with nothing to point at.

One store doing this right and four not is worse than none doing it, because a caller cannot tell which is which.

### Three gaps in the `Platform`/`Player` contract
**Waiting on:** core, with design against the web client. **Now has a consumer waiting rather than being speculative.**

Found by the React Native clients pushing on the contract from outside. All three are defects in what core ships, not in their discipline:

1. **`Platform.createPlayer(): Player` assumes one player per platform.** React Native switches engines per queue item — expo-video for video, react-native-track-player for `kind === 'track'`, which is what gives background audio and lock-screen controls. A mixed queue of episodes and music cannot be expressed as one player created once. Preferred fix: let the coordinator tolerate the player instance changing between source generations, rather than passing a kind to `createPlayer` — the latter moves the assumption into an argument. **The Android TV client's Tier 3 needs exactly this**: a second `VideoPlayer` rendering into an off-screen view, then swapping which instance the view holds. Confirmed achievable on expo-video — `VideoView`'s player setter checks `hasSentFirstFrameForCurrentMediaItem` on the incoming player and holds the shutter open for a pre-warmed one, and `preflightSource` via fetch needs no player cooperation at all. **"React Native cannot do seamless failover" is false and should not be repeated.**
2. **`attach(host)` / `detachHost()` is imperative surface ownership.** A React Native video surface is a declarative `<VideoView player={...}>` owned by the render tree. The DOM *type* is gone; the shape is still wrong.
3. **No channel for OS transport commands.** Lock-screen play/pause/next/seek are queue-level commands and `Player.subscribe` carries player-to-client events only. This is a hole rather than a mismatch, and it would have stayed missing indefinitely because the web client never needed it.

---

## P2

### Probe a standby before promoting it
**Waiting on:** core.

Specified, not built. `GET /api/v1/playback/sessions/{id}` returns `engine_running` and `segments_ready` **only when an engine is present**, so their absence is the "reclaimed, needs a cold start" signal — one cheap round trip, and the same GET renews the 30-minute session timer without touching the 60 s pipeline clock.

Promotion should expect a cold start rather than counting the promotion as failed. Deferred because the standby path was changing rapidly and one thing at a time was worth more than speed.

### `find` cannot distinguish absence from partial failure
**Waiting on:** core.

`ClusterEndpointRouter.find` returns `undefined` both when every node says "not available" and when some said that while another failed with a 5xx. Deliberate — it stops optional metadata blocking playback on an unrelated node failure — but for playback facts the two are different answers, because absent means *transcode everything*, silently.

Shape: report whether the walk ended on unanimous absence or on absence-plus-failure, without changing the return for callers that do not care.

### The accounts layer shipped under-tested
**Waiting on:** core.

`UsersApi`, `MachaUsersApi` and `ClusterUsersApi` shipped in `0.8.0` with no test file at all and no review. `0.8.1` added the first coverage on the credential path and `MachaUsersApi.test.ts` followed. **`ClusterUsersApi` still has none** — it is the routing wrapper, so the untested part is exactly the failover-and-record-evidence behaviour that the rest of the cluster wrappers have been bitten by (see the per-title-fault item above, which is that same bug in a sibling).

### Coverage, and where the remainder is
**Waiting on:** nobody — **deferred by Tom on 2026-09-13**: "not at this time, we'll update later." Do not spend a session on this; the description below stands for when it is picked up.

Was 93.4% statements and 84.4% branches at 600 tests; now 656 and not re-measured. The gap is concentrated in `PlaybackCoordinator` and `PlaybackRuntime`, whose uncovered branches are the failure paths that only fire in specific combinations — failover racing a seek, a promotion during a pending mutation. Each needs a scenario built rather than an assertion added, which is why it is the slow part and also why it is the part worth having.

**What the review named and is still uncovered**, each tied to an item above: `canSeek: false`; watchdog resume after suspend and after a backward seek; degrade during failover; discovery failure demoting the sticky endpoint; persist throwing; restart mid-bootstrap; reactive re-mint; malformed success bodies; an empty bootstrap list; malformed continue-watching entries. `ClientLog` has one test.

`0.9.0` closed the rest of that list: two failure signals from one dead source, a late admission after the deadline, three-endpoint ranking, the no-facts fallback's container, retry preserving container and chooser-ness, a standby with a mismatched served container, refusal versus unreachable, and a 401 on the pre-save check. Every one of them was written red first, and two were red in the shape that matters — they did not fail, they hung until the harness killed them.

---

## P3

### Music library state moves into core — decided
**Waiting on:** core. **Tom decided on 2026-09-13:** yes. His note is worth keeping with the item — *capabilities differ, but core should handle this* — which says the per-client differences are not an argument against the move, they are the thing core absorbs.

Favourites, play counts with a commit threshold, recently-played with a cap. It exists once, in the phone client, and nothing platform-specific is in it. **One implementation is the cheapest moment to move something** — two is a negotiation about constants nobody wants, and the failure is silent: the same library ranking differently in two clients is not something anyone reports.

### Offline and cache policy needs a seam, not a move — approved
**Waiting on:** core, to design. **Tom decided on 2026-09-13:** yes, there should be a common way to do this. Related to the artwork item above, which is the same complaint about caching arriving from the other direction — design them with each other in view.

Four decisions are common to the phone's downloads and the web's read-ahead worker: content-addressed identity as the key, always the original bytes, a bounded frontier, and a failed speculative read treated as non-terminal. The transfer mechanism can never be shared.

One correction already established: "a failed speculative read is not a playback failure" is **already** core's `subscribeDegradation`/`subscribeFailure` split, which gained `not-ready` for exactly that case. It should feed that seam rather than build a parallel one.

The real work is deciding, per constant, whether it is a rule (shared) or a tuning (per host). Getting that wrong is how a shared module grows a `platform === 'ios'` branch.

### Teardown has a ceiling no client can close
**Waiting on:** server (raised, undecided).

`PlaybackRuntime.terminateForPageExit()` rides on `keepalive`, which is browser-only. React Native ignores it and Tizen 3 does not have the property. But the missing property is incidental: **the real cause is process death** — a host that is force-quit, crashes or loses power sends nothing by any mechanism, and no client-side change can fix that.

The cost is not local: a node holds a session's transcode entitlement for `session_idle` — 30 minutes — so on a one-slot node the next viewer gets `429 resource_limit` and nothing points at the client that caused it. There is no server-side mitigation today: no shorter idle for a session nothing was ever fetched from, and admission refuses rather than evicting. Both have been raised, and the second changes admission from a guarantee into a lease, so it is not a small ask.

Calling this promptly is the whole of the defence until one exists. Documented on the method and in the README.

### Shared TV navigation — declined, closed
**Waiting on:** nobody. **Tom decided on 2026-09-13: no.** TVs are sufficiently different that a shared package is not worth having. So there is no `@macha/tv`, and the duplication of the spatial D-pad focus scorer between the two TV clients is **accepted**, not merely unresolved.

The original reasoning still holds and is recorded so this is not reopened: core is everything a client does that is **not** presentation, and geometry deciding what a viewer looks at next is presentation. The mitigation that remains is the one both TV clients already have — tests pinning the weights on each side, so a drift is at least loud. Nothing for core to do.

---

## Low — the register

Verified, each real, none urgent. Grouped by area so a session cleaning one area can take the set.

**Coordinator and playback**
- `PlaybackCoordinator.ts:1207-1250` — both promotion paths record the endpoint failure and then call `resolver.stop()` on the same node, which records again when the DELETE throws. The same double-charge `releaseFailedSession` was just fixed for, one door over; the resolver has no seam for "close this, the node is already known bad" that a coordinator can reach.
- `PlaybackCoordinator.ts:1153-1189` — `degrade()` does not check `failoverPromise`, so a degradation during failover POSTs a redundant standby on a third node. Churn, not a leak.
- `PlaybackCoordinator.ts:698-718` — `close()` does not await `failoverPromise`, so `closePromise` can resolve while a failover POST is in flight, against the runtime's stated invariant.
- `PlaybackCoordinator.ts:1327` — the transcode standby window is keyed on `alternate.mode === 'transcode'`; if the entitlement is video-only, `transform.video === 'transcode'` is the precise test. The 8 s comment records the slot cost but not the quantity it must exceed.
- `PlaybackCoordinator.ts:1313-1318` — no disposed/revision re-check after the awaited preflight.
- `PlaybackStatus.ts:12` — header says "only ever from `output.container`" while the code falls back to `output.format`.
- `MachaPlaybackResolver.ts:243-253` — `reconcileQualityCaps` skips `mode: 'remux'` and runs on `resolve()` but not `update()`, against its own doc.
- `MediaTechnicalProfile.ts:21-23` — dead ternary with identical branches; `MachaPlaybackFactsApi.ts:45` passes `dolby_vision_profile: 0` through where the other normaliser treats 0 as "not probed".

**Cluster and routing**
- `EndpointRegistry.ts:397-407` — sticky is checked before the both-cooling order, so a sticky node on a 30 s cooldown is walked before a non-sticky one on 0.5 s.
- `EndpointRegistry.ts:495-505` — capacity never expires; `observedAt` is written and never read.
- `EndpointHealthMonitor.ts:136` + `EndpointRegistry.ts:495` — capacity keyed by `api_endpoint` string, so a typed IP versus an advertised hostname yields the same node twice and the in-use bootstrap entry never gets capacity.
- `EndpointRegistry.ts:713-715` — `notify()` does not isolate listeners; a throwing host listener turns a succeeded `route()` into a rejection and can kill the monitor loop. `publishConnectionState` already guards.
- `EndpointHealthMonitor.ts:106-148` — no abort check after `stop()`; an in-flight discovery still applies advertisement and fires listeners.
- `EndpointBandwidth.ts:17-20,124-126` vs `EndpointRegistry.ts:101,563` — restore re-enters at one sample and the threshold is two, so persisted throughput never ranks. `EndpointRegistry.test.ts:266-269` pins the current behaviour.
- `EndpointHealthMonitor.ts:69,164,235` vs `serverConnection.ts:41-44` — a proxy's bodiless 502/503/504 counts as reachable and clears the outage state forever.
- `EndpointRegistry.ts:85` vs `EndpointHealthMonitor.ts:10` — the cooldown ladder (500 ms, 2 s) is uncalibrated against the 10 s probe interval; a probe-failed sticky node is "ready" 0.5 s later. Neither constant records the relation.

**API layer**
- `ClusterCatalogueApi.ts:27` — `ARTWORK_ENDPOINT_TIMEOUT_MS = 8_000` exactly equals the inner `DEFAULT_REQUEST_TIMEOUT_MS`, so which error the caller sees depends on timer ordering. Harmless today; exactly the pattern HISTORY says to record.
- `ClusterCatalogueApi.ts:51-63` — a not-ready catalogue synthesises a 503 that cools down a node that answered.
- `AcquisitionApi.ts:91-104`, `ManageApi.ts:114-128` — no `AbortSignal` on these families, so a polling screen that unmounts still walks every candidate. `MachaAcquisitionApi.request:107-108` also lacks the 204 handling Manage has.
- `connectionConfiguration.ts:78`, `MachaManageApi.ts:32,71` — `cache: 'no-store'` relied on alone, against `platform-neutral.d.ts:108-125`.
- `SessionManager.ts:140-155` — `fetch()`'s JSDoc is attached to `authorization()`.

**State, runtime and docs**
- `state/continueWatching.ts:118-126` — the one store that validates only `Array.isArray`; a `[null]` entry throws on every `list()` until history is cleared.
- `state/musicPlaylist.ts:26` — `MusicPlaylistStore` still exported after being superseded, against the hard-cuts rule.
- `runtime/configuration.ts:140-144` — the self-healing `setItem` sits inside the read's `try`, so a write that throws removes the bootstrap key on a read.
- `runtime/configuration.ts:187` and `api/httpCompat.ts:96` — `normalizeUrl` and `normalizeBaseUrl` are the same four lines under two names, so `normalizeUrls` and `normalizeConnectionEndpoints` return identical arrays. **Duplication to delete before it drifts, not a correctness bug** — verified across nine input shapes. Note the phone client's scan path ends in `new URL(...).origin`, which collapses case and path and is stricter than both; if a pairing payload format ever lands in core, *that* is the difference to reconcile.
- `docs/examples/headless.mjs:64-68` passes `serverApi` to `EndpointHealthMonitor`, which has no such option.
- `README.md:100-103` — "EndpointHealthMonitor feeds routing its evidence" omits that throughput, which outranks latency, is fed only by a host-built `EndpointBandwidth` that nothing in this package calls `record()` on.

**Simplification, where the payoff is real**
- `request`/`throwResponseError` is triplicated across Catalogue, Acquisition and Manage (plus PlaybackFacts) with three shape-identical error classes, and has already drifted on 202/204 handling. One `jsonRequest` in `httpCompat` would collapse ~60 lines and make the malformed-body fix a single change. `objectValue`/`asRecord` is re-implemented three times.
- `route()`/`find()` duplicate the walk skeleton; every `Cluster*Api` repeats the `instanceof ClusterEndpointRouter` constructor; `evaluatePreferredSwap` calls `candidates()` (a re-sort plus an axis side effect) where `snapshot()` would do.

---

## Watching, not doing

- **`cpu_cores` and capacity ranking.** Live since server 0.36.7 and the axis switched itself on. Nothing to do unless a node reports stale telemetry — `telemetry_freshness` and `live_age_ms` exist and core does not weigh them. Open question rather than known defect.
- **The platform probe has never run on a device.** `checkPlatformSurface()` ships having produced no runtime truth; its tests run on Node, which supplies everything. `0.8.0` added the three Hermes probes (`Intl.Collator` options, `normalize`, `\p{M}`) so the Android TV hardware run answers both questions at once. Its first real output is due with that 5.1 measurement.
- **No pairing or QR concept exists in core — and is not going to yet.** **Tom's call on 2026-09-13: leave it alone for the future.** The phone client is building a scanner and its payload parse stays local. If a format is ever going to be shared it belongs here, because otherwise four clients invent their own and drift on normalisation edges — but that is a decision deferred, not a defect, and it should not be raised again until someone needs a second scanner.
- **Two clients still hold a duration formatter.** `formatPlaybackTime` is in core and the web client has dropped its copy. The phone and Android TV clients can drop theirs whenever convenient; nothing breaks until they do, and nothing improves either.
- **Two measurements that looked like server defects were neither.** `/api/v1/status` answering `200` with what looked like an empty roster was `gbni-2` on `0.38.1`, which is ungated and returns three nodes; a role-less session on a current build gets `403`, and there is no reduced-payload path in the server at all. And `/api/v1/health` answering `401` was the same node, because authentication runs before routing so a build without the route never reaches the part that would `404`. Both were reported as findings, both were misattribution. Recorded so they are not raised a third time.

- **A broken function in core grows a copy in every client, and fixing it does not remove them.** `checkEndpointConfiguration` could not accept any endpoint against a live cluster until `0.9.0`, so at least two clients wrote their own pre-save gate. The phone client's hand-rolled one tolerated `401` and not `403`, so it would have rejected every candidate the moment a node answered `403` or the gate ran with a session attached — the same lockout as core's, by a different road. Both are fixed, but nobody would have gone back to core's version without being told it worked now. **When a defect in a shared function is fixed, say so to the clients that routed around it** — otherwise the duplicate survives and drifts, which is how the rule ends up living in four places with four opinions.

- **One transient test failure seen on 2026-09-13**, not reproduced in three subsequent runs and coinciding with another session writing to the tree. If a `PlaybackCoordinator` timing test fails intermittently, that suite has several 300 ms+ waits and is the place to look. No evidence of a real flake yet; not seen again across roughly twenty full runs on 2026-09-13.
- **`0.39.1` moves `diagnostics` out of `/api/v1/status`** to `GET /api/v1/status/diagnostics`, same `view_status` role, with `diagnostics_endpoint` naming it in the lightweight response. **Core is unaffected** — `ClusterStatusSnapshot` has never carried that block — so this is here only so the next session does not rediscover it. Committed server-side, not yet deployed.
- **`gbni-2` (`inverbeg`) is stranded on `0.38.1`** with no console access, so it has no `/api/v1/health` and answers `401` to it, and its `/api/v1/status` is ungated. Every odd measurement on 2026-09-13 turned out to be that node. The liveness probe falls back to the old route for exactly this, and that fallback retires itself when the node is upgraded.
