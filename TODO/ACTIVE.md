# Active

Open work for `@machafoundation/core`. Items land here when they are decided-but-undone, or undecided-and-blocking. Anything finished moves to [COMPLETED.md](COMPLETED.md) with the version it shipped in.

An item says who it is waiting on. "Tom" means a decision rather than an implementation; "core" means it is mine to build; a client name means the evidence has to come from there before this can move.

---

## Start here if you are new to this

**Where things stand.** `0.11.1` is released **and published to npm** — merged to `main`, tagged, pushed, `dist` built, and live on the registry as `latest`. `develop` and `main` are level. Twenty tags, `0.2.0` through `0.11.1`. **npm holds only `0.8.1` and `0.11.1`**; see *Moving the clients onto public npm* for why that gap exists and why `git tag` is no longer the way to ask what a client can have. Work happens on `develop`; a release is an annotated bare-semver tag (`0.11.0`, never `v0.11.0`) on `main`, with the version bump *inside* the release commit so the tag points at exactly what ships.

**How to check you have not broken anything:** `npm run typecheck`, `npm run lint:platform` (the no-DOM gate — this is the one that catches a browser global sneaking into core), `npx vitest run`, `npm run build`, `npm run dist:check`. The suite is **786 tests in 61 files, all passing** as of 2026-09-15. Run all five.

**Build LAST, after the final `git checkout`.** `dist:check` compares mtimes, and a branch switch rewrites every source file's. So "build, merge to `main`, tag, checkout `develop`" leaves `dist` stale **even though no source changed**, and every client's `pretest` then refuses. This happened on the `0.10.0` release and blocked a client until it was caught. Core reported "dist is current" in good faith and was wrong within the minute.

**`npm run build` stages and renames; keep it that way.** It compiles to `dist.staging` and moves it into place, because `tsc` removes nothing (so emitting in place leaves orphans that `dist:check` is structurally blind to) and emptying `dist` first made the window *worse* — a client watched its whole suite collapse to "no tests" mid-rebuild. A failed compile leaves `dist` untouched.

**Never put Claude attribution in a commit message.** No `Co-Authored-By`, no `Claude-Session`, no generated-with line. A commit message ends with its last line of prose. This cost a full history rewrite of 16 commits across `main`, `develop` and two release tags on 2026-09-13.

**Four clients consume this package** — a web/TV app, a Samsung Tizen build of the same, a React Native phone app, and a React Native Android TV app. **They are moving off `file:` links onto the published npm package**, decided 2026-09-15; see *Moving the clients onto public npm* below for the order and the traps. Until a client has moved, it resolves through `file:` and `"main": "./dist/index.js"`, so it compiles against your **last build** and a change on `develop` is invisible to it until `npm run build` runs here. Once moved, a change is invisible until it is **published** — use a `--tag next` prerelease to get it in front of a client, never a local link.

**Two of them install it as `@macha/core`** — a real `package.json` key with a `file:` target, so their imports resolve and are correct as written. Only the web client uses `@machafoundation/core`. **That split is now settled: `@machafoundation/core` is the name**, because `@macha` is an unclaimed npm scope and would break the moment a client resolved from the registry. Both clients need renaming — see *Moving the clients onto public npm* below, which also carries the dependency-confusion note that makes it time-sensitive.

**Two clients do not use `PlaybackCoordinator` at all.** The phone client calls `ClusterPlaybackResolver.failover` directly and never prepares an alternate. So a fix landed in the coordinator reaches three clients of four. **Check which layer a client actually uses before telling it a fix matters to it.**

### How this project keeps being wrong, and the cheapest way to find out

Each of these has cost real time. The `codegraph_explore` habit in the first is the only reliable defence against most of them.

1. **Inferring a difference instead of reading both bodies.** Two findings in the 2026-09-12 review were wrong this way; two of four "broken" state stores in `0.10.0` were the same. `codegraph_explore` returns both bodies in one call.
2. **Attributing a measurement to the wrong node — or the wrong build.** On 2026-09-13 a client's `exp` measurement and the server's source reading flatly contradicted each other for an hour. Neither was wrong: the bucketing had deployed between them. **Establish which version answered before reconciling anything** — `/api/v1/status` carries it. This cuts both ways: the server read source and reported it as live behaviour; a client measured live and reported it as source.
3. **Reading a transient as a steady state.** A `503 starting` read as a permanent gate, a `403` mid-deployment read as a configuration. Both retracted.
4. **Grepping a tree when the consumer is a separate repo.** "The only consumer in the world" was wrong within hours — a second client wired it the same day, *after* the grep that found none. **Ask the session, do not grep the tree.** No amount of care with the search would have helped.
5. **Reading core's git log to know what a client has.** *New as of 2026-09-15, and it replaces an older version of itself.* "Built is not released" used to mean a client compiles against core's last **build**, so a change on `develop` was invisible until `npm run build` ran here. For a client on the registry it now means the client compiles against core's last **publish** — a change on `develop`, **and even an annotated git tag**, is invisible there until it reaches npm *and* that client's range moves. `0.9.0`, `0.10.0` and `0.11.0` are the worked example: three tagged releases that never existed as far as any client could tell. **`npm view @machafoundation/core versions` is the answer, not `git tag`.** Raised by the web client on completing its move.
6. **Ship a seam to a client before releasing it.** On 2026-09-13 the Android TV client swapped onto `hlsWalk` and **three of its four findings came from the swap rather than from reading the code** — including one that would have destroyed every warm standby on that platform, silently. A client porting onto shared code is a cheap fuzzer for the assumptions in it. Land the seam, name it to a client, let it swap, fix what the swap finds, *then* tag.

