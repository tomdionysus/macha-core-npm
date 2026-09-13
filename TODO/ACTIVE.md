# Active

Open work for `@macha/core`. Items land here when they are decided-but-undone, or undecided-and-blocking. Anything finished moves to [COMPLETED.md](COMPLETED.md) with the version it shipped in.

An item says who it is waiting on. "Tom" means a decision rather than an implementation; "core" means it is mine to build; a client name means the evidence has to come from there before this can move.

---

## Start here if you are new to this

**Where things stand.** `0.9.0` is the current version, bumped on `develop` and **not yet merged to `main` or tagged** — that is the first thing to do if you are picking this up. Work happens on `develop`; a release is an annotated bare-semver tag (`0.9.0`, never `v0.9.0`) on `main`, and the version bump goes *inside* the release commit so the tag points at exactly what ships. Sixteen tags exist, `0.2.0` through `0.8.1`.

**How to check you have not broken anything:** `npm run typecheck`, `npm run lint:platform` (the no-DOM gate — this is the one that catches a browser global sneaking into core), `npx vitest run`, `npm run build`, `npm run dist:check`. The suite is **656 tests in 59 files, all passing** as of 2026-09-13. Run all five; `dist:check` is the one that catches a source change nobody built.

**Never put Claude attribution in a commit message.** No `Co-Authored-By`, no `Claude-Session`, no generated-with line. A commit message ends with its last line of prose. This cost a full history rewrite of 16 commits across `main`, `develop` and two release tags on 2026-09-13.

**Four clients consume this package** — a web/TV app, a Samsung Tizen build of the same, a React Native phone app, and a React Native Android TV app. Some resolve it through a `file:` link and pick up whatever `dist` holds; **the web client does not** — it has a real installed copy in `node_modules` and sees nothing on `develop` until someone rebuilds and reinstalls. Assuming the link was universal cost a round trip of wrong advice. Build after changing source or you silently block their test suites. Most of the defects below were found *from outside*, by those clients; that is the normal way this package learns it is wrong.

**Two clients do not use `PlaybackCoordinator` at all.** The phone client calls `ClusterPlaybackResolver.failover` directly and never prepares an alternate. So a fix landed in the coordinator reaches three clients of four, and a defect on the coordinator path does not reach the phone. **Check which layer a client actually uses before telling it a fix matters to it.**

**How to be wrong here, in the three ways this project keeps finding.** Each has cost real time:

1. *Inferring a difference instead of reading both bodies.* Two findings in the 2026-09-12 review were wrong this way. `codegraph_explore` returns both bodies in one call.
2. *Attributing a measurement to the wrong node.* Two separate findings on 2026-09-13 were measurements of `inverbeg` (gbni-2, still on 0.38.1) reported as another host, and the same mistake cost the DTS/TrueHD investigation a day in September. The host is in the URL — record which one served the number.
3. *Reading a transient as a steady state.* A `503 starting` read as a permanent gate, a `403` mid-deployment read as a configuration. Both on 2026-09-13, both retracted.