**Two further habits that paid on 2026-09-13.** Writing a refactor brief surfaced a live core defect before anyone ported — a client compared it against the shape of its own state machine and found the ready-flicker. And a client verifying core's *output* rather than taking core's word found four things nothing else would have: a stale `dist`, an orphaned build artefact, a mid-rebuild collapse, and a shipped comment contradicting the commit that acknowledged it. **Amended 2026-09-15:** the habit is right and the example has largely expired — three of those four were failures of the `file:` link itself and cannot occur against an immutable tarball. Verifying output rather than taking core's word is still the point; the stale-link finding on the day of the npm move is the current example, and it is a better one.

**The rule that settles most boundary questions** (Tom's): *would nearly every conceivable client be required to do this? If yes, core. If not, theirs.* And the one that settles most design questions: no component may assume another is live or healthy, and a dying component's evidence is not evidence.

---

## Client adoption of `0.11.1`

**Adopted and tested is not ported** — that distinction is the web client's and it is worth keeping. A third column is now needed: *how* a client resolves core, because "on core" stopped meaning one thing on 2026-09-15.

| Client | Resolves core by | Suite | Ported |
|---|---|---|---|
| Web | **npm `^0.11.1`** — released as `macha-client` 0.17.0, no link | 46 files / 335 | **no** — `AccountMenu.signOut` onto `sessionManager.signOut()`, `lastIdentityChange` unsubscribed |
| Android TV | `file:` as `@macha/core` — rename and move pending | 11 files / 159 | **no** — `secureStorage` **not supplied**; token in app-private storage |
| Phone | `file:` as `@macha/core` — rename and move pending | 12 files / 90 | **no** — `secureStorage`, `lastIdentityChange`, `signOut`, `probeNow` |

**The web client verified the way the package will actually be met**, not in place: a fresh clone with no `macha-ts` anywhere on disk, `npm ci`, tarball resolved by integrity hash, typecheck clean, 335 tests green. That is the bar for the other two — an install proved against a tree that still contains a local core proves nothing, as its stale-link finding showed.

**Nobody is blocked on core.** Each port is waiting on its own operator's sequencing.

**What not porting costs, measured on Tom's cluster rather than assumed:** `POST /api/v1/session` with empty credentials mints on every node and returns **`roles: []`**, and `/catalogue/items` then answers **`403 requires the 'media_viewer' role`**. So the 30-day re-mint produces a session that cannot read the catalogue at all. On Android TV a latch means the viewer is *not* thrown to a login wall mid-film — instead their requests start failing with nothing on screen explaining why, and they meet the wall at next launch. That is the auth-event-wearing-the-costume-of-a-UI-bug that `lastIdentityChange` plus `sessionLockedOut` exist to separate, and nobody is subscribed yet.

**One security item among the ports, and it is the phone client's.** Its bearer now persists **up to 30 days** in plaintext `AsyncStorage`, where before its `0.5.1` fix it died with the process. Same storage, same permissions — exposure window from one session to a month, readable on a rooted device or in a backup. A consequence of a fix that was otherwise entirely good. `expo-secure-store` runs there; `secureStorage` is the seam.

---

## Moving the clients onto public npm

**Decided 2026-09-15, on evidence rather than preference.** The package alias split is closed: **`@machafoundation/core` is the name.**

| Name | Registry status |
|---|---|
| `@machafoundation/core` | Published since 2026-09-12, owned by `tomdionysus`. `latest` was `0.8.1` |
| `@macha/core` | **Does not exist.** The whole `@macha` scope is unclaimed — 0 packages, org endpoint 404 |

So the two clients keying `@macha/core` are not using an alias, they are using a name nobody owns. They break the moment they resolve from the registry instead of `file:`. That is now a prerequisite rather than a chore.

**One security item, and it is the reason not to let this drift.** `@macha/core` sits in two clients' `package.json` today. It resolves through `file:`, and if that override were lost it would 404 — a loud, safe failure. But anyone may claim the `@macha` scope and publish `core` into it, after which a regenerated lockfile, a CI install, or a teammate installing without the local checkout resolves to a stranger's package and runs their install scripts. Nothing suggests this has happened. The rename is the fix; claiming `@macha` defensively is cheap belt-and-braces.

**npm's `latest` was three releases stale.** `0.8.1` was the only published version, so anything installed from the registry between 2026-09-12 and `0.11.1` predates `0.9.0` — including the `checkEndpointConfiguration` lockout that two clients wrote their own pre-save gates to route around. **`0.9.0`, `0.10.0` and `0.11.0` will never exist on npm**; a client pinning `^0.9.0` will not resolve. Recorded in HISTORY.md, because from outside a version gap and an unpublish look identical.

### The registry is the only path, including in development

**Tom, 2026-09-15: the development cycle must conform to what a user actually sees on install.** No `npm link`, no `file:` override kept aside for convenience. A loop that resolves differently from the thing being shipped is how something reaches a release working only locally.

This overrides the earlier advice in this file, which was to keep a local link for development and use the registry for CI. That advice was weaker than it looked, and worth saying why rather than just deleting:

**Of the four findings the `file:` loop is credited with, three were caused by the loop.** The stale `dist`, the orphaned build artefact and the mid-rebuild collapse are all failures of the link mechanism itself — a client reading a directory core was mid-write on. **None of them can happen against a registry tarball**, which is immutable and carries an integrity hash. So the loop's headline achievement was largely catching bugs it had created.

The one genuine counter-example survives the move intact: the Android TV client's `hlsWalk` swap produced three of its four findings *from porting onto shared code*, not from the link. A client is still a cheap fuzzer for core's assumptions. It just does its fuzzing against a published version now.

**The cost is real and is paid deliberately:** a core change reaches a client only after a publish. **Use a prerelease under a dist-tag rather than reaching for a link** — publish `0.12.0-rc.1` with `npm publish --tag next`, have the client install `@machafoundation/core@next`, and iterate. The install path, the tarball and the resolution are then identical in shape to what a user gets, which is the whole requirement, and `latest` never moves until it is meant to.

### Order — one at a time, not four at once

1. **Web client.** Already keys `@machafoundation/core`, so it is a one-line swap from `file:` to `^0.11.1` plus a regenerated lockfile. It goes first because it proves the published tarball actually works before anything harder is attempted.
2. **Phone and Android TV.** Dependency key, every import, and a regenerated lockfile in each.
3. **Tizen last**, since it shares the web build.

**Keep the dependency move separate from the outstanding ports** (`secureStorage`, `lastIdentityChange`, `signOut`, `probeNow`). Doing both at once means two variables when something breaks.

### The swap does not take, and the obvious check says it did

**Reported by the web client on 2026-09-15, having done the swap.** Editing `package.json` to `^0.11.1` and running `npm install` **silently keeps the existing link** — the lockfile still read `"resolved": "../macha-ts", "link": true`.

The dangerous half is the confirmation. `require('@machafoundation/core/package.json').version` answers `0.11.1`, because the local tree is *also* at `0.11.1`. So the version check passes and the suite goes green while the client is still compiling against the sibling working directory. **A client can complete this swap, verify it, and report success without ever having installed the published package.**

What moves it: `rm -rf node_modules/@machafoundation/core` then `npm install @machafoundation/core@^0.11.1 --save`, after which the lockfile carries the registry URL and an integrity hash.

**Verify by shape, never by version string:** `test -L node_modules/@machafoundation/core`. A symlink means it did not take. This is the same class as the stale `dist` — a check reporting success for a reason unrelated to the question.

**Worse for the two renaming clients**, and they have been told: the stale link can persist under the old `@macha/core` key while the new key resolves from the registry, leaving two copies of core in one tree with binding decided by whether the rename is complete. They clear `node_modules/@macha` outright and test both keys.

### `dist:check` stops meaning anything to a client on the registry

**The web client's `pretest` is `cd ../macha-ts && npm run dist:check`,** and it reports the other clients carry the same shape. That check exists because the `file:` link meant a client compiled against core's last *build*, so a stale `dist` was invisible to typecheck and surfaced only at test time.

**Against a registry tarball it asserts something irrelevant** — it validates a sibling working tree the client no longer compiles against, and would pass or fail for reasons unrelated to what is installed. A green check that means nothing is how a real one stops being read.

**Delete it.** With no local link anywhere, there is no case left in which it answers a question the client has. Core keeps `dist:check` for its own release process, where it still guards the thing that gets packed.

### Source maps: one answer in, one outstanding

`0.11.1` stopped publishing them — 142 files, 404KB, all pointing at `../src/*.ts` while `src` is not in `files`, so none of them ever resolved. `inlineSources` would make them work at +599KB.

- **Web client: no loss, and asked that they not be shipped on its account.** It never steps into core in a debugger; its playback diagnostics come out of core's own ring buffer through `machaDiagnostics`, which is source-independent.
- **Android TV: asked, awaiting reply.** Its answer is the one that decides this, since most of its diagnosis happens on a device rather than in a debugger.


---

## P0 — nothing open

---

## Waiting on Tom

- ~~**The package alias split.**~~ Decided 2026-09-15: `@machafoundation/core`, because `@macha` is an unclaimed scope and `@machafoundation/core` is already published and owned. See *Moving the clients onto public npm* above.
- **Coverage.** Deferred 2026-09-13: *"not at this time, we'll update later."* Re-measured 2026-09-15 and the cheap half taken; see *Coverage: what is done and what is left* below for where it now stands and what the rest costs.
- **Does `macha.volume.v1.` stay in the storage registry?** `0.11.0` deleted `VolumeStore`, so **nothing in core writes that key any more**, but it is still listed in `MACHA_STORAGE_KEY_PREFIXES` — surfaced by the new registry test, which drives what core writes and cannot speak to what it no longer writes. Both answers are defensible and they are not the same: *keep it* and hosts clearing Macha data through `isMachaStorageKey` still collect the value core left on every device that ran `0.10.0` or earlier — but then the file's opening line, "every storage key this package **owns**", is no longer quite what the list means and should say so. *Drop it* and the registry stays honest, but a value core wrote is orphaned on every existing install and a host enumerating keys reads it as someone else's. **Leaning keep**, with the doc amended to say the list includes keys core has retired but still owns — the same reasoning that keeps `macha-client-progress:` listed. Cheap either way; it just needs deciding before someone deletes it as dead.

---

## P1 — correctness

### Session manager: three mint/re-mint gaps `0.10.0` did not touch
**Waiting on:** core. `src/api/SessionManager.ts`. **Take them together — they are all the mint and re-mint paths, and fixing them twice would be worse than once.**

`0.10.0` rebuilt the *model* around these and deliberately did not fix them; they are still live.

1. **`authorization()` hands out the dead token during a reactive re-mint**, because `mint()` never clears the rejected token. The doc on `fetch()` claims the opposite.
2. **`start()` during an in-flight bootstrap adopts the old registry's result** and never contacts the new one; `mintNow` then reports the corrected config as unreachable. The doc "safe to call again if the registry changes" is false in that window.
3. **Refresh timers overwritten without clearing**; `stop()` clears only the last.

### Background discovery records real routing evidence
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:230`; `src/services/createMachaServices.ts:67`; `src/cluster/endpointRouting.ts:144-166`.

`clusterStatusApi` routes through `route()`, so each 10 s discovery call does `recordSuccess`/`recordFailure`. A status timeout permanently un-sticks the preferred endpoint — precisely what `recordProbeFailure` exists to avoid — and a success elsewhere steals preference. Contradicts `EndpointHealthMonitor.ts:192` ("owns no server or playback state") and `endpointRouting.ts:21-23`. Fix: an advisory path using the probe variants.

### A storage write error kills the health loop silently
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:237-238`; `src/runtime/configuration.ts:148-151`.

`persistConfirmedEndpoints` -> `setItem` is uncaught. A `QuotaExceededError` (TVs) rejects `cycle()`, the `void` swallows it as an unhandled rejection, no reschedule runs, and `running` stays `true`. `EndpointBandwidth.write()` catches for exactly this reason — two copies of one rule, disagreeing. Fix: try/catch the persist, reschedule in a `finally`. **`probeNow()` now shares this loop**, so a caller awaiting an off-cycle probe inherits the same silent death.

### `Platform.ts:13` inverts the hold status for adapter authors
**Waiting on:** core. One-line doc fix.

It says a hold answers `503 segment_not_ready`, while `streamProtocol.ts:42` says 503 is a broken generation and terminal, and `:54` maps 503 with 404 to `stream`. **Not merely inconsistent — inverted.** An author following the public seam makes both mistakes at once and in opposite directions: retrying the terminal status, and condemning the node on the benign one. Both shipped adapters are already right (`PlayerEngine.kt:450` retries 500), so this is a trap for the next author rather than a live defect. Fix the comment, not the docs — `docs/writing-a-player.md` is already correct and is what people actually read.

### `GET /api/v1/users` envelope — core is already right, the comment will not be
**Waiting on:** core, for a comment. `src/api/MachaUsersApi.ts:50-72`.

The server changed the list envelope from `{"users": [...]}` to `{"items": [...]}`. **Core needs no change:** `userList` already accepts a bare array, `users`, or `items`, and throws a typed `invalid_user_list` otherwise — being generous about the envelope was deliberate and has paid for itself.

The doc comment above it still states as fact that the server wraps under `users` and *not* `items`. That is now **inverted** — the same trap as `Platform.ts:13`. Rewrite it: `items` is the envelope, `users` is legacy, kept **because a node may be stranded on an older build**. That reason belongs in the comment, or a later session deletes the branch as dead.

**Loose end:** the operator reported an accept-either shim in a client. The web client checked and it is not there. **It is sitting unremarked in one of the other three trees** — worth chasing, because a client that hand-handles a wire format will not notice the *next* change either.

### Playback must be stopped before sign-in and sign-out, and nothing says so
**Waiting on:** core. Doc change at minimum.

Changing identity does not close playback sessions — nothing connects them — and **after the token changes, a session created under the old identity can no longer be closed.** The node then holds it against `max_video_transcodes` until `session_idle`, 30 minutes, on nodes with one slot. The ordering is an obligation on every caller, the fix is cheap, and the failure is invisible from the client that causes it. Belongs on the `signIn` and `signOut` doc comments. (`signOut`'s already carries it; `signIn`'s does not.)

### Smaller correctness items
**Waiting on:** core.

- **README seeding snippet defeats discovered-endpoint persistence.** `README.md:89-92` seeds discovered endpoints through `bootstrapEndpoints([...])`, labelling them `bootstrap`, so `applyAdvertisement` never marks them `discovered`, `persistConfirmedEndpoints` persists `[]`, and discovered history is wiped on every second start. Fix: `bootstrapEndpoints(discovered, 'discovered')`, plus a seed-then-persist round-trip test.
- **An emptied bootstrap set is persisted and treated as configured.** `runtime/configuration.ts:78`, `:88-93`, `:102-106`. `setBootstrapEndpoints([])` writes `{urls: []}`; `[]` is truthy, so `environmentEndpoints` is never consulted again and the client is permanently unconfigured after a "clear". `setDiscoveredEndpoints` already removes the key when empty — the two setters disagree.
- **`TorrentJob.catalogue` is declared required but version-gated.** `api/AcquisitionApi.ts:72`, "since 0.28.1", and the package supports mixed-version endpoint sets with no runtime check. Make it optional; absent stays absent.
- **Success bodies are assumed to be the envelope.** `MachaCatalogueApi.ts:61-62,127-128,191-203`, `MachaAcquisitionApi.ts:41-52,99-109`, `MachaManageApi.ts:32-33`. A 200 with HTML throws a raw `SyntaxError` the router treats as non-retryable, so "Unexpected token <" reaches the viewer with no failover; a JSON 200 missing `items`/`jobs` throws `TypeError` at `.map`, which the router treats as a *transport* failure and cools down the node for a schema mismatch. Fix: validate shape and throw a typed `invalid_response`, as `mediaProfile` already does at `:88`.
- **`ClusterPlaybackFactsApi` records per-title faults as endpoint evidence.** `:63-67` lacks the `!isPerTitleFailure(error)` guard `ClusterPlaybackResolver.create:268` has, so one unreadable extent demotes the node for every title.

---

## P1 — design and contract

### Speaker layout is not a concept core has
**Waiting on:** the Android TV client to interpret its own measurement, then core. **Possibly answered — do not close it on core's reading.**

`choosePlaybackInstruction` decides audio purely on codec and never reads `channels`. `PlaybackCapabilities` has a field for what a device can *decode* and none for what its output can *render*. So a 5.1 track on a device that lists `eac3` is copied through untouched, and whether it is folded down to two speakers is entirely the device's business. Opened on a live report of 5.1 playing into stereo with no downmix.

**The measurement this was waiting for has arrived**: the Android TV client reports its playback section answered — *direct play, positional `0x0000003F`, six channels*. The open question is what it proves. **Does that mean the set is rendering six discrete channels, or only that Media3 accepted a six-channel stream?** Those answer this item differently, and core must not decide it by reading someone else's measurement. Asked; awaiting reply.

If it does become real work, the shape is: a render-capability field on `PlaybackCapabilities`, and a channel target on the instruction — which needs the server to accept one, so it is a wire question too.

### Three gaps in the `Platform`/`Player` contract
**Waiting on:** core, with design against the RN clients. **Has consumers waiting rather than being speculative.**

All three are defects in what core ships, not in client discipline:

1. **`Platform.createPlayer(): Player` assumes one player per platform.** React Native switches engines per queue item — expo-video for video, react-native-track-player for `kind === 'track'`, which is what gives background audio and lock-screen controls. A mixed queue of episodes and music cannot be expressed as one player created once. Preferred fix: let the coordinator tolerate the player instance changing between source generations, rather than passing a kind to `createPlayer` — the latter moves the assumption into an argument. **The Android TV client's Tier 3 needs exactly this.** Confirmed achievable on expo-video: `VideoView`'s player setter checks `hasSentFirstFrameForCurrentMediaItem` and holds the shutter open for a pre-warmed one. **"React Native cannot do seamless failover" is false and should not be repeated.**
2. **`attach(host)` / `detachHost()` is imperative surface ownership.** A React Native video surface is a declarative `<VideoView player={...}>` owned by the render tree. The DOM *type* is gone; the shape is still wrong.
3. **No channel for OS transport commands.** Lock-screen play/pause/next/seek are queue-level commands and `Player.subscribe` carries player-to-client events only. A hole rather than a mismatch, and it would have stayed missing indefinitely because the web client never needed it.

### Artwork: two residues and a documented gap
**Waiting on:** the Android TV client for the first; core for the third if it ever matters.

`0.11.0` fixed the cause. Three smaller things survive it:

1. **Refs arriving with no `url` at all** render as a placeholder on a client that cannot set headers: `artworkUrls` falls back to per-node authenticated URLs and a client filtering `requiresAuthorization` is left with nothing. Probably refs reconstructed from persisted state rather than a fresh catalogue read. The Android TV client is tracing where they come from; **if they originate in core's own persisted state, it is core's.**
2. **An expired capability is not re-hosted**, so a client filtering authenticated sources keeps one dead URL and the walk finds nothing. Bounded and rare now: `expiredCapability` cannot fire on a freshly read payload — the server's bucket guarantees more than one TTL of validity — so this survives only for a payload held **across a bucket boundary** (persisted state, a long idle).
3. **The Blob path never teaches the host preference**, because `ClusterCatalogueApi` walks internally and returns bytes. **Deliberately not plumbed out:** that path fetches the *authenticated* per-node URL, a different cache key, so a success there says a node serves artwork and says nothing about whether the platform holds capability-keyed bytes for that host. Moving the preference on it would act on evidence that does not bear on the question. Revisit only if a cluster turns up where the Blob path is the normal one rather than the fallback.

---

## P2

### Probe a standby before promoting it
**Waiting on:** core.

Specified, not built. `GET /api/v1/playback/sessions/{id}` returns `engine_running` and `segments_ready` **only when an engine is present**, so their absence is the "reclaimed, needs a cold start" signal — one cheap round trip, and the same GET renews the 30-minute session timer without touching the 60 s pipeline clock. Promotion should expect a cold start rather than counting the promotion as failed.

### `find` cannot distinguish absence from partial failure
**Waiting on:** core.

`ClusterEndpointRouter.find` returns `undefined` both when every node says "not available" and when some said that while another failed with a 5xx. Deliberate — it stops optional metadata blocking playback on an unrelated node failure — but for playback facts the two are different answers, because absent means *transcode everything*, silently. Shape: report whether the walk ended on unanimous absence or on absence-plus-failure, without changing the return for callers that do not care.

### ~~`ClusterUsersApi` has no tests at all~~ — done on `develop`, unreleased
**Waiting on:** nothing. Moves to COMPLETED.md with the version that ships it.

`ClusterUsersApi.test.ts` now covers the read/write split the class is arranged around: a read fails over on a 5xx, a 403 does not walk the cluster, and **each of the five mutations is attempted on exactly one node even when the failure is retryable**. That last one is the assertion that separates `mutation()` from `request()` — it was checked red by routing `create` through `read`, and it is the only test in the file that fails when that happens.

---

## Coverage: what is done and what is left

**Measured 2026-09-15, not estimated.** `npm run test:coverage` prints the table; `coverage/coverage-summary.json` has the per-file numbers.

| | 2026-09-13 (600 tests) | before this pass (720) | now (786) |
|---|---|---|---|
| Statements | 93.4% | 92.1% | **93.94%** |
| Branches | 84.4% | 84.39% | **85.39%** |
| Functions | — | 88.16% | **91.56%** |

Note the middle column: between 600 and 720 tests statements fell 1.3 points. Tests were added and coverage went *down*, because what landed in `0.10.0` and `0.11.0` was covered below the existing average. Worth re-measuring after a release rather than assuming a rising number.

### Done — the cheap half

Each of these guards a rule that had already failed once somewhere, and none needed new harness:

- **`storageKeys.ts` 0% → 100%.** The test drives every persisting component against a recording `StorageLike` and asserts every key touched satisfies `isMachaStorageKey`, rather than comparing the registry against a copy of itself. It went red on its first run: **`macha-client-progress:` — the legacy Continue Watching key, read on every cold start and deliberately never deleted — was not in the registry**, so a host clearing Macha's data through `isMachaStorageKey` left it behind. Now listed. **Add a component to `driveEveryPersistingComponent` when you add one that persists**; the assertion cannot know about a store nobody drove.
- **`ClusterUsersApi` 65.5% → 100%** (functions 14.28% → 92.85%). See the P2 entry above.
- **`MachaUsersApi` 65.1% → 100%.** Only `list` was covered; the eight other methods, the 401-vs-403 split, and the "send only the fields the caller set" rule on `update` now are.
- **`SessionAuth` 74.8% → 93.9%.** The revoke path had no tests at all: 401/403 as already-revoked, a refusal being terminal rather than walked, transport failover, and the empty-registry message that must not read as "cluster unreachable".
- **`ClientLog` 87.4% → 100%.** Level filtering, the ring buffer and its 100-entry floor, `Error` unpacking, nested and in-array redaction, the depth limit, and `clientDiagnosticsConsole()`. The Android TV failure trail runs through this.
- **`errors.ts` 55.6% → 100%.** `abortError()`'s fallback branch — the one that *only* runs on React Native and therefore never ran in a Node suite — is now exercised by stubbing `DOMException` away.
- **`PlaybackRuntime` 86.4% → 90.2%.** The parts that did not need a scenario: capability re-probe after a failed probe, `dispose()` closing the session, the host wait, and a throwing transition not poisoning the queue.

### Left — and it is mostly one place

`PlaybackCoordinator` (89.6% statements, 78.6% branches) and `PlaybackRuntime` are now **most of what remains uncovered**. ACTIVE.md has always said these need scenarios rather than assertions, and that is still true of what is left.

**The leverage: several of those scenarios are the P1 fixes.** Build the scenario and the fix together so the test is seen red — a test written against today's behaviour would pin the bug.

| Scenario to build | Item it closes |
|---|---|
| Storage write throws during the health cycle | P1 — the loop dies silently; `probeNow()` shares it |
| `setBootstrapEndpoints([])` then restart | P1 — permanently unconfigured after a "clear" |
| 200 with an HTML body / JSON missing `items` | P1 — `SyntaxError` to the viewer, node cooled for a schema mismatch |
| A per-title fault on a facts read | P1 — `ClusterPlaybackFactsApi` demotes a node for one bad extent |
| Degrade during failover; `close()` with a failover in flight | Low register — coordinator `1134-1140`, `698-718` |

**What is blocking that work, and is worth doing first: there are three `FakePlayer` implementations.** The shared one (`src/testing/FakePlayer.ts`, which ships publicly on the `./testing` export) and a local one in each of `PlaybackRuntime.test.ts` and `PlaybackCoordinator.test.ts`. The shared one's own header records what the split already cost — a round of "prove the test fails against the broken code" that ran green every time because the code it was meant to break was never the code under test, **and a good test was deleted on the strength of it.** Building failover-racing-a-seek scenarios against that split pays the tax a third time.

### Not worth chasing

- **`checkPlatformSurface`, 51.9% branches.** Those branches are "what this platform lacks", and on Node everything is present. Faking absence per branch tests the mock, not the truth. The honest answer is the Android TV hardware run already tracked under *Watching, not doing*.
- **The coverage-excluded barrels and type files.** `vitest.config.ts` excludes them deliberately and the reasoning there holds.
- **The number itself.** The point of the pass above is that seven specific silent failures became loud, not that a percentage moved.

---

## P3

### Music library state moves into core — approved, not started
**Waiting on:** core. **Tom, 2026-09-13:** yes — *"capabilities differ, but the core should handle this"*, which says the per-client differences are not an argument against the move, they are the thing core absorbs.

Favourites, play counts with a commit threshold, recently-played with a cap. It exists once, in the phone client, and nothing platform-specific is in it. **One implementation is the cheapest moment to move something** — two is a negotiation about constants nobody wants, and the failure is silent: the same library ranking differently in two clients is not something anyone reports.

### Offline and cache policy needs a seam — approved, not designed
**Waiting on:** core, to design. **Tom, 2026-09-13:** yes, there should be a common way to do this.

Four decisions are common to the phone's downloads and the web's read-ahead worker: content-addressed identity as the key, always the original bytes, a bounded frontier, and a failed speculative read treated as non-terminal. The transfer mechanism can never be shared.

Already established: "a failed speculative read is not a playback failure" is **already** core's `subscribeDegradation`/`subscribeFailure` split, which gained `not-ready` for exactly that case. Feed that seam rather than build a parallel one. The real work is deciding, per constant, whether it is a rule (shared) or a tuning (per host) — getting that wrong is how a shared module grows a `platform === 'ios'` branch. **Design it alongside the artwork work**: `ArtworkHostPreference` is the same problem solved once, and content-addressed identity is the key there too.

### Teardown has a ceiling no client can close
**Waiting on:** server (raised, undecided).

`PlaybackRuntime.terminateForPageExit()` rides on `keepalive`, which is browser-only. But the missing property is incidental: **the real cause is process death** — a host that is force-quit, crashes or loses power sends nothing by any mechanism, and no client-side change can fix that.

The cost is not local: a node holds a session's transcode entitlement for `session_idle` — 30 minutes — so on a one-slot node the next viewer gets `429 resource_limit` and nothing points at the client that caused it. No server-side mitigation today: no shorter idle for a session nothing was ever fetched from, and admission refuses rather than evicting. Both raised; the second changes admission from a guarantee into a lease, so it is not a small ask. Calling this promptly is the whole of the defence until one exists.

---

## Low — the register

Verified, each real, none urgent. Grouped by area so a session cleaning one area can take the set.

**Coordinator and playback**
- `PlaybackCoordinator.ts:1207-1250` — both promotion paths record the endpoint failure and then call `resolver.stop()` on the same node, which records again when the DELETE throws. The same double-charge `releaseFailedSession` was fixed for; the resolver has no seam for "close this, the node is already known bad".
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
- `EndpointRegistry.ts:85` vs `EndpointHealthMonitor.ts:10` — the cooldown ladder (500 ms, 2 s) is uncalibrated against the 10 s probe interval; a probe-failed sticky node is "ready" 0.5 s later. Neither constant records the relation. *This is the same class `hlsWalk` and the stall budget were fixed for: assert the inequality, not the number.*

**API layer**
- `ClusterCatalogueApi.ts:27` — `ARTWORK_ENDPOINT_TIMEOUT_MS = 8_000` exactly equals the inner `DEFAULT_REQUEST_TIMEOUT_MS`, so which error the caller sees depends on timer ordering.
- `ClusterCatalogueApi.ts:51-63` — a not-ready catalogue synthesises a 503 that cools down a node that answered.
- `AcquisitionApi.ts:91-104`, `ManageApi.ts:114-128` — no `AbortSignal` on these families, so a polling screen that unmounts still walks every candidate. `MachaAcquisitionApi.request:107-108` also lacks the 204 handling Manage has.
- `connectionConfiguration.ts:78`, `MachaManageApi.ts:32,71` — `cache: 'no-store'` relied on alone, against `platform-neutral.d.ts:108-125`. *Candidate cause for a client reporting stale node versions — candidate, not cause; nobody has verified it.*
- `SessionManager.ts` — `fetch()`'s JSDoc is attached to `authorization()`.

**State, runtime and docs**
- `state/continueWatching.ts:118-126` — the one store that validates only `Array.isArray`; a `[null]` entry throws on every `list()` until history is cleared.
- `state/musicPlaylist.ts:26` — `MusicPlaylistStore` still exported after being superseded by `PlaylistStore`, which adopts its key on first read. Against the hard-cuts rule. **Delete it** — and note `0.11.0` proved the sequence for this: clients take a copy first if they have one, then core removes.
- `runtime/configuration.ts:140-144` — the self-healing `setItem` sits inside the read's `try`, so a write that throws removes the bootstrap key on a read.
- `runtime/configuration.ts:187` and `api/httpCompat.ts:96` — `normalizeUrl` and `normalizeBaseUrl` are the same four lines under two names. **Duplication to delete before it drifts, not a correctness bug** — verified across nine input shapes.
- `docs/examples/headless.mjs:64-68` passes `serverApi` to `EndpointHealthMonitor`, which has no such option.
- `README.md:100-103` — "EndpointHealthMonitor feeds routing its evidence" omits that throughput, which outranks latency, is fed only by a host-built `EndpointBandwidth` that nothing in this package calls `record()` on.
- **The hyphenated storage keys**, now that `macha.session.v1` has moved: `macha-client-id`, `macha-server-url`, `macha-bootstrap-endpoints-v1`, `macha-discovered-endpoints-v1`, `macha-server-endpoints-v1`, `macha-client-bandwidth:`. Two conventions is a defect, not a design. Each costs a forced re-read or a lost value to rename, so they move **when something else already forces that cost** — never on their own. `MACHA_STORAGE_KEYS` documents both meanwhile.

**Simplification, where the payoff is real**
- `request`/`throwResponseError` is triplicated across Catalogue, Acquisition and Manage (plus PlaybackFacts) with three shape-identical error classes, and has already drifted on 202/204 handling. One `jsonRequest` in `httpCompat` would collapse ~60 lines and make the malformed-body fix a single change. `objectValue`/`asRecord` is re-implemented three times.
- `route()`/`find()` duplicate the walk skeleton; every `Cluster*Api` repeats the `instanceof ClusterEndpointRouter` constructor; `evaluatePreferredSwap` calls `candidates()` (a re-sort plus an axis side effect) where `snapshot()` would do.

---

## Watching, not doing

- **The platform probe has never run on a device.** `checkPlatformSurface()` ships having produced no runtime truth; its tests run on Node, which supplies everything. `0.8.0` added the three Hermes probes (`Intl.Collator` options, `normalize`, `\p{M}`). The Android TV hardware run is the first chance at real output.
- **The Android TV failure trail is built but cannot be switched on** — its Settings screen has no focus-follows-scroll and the toggle sits below the fold where focus reaches it invisibly. Not core's, but **every on-device diagnosis discussed here depends on that surface being reachable**, so it gates the evidence core is waiting for. That client has put it ahead of its port.
- **`cpu_cores` and capacity ranking.** Live since server 0.36.7 and the axis switched itself on. Nothing to do unless a node reports stale telemetry — `telemetry_freshness` and `live_age_ms` exist and core does not weigh them. Open question rather than known defect.
- **No pairing or QR concept exists in core, and is not going to yet.** **Tom, 2026-09-13: leave it for the future.** The phone client's payload parse stays local. If a format is ever shared it belongs here — otherwise four clients invent their own and drift on normalisation edges — but that is a decision deferred, not a defect, and should not be raised again until someone needs a second scanner.
- **Two clients still hold a duration formatter.** `formatPlaybackTime` is in core and the web client has dropped its copy. The phone and Android TV clients can drop theirs whenever convenient; nothing breaks until they do, and nothing improves either.
- **Server `0.40.1` adds `diagnostics.repair`** under `GET /api/v1/status/diagnostics` (`unsourceable_objects` plus a bounded sample of ids). **Core is unaffected** — `ClusterStatusSnapshot` has never carried that block — recorded so the next session does not rediscover it.
- **A broken function in core grows a copy in every client, and fixing it does not remove them.** `checkEndpointConfiguration` could not accept any endpoint against a live cluster until `0.9.0`, so at least two clients wrote their own pre-save gate — one of which had the same lockout by a different road. Both fixed, but nobody would have gone back to core's version without being told it worked now. **When a defect in a shared function is fixed, say so to the clients that routed around it**, or the duplicate survives and drifts.
- **Findings that turned out to be misattribution**, recorded so they are not raised a third time: `/api/v1/status` answering `200` with an apparently empty roster, and `/api/v1/health` answering `401`, were both a single node on an old build rather than server defects. And a client's "the signature churns on every fetch" was a *different build*, not a contradiction — see how-to-be-wrong item 2.
- **One transient client test failure during a core rebuild**, twice. Both were genuine mid-rebuild races and are closed by the atomic `dist` staging. If one recurs *outside* a rebuild window, treat it as real rather than as a race.