**The rule that settles most boundary questions** (Tom's): *would nearly every conceivable client be required to do this? If yes, core. If not, theirs.* And the one that settles most design questions: no component may assume another is live or healthy, and a dying component's evidence is not evidence.

---

## P0 — nothing open

All five P0s from the 2026-09-12 review shipped in `0.9.0`. The last of them, the connection-gate lockout, was waiting on the server to choose between two fixes; server 0.38.5 answered it with `GET /api/v1/health`.

---

## P1 — correctness

**Start here.** The watchdog item below is the one with a client waiting on it, and its first sub-item is a live defect on the Android TV client rather than a latent one.

### Watchdog blind spots on the platform it was written for
**Waiting on:** core. `src/playback/MediaWatchdog.ts:324-352`, `:326-332`, `:226-233`.

1. **Backward seek defeats the baseline — take this one first.** `lastBufferedEndMs` is a running max, so after a backward seek buffer growth at the new position never counts as advancing and a healthy below-realtime transcode is evicted 7 s later, which is the eviction the class comment says it exists to avoid. **On Android TV the D-pad *is* the seek affordance** and that client commits a seek after every rewind burst, so it condemns healthy nodes as ordinary viewing, not as an edge case. The observable is a failover roughly 7 s after any rewind. Web and phone have scrubbers people touch rarely, which is what kept it invisible.
2. **No re-arm after `suspend()`.** `lastPositionMs` is kept and only `note()` re-arms, but `note()` returns early unless something advanced. Pause, node dies, resume: nothing advances, nothing arms, frozen forever. Only "paused is not stalled" is tested.
3. **The +1 s margin comment overclaims.** It says the budget only has to outlast the hold, but the watchdog reads only `currentTime`/`buffered` and a `500` carries no bytes; hold + player retry delay + first byte exceeds 7 s. Either record the real relationship or say plainly that holds do trip it and that is accepted.

### Background discovery records real routing evidence
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:230`; `src/services/createMachaServices.ts:67`; `src/cluster/endpointRouting.ts:144-166`.

`clusterStatusApi` routes through `route()`, so each 10 s discovery call does `recordSuccess`/`recordFailure`. A status timeout permanently un-sticks the preferred endpoint — precisely what `recordProbeFailure` exists to avoid — and a success elsewhere steals preference. Contradicts `EndpointHealthMonitor.ts:192` ("owns no server or playback state") and `endpointRouting.ts:21-23`. Fix: an advisory path using the probe variants.

### A storage write error kills the health loop silently
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:237-238`; `src/runtime/configuration.ts:148-151`.

`persistConfirmedEndpoints` → `setItem` is uncaught. A `QuotaExceededError` (TVs) rejects `cycle()`, the `void` swallows it as an unhandled rejection, no reschedule runs, and `running` stays `true`. `EndpointBandwidth.write()` catches for exactly this reason — two copies of one rule, disagreeing. Fix: try/catch the persist, reschedule in a `finally`.

### `Platform.ts:13` inverts the hold status for adapter authors
**Waiting on:** core. One-line doc fix.

It says a hold answers `503 segment_not_ready`, while `streamProtocol.ts:42` says 503 is a broken generation and terminal, and `:54` maps 503 with 404 to `stream`. **Not merely inconsistent — inverted.** An author following the public seam makes both mistakes at once and in opposite directions: retrying the terminal status, and condemning the node on the benign one. Both shipped adapters are already right (`PlayerEngine.kt:450` retries 500), so this is a trap for the next author rather than a live defect. Fix the comment, not the docs: `docs/writing-a-player.md` is already correct and is what people actually read.

### Session manager state gaps, and the roles work landing on them
**Waiting on:** core. `src/api/SessionManager.ts`. **Take these three together — they are all the mint and re-mint paths, and fixing them twice would be worse than once.**

1. `authorization()` hands out the dead token during a reactive re-mint, because `mint()` never clears the rejected token. The doc on `fetch()` claims the opposite.
2. `start()` during an in-flight bootstrap adopts the *old* registry's result and never contacts the new one; `mintNow` then reports the corrected config as unreachable. The doc "safe to call again if the registry changes" is false in that window.
3. Refresh timers overwritten without clearing; `stop()` clears only the last.

**Item 3 of the original four shipped in `0.9.0`** — refusals are no longer charged as endpoint failures or reported as unreachable, and `lastMintFailure` carries the real error. Only the three above remain.

**And the one the accounts work adds:** a 401 no longer means only "expired". A password or role change bumps `credential_generation` and invalidates every earlier session cluster-wide, deliberately, so a mid-session 401 is now normal. `SessionManager` answers a 401 by re-minting, and a re-mint with no credentials is an *anonymous* mint — so an administrator whose roles change is **silently downgraded to anonymous**: sections vanish, writes fail, and nothing says they were signed out. It disguises an auth event as a UI bug. The session must remember whether it was authenticated: anonymous 401 keeps re-minting invisibly; an authenticated 401 must stop, surface that the session ended, and let the application choose. The cached-session path on reload needs the same distinction.

The phone client has covered the *display* half — it re-reads `currentSession` on every notification so the marker self-corrects — and deliberately did not invent a "you were signed out" event, because the cause is core's.

**`0.9.0` supplies the parts this needs but does not do it.** `SessionManager.roles` now tracks what the session may do and clears when the token goes, and `lastMintFailure` distinguishes a refusal from an outage — so the remaining work is the *decision* the session has to make: remember whether it was authenticated, keep re-minting invisibly for an anonymous 401, and stop and surface the end of the session for an authenticated one. The server session confirmed a 401 from `GET /api/v1/session` can mean the account changed underneath the token rather than expiry, so a client must not tell a viewer their session timed out.

### Two clients disagree about what logout means, and core documents no answer
**Waiting on:** Tom. `src/api/UsersApi.ts:128-135` (`logout`), `src/api/SessionManager.ts:148-166` (`signOut`).

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

## Waiting on Tom — asked for by clients, not core's to decide

Four client sessions reported into core on 2026-09-13. The defects among their findings shipped in `0.9.0`; what is left is where the boundary falls, and a boundary decided unilaterally is how four clients end up adapting to the wrong thing.

**Settled, recorded so they are not raised again.** `view_status` is in `UserRole`. A role-less session learning no cluster membership is *correct* — it sees only the endpoint it was configured with. `sessionPermits`/`sessionLockedOut` and the session's roles are in core, so both clients delete their copies. And `MODE_TRANSFORMS` **does not move**: the server session confirmed core's recorded 0.34.0 behaviour is current in 0.39.1 — `parse_preferences` resets `video`, `audio`, `max_height` and `max_bitrate` the moment `mode` is named, so the contradiction that rule guards against cannot be assembled. The client deletes its copy instead. If it still reproduces there, the evidence to ask for is the exact body, status and `code`.

### The Android TV audit, what remains
**Waiting on:** Tom, on the boundary. In the order I would take them:

1. **The HLS preflight walk.** Duplicated in two clients — `preflightWebHlsSource` in the web client, `src/player/preflight.ts` on Android TV. Manifest one variant deep, `Range: bytes=0-65535` each media target, require bytes. The parse and the probe are protocol; only `fetch` differs, and the two React Native divergences (`URL` cannot resolve relative references, `fetch` ignores `cache`) are exactly what one implementation taking an injected fetch absorbs once instead of twice. Core keeps the `Player.preflightSource` seam and additionally ships the walk, which a host calls.
2. **Volume and mute semantics.** `state/volume.ts` persists a bare clamped number and has no concept of mute, so each client decides what to write when a viewer mutes — and writing `0` is indistinguishable from turning the sound down, so the next launch comes up silent with nothing explaining why. A correctness rule about core's own store, decided per client today. Verified.
3. **The artwork source plan.** Core ships `artworkUrls()` and `ArtworkSource`; both clients then independently implement the same policy on top — drop anything needing an `Authorization` header, walk nodes on failure, and remember the URL that last loaded so a re-signed capability does not churn the image cache. That last part is a countermeasure to a server behaviour core itself documents, so it belongs beside the observation. Policy over data rather than a rule that breaks when it diverges.

**Declined:** `REASON_TEXT`. The strings are presentation. The real risk is an unmapped `PlaybackDecisionReason` rendering as a raw identifier, and the cheap answer is a non-localised fallback sentence as `errorMessage` already does — not a string table in core. The client did not push for it either.

**Not asked for, listed so the boundary stays visible:** the spatial focus scorer (geometry deciding what a viewer looks at next is presentation) and the alphabet strip (pure rendering over `titleIndex`).

---

## P1 — design and contract

### Speaker layout is not a concept core has
**Waiting on:** Android TV client (measurement), then core.

`choosePlaybackInstruction` decides audio purely on codec and never reads `channels`. `PlaybackCapabilities` has a field for what a device can *decode* and none for what its output can *render*. So a 5.1 track on a device that lists `eac3` is copied through untouched, and whether it is folded down to two speakers is entirely the device's business.

There is a live report of exactly that — 5.1 playing into stereo with no downmix — and it is unresolved. The Android TV client is the best evidence available: it builds capabilities from `MediaCodecList`, so it correctly reports `ac3`/`eac3`/`ac4`, and it will show whether Media3 folds down cleanly. Either answer is useful. If it does not, this is core's gap rather than a device setting.

If it becomes real work, the shape is roughly: a render-capability field on `PlaybackCapabilities`, and a channel target on the instruction — which needs the server to accept one, so it is a wire question too.

### Four state stores are not safe for a reactive caller
**Waiting on:** Tom.

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
**Waiting on:** Tom, on whether to spend it.

Was 93.4% statements and 84.4% branches at 600 tests; now 656 and not re-measured. The gap is concentrated in `PlaybackCoordinator` and `PlaybackRuntime`, whose uncovered branches are the failure paths that only fire in specific combinations — failover racing a seek, a promotion during a pending mutation. Each needs a scenario built rather than an assertion added, which is why it is the slow part and also why it is the part worth having.

**What the review named and is still uncovered**, each tied to an item above: `canSeek: false`; watchdog resume after suspend and after a backward seek; degrade during failover; discovery failure demoting the sticky endpoint; persist throwing; restart mid-bootstrap; reactive re-mint; malformed success bodies; an empty bootstrap list; malformed continue-watching entries. `ClientLog` has one test.

`0.9.0` closed the rest of that list: two failure signals from one dead source, a late admission after the deadline, three-endpoint ranking, the no-facts fallback's container, retry preserving container and chooser-ness, a standby with a mismatched served container, refusal versus unreachable, and a 401 on the pre-save check. Every one of them was written red first, and two were red in the shape that matters — they did not fail, they hung until the harness killed them.

---

## P3

### Music library state should move into core
**Waiting on:** Tom to sequence.

Favourites, play counts with a commit threshold, recently-played with a cap. It exists once, in the phone client, and nothing platform-specific is in it. **One implementation is the cheapest moment to move something** — two is a negotiation about constants nobody wants, and the failure is silent: the same library ranking differently in two clients is not something anyone reports.

### Offline and cache policy needs a seam, not a move
**Waiting on:** Tom, then design.

Four decisions are common to the phone's downloads and the web's read-ahead worker: content-addressed identity as the key, always the original bytes, a bounded frontier, and a failed speculative read treated as non-terminal. The transfer mechanism can never be shared.

One correction already established: "a failed speculative read is not a playback failure" is **already** core's `subscribeDegradation`/`subscribeFailure` split, which gained `not-ready` for exactly that case. It should feed that seam rather than build a parallel one.

The real work is deciding, per constant, whether it is a rule (shared) or a tuning (per host). Getting that wrong is how a shared module grows a `platform === 'ios'` branch.

### Teardown has a ceiling no client can close
**Waiting on:** server (raised, undecided).

`PlaybackRuntime.terminateForPageExit()` rides on `keepalive`, which is browser-only. React Native ignores it and Tizen 3 does not have the property. But the missing property is incidental: **the real cause is process death** — a host that is force-quit, crashes or loses power sends nothing by any mechanism, and no client-side change can fix that.

The cost is not local: a node holds a session's transcode entitlement for `session_idle` — 30 minutes — so on a one-slot node the next viewer gets `429 resource_limit` and nothing points at the client that caused it. There is no server-side mitigation today: no shorter idle for a session nothing was ever fetched from, and admission refuses rather than evicting. Both have been raised, and the second changes admission from a guarantee into a lease, so it is not a small ask.

Calling this promptly is the whole of the defence until one exists. Documented on the method and in the README.

### Shared TV navigation has no home
**Waiting on:** Tom.

Two TV clients hold hand-synchronised copies of a spatial D-pad focus scorer whose weights must agree for them to behave the same. Declined for core on the boundary: this package is everything a client does that is **not** presentation, and geometry deciding what a viewer looks at next is presentation. A boundary that bends for a good-enough case stops being able to answer the question at all.

That does not make the duplication fine. The honest options are a second shared package (`@macha/tv`) or accepting it with tests pinning the weights on both sides so a drift is at least loud. Both TV clients currently pin their own.

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
- **No pairing or QR concept exists in core.** The phone client is building a scanner and its payload parse stays local until Tom decides the format. If a format is going to be shared it belongs here, because otherwise four clients invent their own and drift on normalisation edges — but it is a decision, not a defect.
- **Two clients still hold a duration formatter.** `formatPlaybackTime` is in core and the web client has dropped its copy. The phone and Android TV clients can drop theirs whenever convenient; nothing breaks until they do, and nothing improves either.
- **One transient test failure seen on 2026-09-13**, not reproduced in three subsequent runs and coinciding with another session writing to the tree. If a `PlaybackCoordinator` timing test fails intermittently, that suite has several 300 ms+ waits and is the place to look. No evidence of a real flake yet; not seen again across roughly twenty full runs on 2026-09-13.
- **`0.39.1` moves `diagnostics` out of `/api/v1/status`** to `GET /api/v1/status/diagnostics`, same `view_status` role, with `diagnostics_endpoint` naming it in the lightweight response. **Core is unaffected** — `ClusterStatusSnapshot` has never carried that block — so this is here only so the next session does not rediscover it. Committed server-side, not yet deployed.
- **`gbni-2` (`inverbeg`) is stranded on `0.38.1`** with no console access, so it has no `/api/v1/health` and answers `401` to it, and its `/api/v1/status` is ungated. Every odd measurement on 2026-09-13 turned out to be that node. The liveness probe falls back to the old route for exactly this, and that fallback retires itself when the node is upgraded.
