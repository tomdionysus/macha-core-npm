# Active

Open work for `@machafoundation/core`. Items land here when they are decided-but-undone, or undecided-and-blocking. Anything finished moves to [COMPLETED.md](COMPLETED.md) with the version it shipped in.

An item says who it is waiting on. "Tom" means a decision rather than an implementation; "core" means it is mine to build; a client name means the evidence has to come from there before this can move.

---

## Start here if you are new to this

### State of play, 2026-09-23

**`0.18.0` is published, and it is the first thing a client could install since `0.14.0`.** Cut from `a3b40ca` on the evening of 2026-09-21; npm records that commit as `gitHead`, the tarball's `dist` hashes `ff5d065c5da7` by `npm run dist:hash` and is byte-identical to a build of the tagged tree, and every other published file matches the tag. 1020 tests in 65 files, typecheck, `lint:platform`, `build` and `dist:check` all clean at the cut. The tag is on `main` and `package.json` reads `0.18.0`. **`develop` carries two source commits past it** — `2f196a1` (`PlaybackRuntime.moveTo`) and `5de9250` (the three faults the first live move found) — **with `dist` hashing `a02a2d979817`**. That is what every linked client compiles against now, and it is in no published version. 1025 tests in 65 files. **The registry holds `0.8.1`, `0.11.1`, `0.12.0`, `0.13.0`, `0.14.0`, `0.18.0` and nothing else** — `0.15.0`, `0.16.0` and `0.17.0` are tags with no artefact behind them, and twenty-one of the twenty-seven tags here are the same. `git tag` is not a release history; `npm view @machafoundation/core versions` is.

**All three client trees pin `^0.18.0` on `main` and carry `file:../macha-ts` on `develop`.** Read on 2026-09-23 from each tree's `main:package.json` and `develop:package.json` — `macha-client`, `macha-client-rn`, `macha-client-rn-tv` — not taken from a message. That is the settled shape: link during development, registry on `main`, gate before the merge. The `test -L` check and the lockfile `resolved` URL are the two things that prove a `main` really is on the registry copy; a version string never does. Nobody has run those checks from here and this file does not claim they were.

**It was cut twice.** `e42b9a9` merged and tagged `0.18.0` on the morning of 2026-09-21 on a reading of "get this out the door"; `cc93243` put the number back the same afternoon, deleted the tag here and on the remote, and said why: *"the work is still in test, nothing was published, and the number had no business moving."* The evening cut ran the gate first and spent the number after. `0.17.0` was deliberately **not** moved forward over the thirty commits behind it, and `0.18.0` cannot move now that it is published. The full account, and everything the release contains, is the `0.18.0` entry in [COMPLETED.md](COMPLETED.md).

**Four changes in it are not additive, and a host meets them rather than opts in:** `hlsWalkTargets` throws `HlsManifestUnavailableError` where it returned `[]`; `FakePlayer.detach()` now stops, on the `./testing` export; `PlaybackEvent.forwardBufferMs` has a contract — a zero during a recovery without `buffering` is not believed; and `Player.subscribeFailure` carries the obligation not to tear the presentation down on `not-found`. The rest is in COMPLETED.

### The three P0s of 2026-09-21, and where each stands now

1. **Nothing was ever closed — shipped in `0.18.0`, and this file does not know whether a `DELETE` has since been watched arriving on a node.** `stop()` and `sessionAlive()` recover a session's node from its id, so a host can close what it holds and what it persisted. **The first thing worth confirming against a live node from a `0.18.0` client is exactly that**, because every field measurement of 2026-09-21 was taken against nodes no `DELETE` had reached — 57 creates and zero closes on fi-1 — and Tom's judgement stands: *"No DELETE on session smashes all the results."*
2. **The per-account cap is counted per node — shipped in `0.18.0`.** Core walks on `account_session_limit` and charges nobody for it; `failureBlamesEndpoint` is the one charge gate. The premise came from the server's own comment, a hundred lines from the loop that disproves it. **Read the loop, not the comment beside it.**
3. **AC-3 audio-copy remux stalls — still the only P0 open, and it is server-side.** The mechanism is **not** `delay_moov`; that was disproved by experiment. Retry count and codec are perfectly confounded in the evidence that produced the AAC-versus-AC-3 split, so **re-run that comparison on a clean cluster before anyone goes into libav.**

### Open, and waiting

- **The orphan reclaim seam.** The television has built its half — `orphanedSessions()` / `forgetSessions(closed)`, inert, nine tests — and core's `stop()` and `sessionAlive()` now make it work. **Waiting on Tom** to say wire it.
- **`moveTo` has run live once, and the first run found three faults, all shipped in `0.18.0` and all fixed on `develop`, unreleased.** `PlaybackRuntime.moveTo` (`2f196a1`) gave it a door. The web client's first move, fi-1 to gbni-1 on 2026-09-23, worked. Twenty seconds later the viewer was pulled back to fi-1, the screen went black, a failover ran, and gbni-1's only transcode slot leaked. `5de9250` fixes all three faults: the old session is now released at the cut, not at activation; the reap path now probes the session core owns (`serverSession`), not the one on screen; and `buildReplacement` never adopts a replacement for a generation that has already been superseded. **Verified live twice by the web client on 2026-09-23 against `5de9250`, fi-1 to gbni-1, on every point:** fi-1 kept serving the outgoing element with no `404`; its `session-stop` landed at the cut (15:03:53.957, 6 ms after the handover resolved), not at `source-move-ready`; no reap, no second fi-1 session; every session answered `404` after stop. **What the viewer still gets is bad and is the web client's handover P0, not core's:** gbni-1 took 8.5-12.3 s to a first fragment at every new position, so the join receded faster than it filled, the picture froze 15-19 s and fell back to a fresh start. **Open question from it, and no answer on the wire:** no node states an expected time-to-first-fragment. `startup_timeout_ms` is a ceiling, not an expectation, and `production` exists only once a generation does. So nothing lets a handover decline up front a join it cannot win. **Ruled 2026-09-23, relayed by the server session: Tom declined a server-stated figure — *"the client is responsible for this"*. Estimating pipeline start cost before a move or handover, and deciding whether to join, is core's.** See *Core estimates what a generation start costs* under P1 — design and contract. A broader gap is still open and is not fixed: nothing makes every replacement of `serverSession` close the session being replaced. The guards cover the paths that were measured; they do not make that true everywhere.
- **The Android TV freeze's cause is unconfirmed.** `0.18.0` bounds it at 48 s with `client_recovery_deadline`; nothing explains it. Its entry is in *P1 — correctness* and stays open until a freeze reproduces with the `info` trail on.
- **A clean-cluster re-run** of everything measured on 2026-09-21.
- **Two threads opened by peer sessions on 2026-09-22, both recorded under *P1 — design and contract*:** the server's optional `node_id` on `POST /api/v1/torrents/jobs` (core's contract feedback is sent; core builds nothing until the server names the version it ships in), and the Android TV client's `progressWriteDue` rule for Continue Watching write cadence (a TODO here; its calibration against `SERVER_SESSION_IDLE_MS` is rejected and the entry says why).

**What to do first, when this resumes:** clear every node of leftover sessions; confirm from a `0.18.0` client that a `DELETE` arrives; re-run the AAC-versus-AC-3 comparison against the clean cluster; and then, whatever the cutover's state is — which this file cannot see from here — the test that matters is **a node killed under a playing transcode with failover across nodes**, not a single-node check.

### What the link week taught, kept because it still governs `develop`

**A version number is immutable once it is published and only then.** Before that it is the name of the thing being built. **Core proposed a `-dev` prerelease scheme to stop the version string equalling a stale tag, and Tom rejected it:** *"NO. Do not do this. We're a development private cluster."* The honest identifier for a moving tree is a SHA, and where a client needs to say what it measured against it records **SHA + dirty state + `dist` hash**, the hash by `npm run dist:hash` and nothing else — three sessions computed three hashes of one `dist` in a day before that script existed, because `shasum` includes the path it is given and one method covered only `*.js` while `dist` carries 72 `.d.ts` files a linked client compiles against.

**A link resolves core's WORKING TREE, not a commit.** *Found 2026-09-21 by the web client, which measured before believing core's own message about itself.* For an hour *"core's `develop` reads `0.18.0-dev`"* and *"the tree this client compiles against reads `0.17.0`"* were both true. So: **do not leave the tree dirty while anyone is linked** — somebody is compiling against it now, not at a moment of core's choosing — and check `git status` is clean and `dist:check` passes before saying anything to a client about what core contains. **Do not rebuild `dist` for a record-only commit**: a commit that did not touch `src` must leave `dist` alone, or it moves under four linked clients for nothing. Batch source commits while a client is mid-verification, and when core is quiescent say so with the full identity so a result can be trusted for longer than one message.

**A build system may not notice core changed at all.** *Found 2026-09-21 by the phone client.* Nothing says Gradle tracks a tree outside the project as a task input, so an "up to date" bundle can ship stale core while every version string agrees. That client deleted the generated JS bundle by hand and proved it: the bundle sha moved from `a94c2e0e65fa9851` to `e44394668997211c`. **A client taking a core change through a link must verify the artefact moved, not that the build ran.** Cold `assembleRelease` is **20m 11s**; incremental after a JS-only change **1m 31s**. Taking a core change onto a device costs ninety seconds plus an install once that client has built once.

**The best post-install check anyone has produced is behavioural, not a version.** The phone client confirmed the new core was genuinely on the device by observing routing lines carrying **both `advisory: true` and `advisory: false`**, which no published core then emitted. **Find a behaviour only the new code produces and watch for it** — a version string, a commit and a green build all agreed throughout, and none of them was evidence.

**A linked client cannot cut a release, and the gate is what makes the link safe.** `main` pins published versions, so while `develop` depends on symbols in no published version nobody tags. That is why `0.18.0` had to go out before any client could — and now that it has, each client's `main` is on it and its `develop` is linked again for the next round. The gate in its final shape: prove through the links on hardware → publish core → clients pin and release → then the nodes move.

**Treat "green" as "does not break the client", never as validation**, and say which you mean when reporting one. Three green suites against `5077468` proved those changes broke nothing; they proved nothing about whether they worked. Nothing built on 2026-09-21 had been exercised against a node bar one smoke test when this was written, and the published artefact has not been reported against one since — that is the clients' to report, and this file records what it is told.

Work happens on `develop`; a release is an annotated bare-semver tag (`0.11.0`, never `v0.11.0`) on `main`, with the version bump *inside* the release commit so the tag points at exactly what ships.

**How to check you have not broken anything:** `npm run typecheck`, `npm run lint:platform` (the no-DOM gate — this is the one that catches a browser global sneaking into core), `npx vitest run`, `npm run build`, `npm run dist:check`. The suite is **1020 tests in 65 files, all passing** as of `0.18.0`. Run all five.

**Build LAST, after the final `git checkout`.** `dist:check` compares mtimes, and a branch switch rewrites every source file's. So "build, merge to `main`, tag, checkout `develop`" leaves `dist` stale **even though no source changed**, and every client's `pretest` then refuses. This happened on the `0.10.0` release and blocked a client until it was caught. Core reported "dist is current" in good faith and was wrong within the minute.

**`npm run build` stages and renames; keep it that way.** It compiles to `dist.staging` and moves it into place, because `tsc` removes nothing (so emitting in place leaves orphans that `dist:check` is structurally blind to) and emptying `dist` first made the window *worse* — a client watched its whole suite collapse to "no tests" mid-rebuild. A failed compile leaves `dist` untouched.

**Never put Claude attribution in a commit message.** No `Co-Authored-By`, no `Claude-Session`, no generated-with line. A commit message ends with its last line of prose. This cost a full history rewrite of 16 commits across `main`, `develop` and two release tags on 2026-09-13.

**Four clients consume this package** — a web/TV app, a Samsung Tizen build of the same, a React Native phone app, and a React Native Android TV app. **All three pin the registry on `main` and link this tree on `develop`** — verified from their trees 2026-09-23; the Tizen build shares the web client's tree. So a change on `develop` here reaches every client's `develop` as soon as `dist` is rebuilt, and reaches no client's `main` until it is **published**. The rule and its four-step gate are under *How an unreleased core change reaches a client*; *Moving the clients onto public npm* records why the older registry-only advice was written and what superseded it.

**`@machafoundation/core` is the name everywhere now.** Two clients used to install it as `@macha/core` through a `file:` target — an unclaimed npm scope that would have broken the moment they resolved from the registry, and a dependency-confusion exposure while it stood. Both renamed on 2026-09-15–17. The history is under *Moving the clients onto public npm*; nothing about it is still open.

**Two clients do not use `PlaybackCoordinator` at all.** The phone client calls `ClusterPlaybackResolver.failover` directly and never prepares an alternate. So a fix landed in the coordinator reaches three clients of four. **Check which layer a client actually uses before telling it a fix matters to it.**

### How this project keeps being wrong, and the cheapest way to find out

Each of these has cost real time. The `codegraph_explore` habit in the first is the only reliable defence against most of them.

1. **Inferring a difference instead of reading both bodies.** Two findings in the 2026-09-12 review were wrong this way; two of four "broken" state stores in `0.10.0` were the same. `codegraph_explore` returns both bodies in one call.
2. **Attributing a measurement to the wrong node — or the wrong build.** On 2026-09-13 a client's `exp` measurement and the server's source reading flatly contradicted each other for an hour. Neither was wrong: the bucketing had deployed between them. **Establish which version answered before reconciling anything** — `/api/v1/status` carries it. This cuts both ways: the server read source and reported it as live behaviour; a client measured live and reported it as source.
3. **Reading a transient as a steady state.** A `503 starting` read as a permanent gate, a `403` mid-deployment read as a configuration. Both retracted.
4. **Grepping a tree when the consumer is a separate repo.** "The only consumer in the world" was wrong within hours — a second client wired it the same day, *after* the grep that found none. **Ask the session, do not grep the tree.** No amount of care with the search would have helped.
5. **Reading core's git log to know what a client has.** *New as of 2026-09-15, and it replaces an older version of itself.* "Built is not released" used to mean a client compiles against core's last **build**, so a change on `develop` was invisible until `npm run build` ran here. For a client on the registry it now means the client compiles against core's last **publish** — a change on `develop`, **and even an annotated git tag**, is invisible there until it reaches npm *and* that client's range moves. `0.9.0`, `0.10.0` and `0.11.0` are the worked example: three tagged releases that never existed as far as any client could tell. **`npm view @machafoundation/core versions` is the answer, not `git tag`.** Raised by the web client on completing its move.
6. **Prescribing a change to a client's repo from here.** *The clearest lesson of 2026-09-15, and it went wrong three times in one afternoon.* Core knew one true thing — the package moved to npm — and turned it into blanket instructions about trees it cannot see. Every one was wrong in a way only the client could know:
   - *"Replace your prefix test with `isMachaStorageKey`"* — would have dropped `macha.clientId.v1` at hydration on both RN clients, giving a fresh client id on every cold start and orphaning Continue Watching, the queue, the playlists and the music library. Silent cold-start data loss, and a **larger version of the incident that function exists to prevent**.
   - *"Delete your `pretest`"* — the Android TV `pretest` ran two things, and only one was core's. The other, `version:check`, exists because five builds shipped as `versionCode 1` and the television could not tell them apart. Deleting it wholesale would have reopened that.
   - *"`rm package-lock.json` and regenerate"* — right for one client, wrong as a default: a regen drifts every transitive dependency and puts a second variable in the commit under review.

   Two of the three were caught only because a client checked rather than complied — one by making the change and watching its test fail. **Core may report what it knows about its own package and nothing further: what is published, what is verified, what changed.** What that means inside a client's tree is the client's to determine. The same rule as not clearing another operator's work, one level down.
7. **Grepping core's barrel to ask whether a symbol is exported.** `src/index.ts` is **62 `export * from` lines plus comments**, so a grep for any symbol name returns zero while a runtime import resolves all 198 (as of `0.14.0`; it was 183 at `0.12.0`). The Android TV client ran exactly that check on the installed `0.12.0`, got zero for `SessionNotStartedError`, and was one message away from reporting that the replacement error was not importable — a false defect, in a release where every client had been asked to check its 401 handling. It caught itself with `import()`. **Ask the module system, not the file.** `node -e "import('@machafoundation/core').then(m => console.log(typeof m.X))"` is the instrument.
   **A second face of the same fault, 2026-09-17, and it is the one to watch for.** A client pinning a live test run hashed `dist/index.js` at both ends and reported "pin held, nothing moved". That file is **invariant under every implementation change** — it is the barrel — so the hash was identical across two builds whose `PlaybackCoordinator.js` differed completely, and would not have caught core rebuilding the tree mid-run. The evidence was close to worthless and was offered as decisive. It happened not to matter. **The instrument that works is a hash of every `dist/**/*.js` sorted and hashed again, plus the specific module under test.** Raised by the client itself, unprompted, after the run it had already reported — which is the half worth copying.
8. **Taking a green client as evidence when it is structurally incapable of the failure.** *Named by the Android TV client, 2026-09-15, after it happened twice in one afternoon.* The web client reads `localStorage` through synchronously, so it **cannot** show a read-time migration failing against a caching host. A browser tab does not background as a television app does, so it **cannot** show a session lifecycle transition. Both times the green client was green because the fault was unreachable there, not because it was absent. **This is an argument about what evidence a release needs, not about who is careful** — and it decides who gets a prerelease first. Ask which platform can actually exercise the fault before counting a pass.
9. **Ship a seam to a client before releasing it.** On 2026-09-13 the Android TV client swapped onto `hlsWalk` and **three of its four findings came from the swap rather than from reading the code** — including one that would have destroyed every warm standby on that platform, silently. A client porting onto shared code is a cheap fuzzer for the assumptions in it. Land the seam, name it to a client, let it swap, fix what the swap finds, *then* tag.

10. **Taking a test's first red as proof it tests anything.** *Named jointly with the web client, 2026-09-20, after both repos shipped one in the same week.* Core wrote a test for a runway edge case with 3 s of cover; it passed, and would have passed against the unfixed code too, because 3 s sits below the 26 s lead so both branches behave identically. The client hit the same shape on its seek-origin fix: a first red that was red for the wrong reason. **A test's first red has to be checked for *why* it is red, not merely that it is** — the cheapest version is to neuter the specific line the test is meant to pin and confirm that *that* is what turns it red. Core's rewrite at 40 s, above the lead, does exactly this and fails when `spentSince` is stubbed out. This is the same fault as the three `FakePlayer` implementations one level up: a check that cannot distinguish the two states it is named for.

**Two further habits that paid on 2026-09-13.** Writing a refactor brief surfaced a live core defect before anyone ported — a client compared it against the shape of its own state machine and found the ready-flicker. And a client verifying core's *output* rather than taking core's word found four things nothing else would have: a stale `dist`, an orphaned build artefact, a mid-rebuild collapse, and a shipped comment contradicting the commit that acknowledged it. **Amended 2026-09-15:** the habit is right and the example has largely expired — three of those four were failures of the `file:` link itself and cannot occur against an immutable tarball. Verifying output rather than taking core's word is still the point; the stale-link finding on the day of the npm move is the current example, and it is a better one.

**The rule that settles most boundary questions** (Tom's): *would nearly every conceivable client be required to do this? If yes, core. If not, theirs.* And the one that settles most design questions: no component may assume another is live or healthy, and a dying component's evidence is not evidence.

---

## Open threads — state of play at the cutover, 2026-09-21

**Written 2026-09-21, before `0.18.0` shipped. Core's lines below are updated; the server's and the clients' are as they stood that evening and this file has not been told otherwise.** **The order of work is above.** This section is who is waiting on whom *right now*, because five sessions moved fast today and none of it is derivable from the code.

**BLOCKED ON TOM — and these are the only two things holding the cutover:**
1. **The web bundle deploy.** Every node still serves `index-BGrNH6KR.js`, which has **no `410` in 614,717 bytes**, so it reads a superseded generation as evidence against the endpoint. A replacement is built and verified *in the shipped JS*. **The `ssh`/`rsync` was denied by that session's own permission classifier** — it correctly did not route around it and correctly did not ask core to run it. Tom grants the permission or runs the two commands. **"The web client is ready" and "the bundle is on the nodes" are different claims and only the first is true.**
2. **The cap's number.** Core cannot pick it and will not hold it. See the measurements above.

**Waiting on the server:** the cutover itself, on all three nodes at once; the cap's number; and where the limit and count live with what freshness, which is the last thing core needs to decline a standby *before* being refused rather than after.

**Core: cap work SHIPPED in `0.18.0`, except what the server gates.** Classification, three accessors, `standby-preparation-refused`, `410` tolerance, and the proof that the reason survives to a host — all published, all on every client's `main`. What remains is item 4 below: reading the limit and count off the wire, blocked on the server shipping the field.

**Client readiness, each verified in its own artefact rather than its source:**
- **Web** — 410 in three call paths including the Samsung native preflight; `isSourceGoneStatus` delegating to `playbackFailureKindForStatus` so it holds no status list; cap notice built; two tests asserting it composes no path. Bundle rebuilt against `28d6b70`. **Cannot deploy.**
- **Phone** — route work done; cap on both create *and* failover after finding a refusal was spending failover budget; three accessors adopted. Rebuilding deliberately rather than shipping a tree it cannot describe.
- **Android TV** — cap sentence on create and failover, code string spelled nowhere, verified through Metro from a linked tree. **Rebuilding at the sitting rather than running `f849f445…`**, because `standby-preparation-refused` is the discriminator between a cap-caused freeze and the unexplained one.

**WHAT TO WATCH FOR ON THE FIRST CUTOVER RUN, and it is not a failure.** The web client's framing, and it is the sharpest thing said about the cap: **`standby-preparation-refused` firing with `accountAtSessionLimit: true` while no viewer sees anything wrong.** That is the cap working exactly as designed *and* seamless failover silently getting worse at the same time — no stall, no error, nothing on a screen, just standbys quietly not being built. **It is the state that looks like nothing at all from the outside**, and it is the one a number set slightly too low produces. A viewer-visible cap refusal is the loud case and will be reported by whoever is watching; this is the quiet one and only the trail shows it. **Grep for that event before concluding the cap's number is fine.**

**The test, once the nodes move:** **a node killed under a playing transcode, failover across moved nodes.** Not a single-node check — Tom vetoed that and was right. It is the only test that exercises the routes, `410` on the path that produces it, and the cap against a standby, in the configuration a viewer is really in.

**Still open and NOT part of this cutover:**
- **The Android TV freeze: cause unconfirmed.** The 48 s supervision bounds it; nothing explains it. A post-cutover freeze now has a discriminator it did not have this morning.
- **The arrival-point estimator** — largest live viewer-visible defect, deliberately not started, waiting on Tom.
- **The control-lane walk revisiting a known-dead endpoint at order 1 every call** — core's, its own before-and-after, web client's captures.
- **Two registry entries can be one node** (`ramaroja` fronting) — needs a node to state its own identity; with the server.
- **The A85 plays Direct Play with no audio at all** — no AC-3 decoder, client claims one. **Predates everything. If a post-cutover smoke test says "plays, no sound", the silence is the old fault.**

---

## Client adoption — which version each client actually resolves

**Adopted and tested is not ported** — that distinction is the web client's and it is worth keeping. A third column is now needed: *how* a client resolves core, because "on core" stopped meaning one thing on 2026-09-15.

**The web row was wrong until 2026-09-17** and said `^0.11.1`: that client's `package.json` had moved to `^0.12.0` and this table had not. It was caught from the other side — the client read its own range while checking what core exported and found both its own TODO and this one stating the older figure. **The same drift happened again and was caught the same way:** the web row said `^0.12.0` until 2026-09-19, by which point that client had moved to `^0.14.0` and this file's own opening paragraph said so three sections above. **A table that has to be updated by hand will be wrong within one release** — twice now, both times about the client that moves fastest. **The other two rows remain unverified**, not confirmed; nobody has read their `package.json` since. Ask the client, do not infer it from here.

| Client | Resolves core by | Suite | Ported |
|---|---|---|---|
| Web | **`main`: npm `^0.18.0`. `develop`: `file:../macha-ts`** — read from that tree 2026-09-23. Its own tag is `0.18.0` | 461 at `5077468` (2026-09-21) | **no** — `AccountMenu.signOut` onto `sessionManager.signOut()`, `lastIdentityChange` unsubscribed. Unverified since 2026-09-19 |
| Android TV | **`main`: npm `^0.18.0`. `develop`: `file:../macha-ts`** — read from that tree 2026-09-23. Reports itself at `0.6.0` | 240 at `5077468` (2026-09-21) | **no** — `secureStorage` **not supplied**; token in app-private storage. Unverified since 2026-09-17 |
| Phone | **`main`: npm `^0.18.0`. `develop`: `file:../macha-ts`** — read from that tree 2026-09-23. `version:check` refuses a `file:` dependency on a tagged commit or `main` | 204 at `5077468` (2026-09-21) | **no** — `secureStorage`, `lastIdentityChange`, `signOut`, `probeNow`. Unverified since 2026-09-17 |

**The first two columns were read off each tree's `main:package.json` and `develop:package.json` on 2026-09-23 and are current as of that read.** The suite figures are what each client reported against core `5077468` on 2026-09-21, and the *Ported* column has not been re-asked since the dates shown — treat it as the last thing each client said, not as the state of its tree. **Nobody has run `test -L node_modules/@machafoundation/core` on a client's `main` checkout from here**, and a `package.json` range is not that check.

**But the release's central fix is unverified, and no automated check can verify it.** The `memoryStorage` capture typechecked, bundled, and passed a green suite while a viewer lost their configured endpoint on every restart. So a green suite on `0.12.0` says nothing about whether the getter actually fixed it. **That needs a device session on the television:** set an endpoint in Settings, force-quit, relaunch, confirm it survives; confirm `macha-client-id` reaches AsyncStorage for the first time; confirm the trail shows `throughput-unavailable / insufficient-samples` rather than `no-bandwidth-store`, which would mean `attachBandwidth` never ran.

**Gated on Tom**, because the Settings focus defect gates the failure trail those diagnoses are read from. The Android TV client declined to report "verified" without it — correctly, and citing this file's own rule about green clients back at itself.

**One consequence to state rather than discover:** existing Continue Watching and queue data on that client is orphaned by the fix, because those stores were keyed by the per-launch memory id. Nothing is lost that was not already being lost on every launch.

**The web client verified the way the package will actually be met**, not in place: a fresh clone with no `macha-ts` anywhere on disk, `npm ci`, tarball resolved by integrity hash, typecheck clean, 335 tests green. That is the bar for the other two — an install proved against a tree that still contains a local core proves nothing, as its stale-link finding showed.

**The phone row was wrong here twice over and the client corrected it:** this file said `^0.11.1` when that tree was on `^0.12.0` at its `0.6.0`, and it is now on a `file:` link to this tree's `develop`. **That has a consequence core must act on rather than note:** a change on `develop` is visible there **as soon as core rebuilds `dist`**, with no publish in between. So `dist` being current is no longer only a `dist:check` formality — it is another repository's input, and a half-built `dist` is a client reading a directory mid-write, which is the exact failure the four link-loop incidents were made of. **Build before ending a session that touched `src`.** That client records core's HEAD and a `dist` hash beside any measurement, which is the right discipline and is what makes the link safe from its end.

**The two React Native rows are two codebases, not one.** Stated by Tom on 2026-09-20 because it is the assumption most likely to be made from here: the phone client and the Android TV client are **separate repositories that happen to share a framework**. A finding, a version, a fix or a platform reading from one **does not transfer** to the other and must be asked for again. Everything this file records about `expo-video`, media3, `OkHttpDataSource` deadlines or `PlaybackError.kt` was read from the *television's* tree and says nothing about the phone's.

**The phone client is behind and will be asking how to take a new core. Its rules are the Android TV rules**, per Tom — **and Tom has corrected what those rules are**: *"that's not accurate for either RN TV or phone. They may link for development and should."* **Both React Native clients may link to core's tree during development, and are meant to.** This file said the opposite for both, on the strength of that client's `AGENTS.md:69`, and core repeated it to the phone client inside the same minute it was written. **Tom confirmed the web client the same way — *"Web client can do the same"* — so this is now one rule with no exceptions, and the per-pair framing this file carried is dead.** Linking during development is the answer for all four clients, with the `macha-client` discipline as the safeguard: back to a published `^x.y.z`, `npm install`, prove the link is gone, gate green, *then* merge to `main`. A dist-tag prerelease remains the mechanism for handing a client something to **ship** on, and still needs Tom's word; it is no longer the only way to get an unreleased change in front of one.

**The lesson is about whose rule it is.** A client repo's `AGENTS.md` records what that repo believed; it is not the operator's standing instruction, and core quoted one back at Tom's own question as though it were. Where a repo rule and Tom disagree, Tom decides, and the contradiction gets surfaced rather than resolved from the file — the same discipline this file already applies to two clients disagreeing, aimed at the right authority.

**Whatever the mechanism, answer "what can I have?" from `npm view @machafoundation/core versions`**, never from this table and never from `git tag`, and always separate what is on `develop` and unreleased from what a client can actually install today.

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

**The cost is real and is paid deliberately:** a core change reaches a client only after a publish. **Use a prerelease under a dist-tag rather than reaching for a link** — publish with `npm publish --tag next`, have the client install `@machafoundation/core@next`, and iterate. The install path, the tarball and the resolution are then identical in shape to what a user gets, which is the whole requirement, and `latest` never moves until it is meant to.

**Amended by Tom, 2026-09-17, and the amendment matters more than it looks.** This was read as "prerelease first, always", and a session bumped to `0.13.0-rc.1` and got as far as a packed tarball before he stopped it: *"I don't want to pollute the NPM registry with Forever RC candidate versions. That's amateur hour."* **A published version is permanent** — it cannot be reused, and unpublishing is worse than leaving it. So a version number is spent when there is something worth spending it on, not on each turn of a verify-fix-verify loop.

**The dividing line is what the round trip is for.** *Verifying a fix that is not yet releasable* is a `file:` link to this tree, taken temporarily and removed afterwards; it is the cheapest loop and it is what the link mechanism is actually good at. *Handing a client something to adopt, port against or ship on* is a prerelease under `next`, because then the install path has to be the one a user gets. The four link-loop failures recorded above are all failures of the first case being used for the second — a client reading a directory core was mid-write on, over days. **Superseded 2026-09-20 — see *How an unreleased core change reaches a client*, which settles it for all four clients: a link is a sanctioned development cycle, not only a minutes-long verification, and the gate that keeps it honest sits before `main`.** What survives from the reasoning here is the failure it describes: a client reading a directory core was mid-write on, over days. That is what the gate is for.

### Order — one at a time, not four at once

1. ~~**Web client.**~~ **Done** — released as `macha-client` 0.17.0, verified from a fresh clone with no `macha-ts` on disk.

**Tom, 2026-09-15, asked directly by the Android TV client whether to take the rename or stay on its Settings focus defect: _"Rename now, this is more important."_** That reverses the order that client had chosen, which had put the Settings focus work first. It was right to hold for his answer rather than take core's word: a 62-reference rename plus a lockfile regeneration in its own repo is its operator's call, and **core telling a client "you are clear to proceed" does not clear it** — core can report that a package is published and verified, and nothing more. Its facts were checked independently on its side before it reported, which is the correct handling of a relayed claim.
2. ~~**Phone and Android TV**, on Tom's word.~~ **Done** — both renamed, both on the registry, both verified against the tarball (see the adoption table). The order was right: the web client's fresh-clone verification set the bar the other two were held to.
3. **Tizen** — shares the web build, so it moved when the web client did. Nobody has confirmed a Tizen build from the registry-resolved tree; that is the one unverified cell.

**Keep the dependency move separate from the outstanding ports** (`secureStorage`, `lastIdentityChange`, `signOut`, `probeNow`). Doing both at once means two variables when something breaks.

### The swap does not take, and the obvious check says it did

**Reported by the web client on 2026-09-15, having done the swap.** Editing `package.json` to `^0.11.1` and running `npm install` **silently keeps the existing link** — the lockfile still read `"resolved": "../macha-ts", "link": true`.

The dangerous half is the confirmation. `require('@machafoundation/core/package.json').version` answers `0.11.1`, because the local tree is *also* at `0.11.1`. So the version check passes and the suite goes green while the client is still compiling against the sibling working directory. **A client can complete this swap, verify it, and report success without ever having installed the published package.**

What moves it: `rm -rf node_modules/@machafoundation/core` then `npm install @machafoundation/core@^0.11.1 --save`, after which the lockfile carries the registry URL and an integrity hash.

**Verify by shape, never by version string:** `test -L node_modules/@machafoundation/core`. A symlink means it did not take. This is the same class as the stale `dist` — a check reporting success for a reason unrelated to the question.

**Better still, verify against a tree that cannot contain a local core.** The web client's acceptance test was a fresh clone with no `macha-ts` anywhere on disk, `npm ci`, tarball resolved by integrity hash, then typecheck and suite. That catches cases `test -L` does not, and for the renaming clients it settles the two-copies risk in one move, since a fresh clone cannot hold a stale `node_modules/@macha`.

**And the cached version string can lie in both directions.** The Android TV client reports its lockfile records the linked core at `0.7.0` while the tree on disk is `0.11.1`. So a lockfile version is not evidence of what is installed either — only the `resolved` URL and an integrity hash are.

**Worse for the two renaming clients**, and they have been told: the stale link can persist under the old `@macha/core` key while the new key resolves from the registry, leaving two copies of core in one tree with binding decided by whether the rename is complete. They clear `node_modules/@macha` outright and test both keys.

### `dist:check` stops meaning anything to a client on the registry

**The web client's `pretest` is `cd ../macha-ts && npm run dist:check`,** and it reports the other clients carry the same shape. That check exists because the `file:` link meant a client compiled against core's last *build*, so a stale `dist` was invisible to typecheck and surfaced only at test time.

**Against a registry tarball it asserts something irrelevant** — it validates a sibling working tree the client no longer compiles against, and would pass or fail for reasons unrelated to what is installed. A green check that means nothing is how a real one stops being read.

**Delete it.** With no local link anywhere, there is no case left in which it answers a question the client has. Core keeps `dist:check` for its own release process, where it still guards the thing that gets packed.

### Source maps: closed, do not ship them

`0.11.1` stopped publishing them — 142 files, 404KB, all pointing at `../src/*.ts` while `src` is not in `files`, so none of them ever resolved. `inlineSources` would make them work at +599KB. **Both clients that were asked said no loss and both asked that they not be shipped on their account.** Decided; do not reopen without someone actually asking for them.

- **Web client:** never steps into core in a debugger; its playback diagnostics come out of core's ring buffer through `machaDiagnostics`, which is source-independent.
- **Android TV**, which was the deciding answer and gave evidence from its tree rather than recollection: `playbackFailureTrail()` defaults its input to `clientDiagnosticsConsole().snapshot()` and renders the last 12 warn/error entries onto the television, sized to be read across a room; its console bridge is set to `__DEV__`, so it is **off in release builds** because the write is real cost on a set with no cable attached; and its own docstring settles it — *"a television has no console."*

**The stronger form of its answer is worth keeping**, because it generalises past this decision: there is no mechanism on that platform that *could* consume a map. Release builds run Hermes bytecode and Metro generates its own map from whatever JS it bundles, so a `.map` in core's tarball has no consumer there even in principle. That is a different claim from "we don't happen to use them", and it is the one that closes the question.

### `isMachaStorageKey`'s doc comment told hosts to do the wrong thing

**Found by the phone client on 2026-09-15, by making the change rather than reasoning about it.** Shipped in `0.18.0`.

The comment said *"Use this rather than a prefix test of your own."* Read as intended that means "do not hand-roll a test for core's keys". Read as written it means "replace your own key filter with this", and **that is catastrophic**: the registry lists what *core* owns, and a host owns more. The phone client's `owned()` set is strictly larger, and `isMachaStorageKey` returns false for all of `macha.clientId.v1`, `macha.endpoints.v1`, `macha.discoveredEndpoints.v1`, `macha.downloads.v1.`, `macha.musicLibrary.v1.` and `macha.progress.v1:`.

**`macha.clientId.v1` is the one that matters**: it is the namespace the per-client stores are keyed under, so dropping it means a fresh client id on every cold start, orphaning Continue Watching, the queue, the playlists and the music library at once. Silent — and a *larger* version of the sign-out incident this file's own header cites as its reason for existing.

I made this worse before it was caught: I told both RN clients "if you use your own prefix test rather than `isMachaStorageKey`, this is the moment to switch." The phone client checked instead of complying, and its hydrate test failed at the first assertion. **A client that had taken core's word would have shipped it.**

The comment is now explicit that the function answers "is this one of core's", never "is this Macha's", and the boundary is pinned by tests asserting false for each of those six host-owned keys — so the next person to "helpfully" broaden the registry has to delete a test that explains why.

**Two related corrections of fact.** `macha-client-progress:` — the key `0.11.1` added — is core's own legacy Continue Watching key, read by `state/continueWatching.ts`. I described it to the phone client as "directly yours"; it is not. That client's legacy key is `macha.progress.v1:`, which is its own, already matched by its own filter, and needed nothing. And `macha-session` is deliberately absent from the registry, having been retired in `0.10.0`.

### Adopt-on-read silently assumes the host's storage can see a key core never named

**Found by the phone client on 2026-09-15 while verifying a correction.** Shipped in `0.18.0`. **The Android TV client has been asked whether it is exposed** — its answer is outstanding.

`ContinueWatchingStore.read()` adopts `macha-client-progress:<clientId>` when the current key is empty (`state/continueWatching.ts:143`). The comment above it says adopt-on-read was chosen so *"the caller cannot forget to run it"* — and that is true, but **the guarantee is only as strong as the storage core was handed.**

A host that backs `MachaHost.storage` with a cache hydrated by prefix, rather than reading straight through, answers `null` for any key it never loaded. Core cannot tell that apart from the key being absent. So `read()` finds nothing, adopts nothing, and the migration silently carries nothing across — no error, no log, nothing to attribute it to. **Severity, corrected 2026-09-15 after this file first overstated it: nobody has lost anything.** This package has no users and no device holds a pre-`0.10.0` key, so this is a coupling rather than an incident. Worth stating and testing regardless, because it holds for every read-time migration not yet written — by which time the premise may not hold.

**It works on the phone client only by accident**: `macha-` happens to be in that client's `OWNED_KEY_PREFIXES`. Nothing anywhere recorded that core's migration depended on the host's hydration filter. That client has now pinned it with its hydrate test.

**The general shape, which is the part worth keeping:** the registry is two lists wearing one name — what a host should **clear** when clearing Macha's data, and what a caching host must **load** before core reads anything. Same keys, different reason, and the second is the one nobody thinks of. Any host reading core's storage through a cache has this exposure, for every retired key core still reads.

Stated now in three places, because one was not enough to stop it happening: `MachaHost.storage` carries the obligation, `isMachaStorageKey` notes the load-list use, and `continueWatching.ts` names it at the adoption site. Pinned by a test asserting `read()` queries the legacy key and that every key it queries is registered.

### What the unhydrated keys actually cost the Android TV client

**Answered 2026-09-15: its storage is cached, and the exposure was far wider than the Continue Watching key.** Fixed on its side, 166 tests green, filter now driven by core's exported constants rather than a copied list — so a key core adds in a later release fails that client's suite instead of failing on a television.

**On React Native every host is a caching host, and core made that inevitable.** `StorageLike` is synchronous; `AsyncStorage` is not. There is no read-through option, so the host hydrates once from `getAllKeys()` and answers from a `Map`. That is not a client shortcut — it is the only shape core's interface permits on that platform.

Its filter was `startsWith('macha.')`, so **every hyphenated key was invisible**, and the damage was not limited to a lost list:

- **`macha-client-id` was never written at all — mechanism corrected 2026-09-15 by the client that reported it.** This file first recorded it as "written faithfully every launch and never read back", blaming the hydrate filter. Wrong: `MachaClientConfiguration` **eagerly captured `machaHost().storage` in its constructor**, and that client constructs one at module scope, where under ESM `configureMachaHost()` has not yet run — so it captured `detectHost()`'s `memoryStorage()` fallback permanently. The id was minted into a `Map` every launch and the key never reached `AsyncStorage`. **That is a core defect, not a client one**, and `SessionManager.storage` had documented the identical hazard and solved it with a getter: two copies of one rule, disagreeing. Fixed in `0.12.0`. Its viewer-visible cost was that endpoints set in Settings did not survive a restart. The orphaned stores below are real and were caused by this, not by the filter — the filter fault stands on the other keys, on its own merits. Every per-client store then hydrated correctly and was read under an identity that had just changed — so the dotted keys being right bought nothing at all. Continue Watching, volume, playlists and the playback queue were orphaned every launch, **on development devices; there are no users, so no one's data was lost**.
- **`macha-bootstrap-endpoints-v1` and `macha-discovered-endpoints-v1`** lost each launch, so discovered endpoint history never survived a restart.
- ~~**`macha-client-bandwidth:`** lost each launch~~ — **STRUCK 2026-09-15, and struck rather than demoted.** The Android TV client retracted this itself on tracing writers and readers: `EndpointBandwidth` is the only writer of that key, **nothing in that tree constructs one**, so the key was never written there and the hydration filter was irrelevant to it. There was nothing to lose. It had been recorded here as a "candidate explanation" for routing falling through to configuration order; **a wrong lead in a routing investigation is worse than no lead, because it reads as evidence the axis was once working.** The client's own framing, and it is right.

**This is the `storageKeys.ts` header incident again, on a second client, independently, and worse.** Core shipped two key conventions and named neither until `0.10.0`; both React Native clients then wrote the same filter and lost different things by it.

### npm does not check that a `file:` key matches the package it points at

**Confirmed by the phone client in a scratch install**, and it is the mechanism that let the alias split hide for as long as it did: `@macha/core` symlinks happily to a tree whose `package.json` says `@machafoundation/core`. npm validates nothing about the name. So the wrong key kept resolving, silently, and would have gone on doing so until something resolved from the registry.

Two practical consequences, both from that client's run:

- **`npm install` is not enough to clear stale entries**, but the two clients handled it differently and the Android TV reasoning is the better default. The phone client used `rm package-lock.json` and regenerated, clearing two extraneous entries (one `../macha-ts`, one another session's scratchpad). The Android TV client **deliberately did not**: it deleted the single extraneous `../macha-ts` node instead, because a full regen drifts every transitive dependency and puts a second variable in the same commit. `npm ci` in a clean clone is what proves either approach. Prefer the surgical edit; a regenerated lockfile carries a diff unrelated to the change being reviewed.
- **`metro.config.js` `watchFolders: ['../macha-ts']` must go with the link.** It existed only because npm materialises a `file:` dep as a symlink outside the project and Metro watches only the project directory. Left in, it aims the bundler at a sibling tree the client no longer compiles against — the two-copies risk by a third mechanism, living outside `package.json` and `node_modules`, so neither `test -L` nor a lockfile inspection finds it. **Nothing in vitest catches it** (`react-native` is stubbed, Metro never runs); a real `expo export` in the fresh clone does. The Android TV client had both that and a `nodeModulesPaths` entry pointing at the sibling's `node_modules`, and corrected the characterisation: **it fails louder than "silent"** — a `watchFolders` path that does not exist fails Metro at startup rather than at import, so a clone without the sibling breaks immediately instead of quietly binding the wrong copy. The fresh-clone export proves it either way.

### Metro and the `exports` map — tested, and core's packaging is fine

**Closed 2026-09-15 by the Android TV client, with evidence.** `expo export --platform android` in a fresh clone with no sibling `macha-ts`, installed by `npm ci` from the tarball: **841 modules → 2.2MB Hermes bytecode**, and the bundle hash byte-identical to the one built in its working tree.

So `"type": "module"`, the `.` and `./testing` exports, and the `.js` extensions on relative imports all resolve correctly under Metro **from `node_modules`**, not merely through a link. This was a real open risk — Metro treats a linked tree differently from an installed one — and it is now a tested fact rather than an assumption. Nothing to fix.

---

## Decided 2026-09-15 — shipped as `0.12.0`, except decision 4

Five decisions from Tom, in one sitting. Four shipped together in `0.12.0`; the fifth is blocked and is the only one still open. Two of the four required every client to change. **Kept here rather than moved wholesale** because decision 4's entry carries the collision analysis the storage-key work still depends on, and the other four are the context that makes it readable.

**Four of the five shipped in `0.12.0` and are on npm; decision 4 is still blocked** — see its entry below. The paragraph that stood here warned that none of them existed for any client yet, which was true on 2026-09-15 and stopped being true on publication. **The warning it carried is still the rule, so keep it in that form:** a commit is not a release and a git tag is not a release — `0.9.0`, `0.10.0` and `0.11.0` are the worked example, tagged here and never on the registry — and `npm view @machafoundation/core versions` is the only honest answer to "what can I have".

1. **`SessionManager.fetch` refuses rather than sending a doomed request.** Before `start()` and after `stop()` it throws a clear "not started" error instead of sending unauthenticated, collecting a 401 and returning it. **Tom: "make sure all clients know about this change."** It is a behaviour change — a caller that used to receive a `Response` with status 401 now catches an error — so it is breaking for anyone who inspected the 401. The doc comment is corrected to match, and `fetch()`'s misplaced JSDoc moves onto `fetch()` while there.

**Blast radius, surveyed before implementation rather than after:** the Android TV client reports **zero exposure** — no literal `401` anywhere in its tree, and no `.fetch(` call sites at all, since every call goes through `createMachaServices` with `auth: sessionManager`. Asked of the phone client.

**Implementation note.** The Android TV client flags a window in which an in-flight request can be issued after `stop()`, so that today it yields a 401 and under the new behaviour it would throw "not started".

**Corrected on a re-read, and the correction is of this file rather than of the client.** I was told there was a *narrow* window and wrote it up as *routine, every background/foreground cycle*. That was a generalisation I added. On re-reading its provider: `stop()` runs on **unmount or a `registry` change only** (`MachaProvider.tsx:112-115`), and the `AppState` listener calls `start()` on `active` with **no `stop()` branch at all** (`:135-140`). **A background/foreground cycle does not pass through `stop()`.** So it is rare, not routine.

**The requirement survives, narrowed.** Still distinguish the two cases in the thrown error — "called before `start()` was ever reached" is a caller mistake, "called after teardown" is a different fault — but they are further apart than this file claimed, and the frequency argument for it is gone.

2. **No instruction without facts: wait, bounded, then fail honestly.** Core holds playback while the facts lookup is retried, with a bound rather than forever, and if the bound is reached it fails with a message saying the client could not read the file's details. It does not guess and it does not present a lookup failure as a corrupt file. Open sub-question for implementation: what the bound is, and whether `assumed` stops covering the absence of facts entirely (it should — it means "the device did not tell us one thing about itself", which is a different claim).

3. **Core wires throughput itself, and the axis abstains loudly. Built — and rebuilt once, after the first version quietly gave the point away.** `createMachaServices` attaches the store and installs the recorder, every time, for every host. There is no constructor parameter, no `setTransferRecorder` on the public surface, no `clientId` option — the first version had all three as escape hatches and Tom's reading was right: that was the host still doing the wiring with extra steps. The store is keyed by `MachaClientConfiguration.clientId()`, the same id every client already derives at the same moment; core relies on the `MachaHost.storage` contract rather than refusing to work in case a host breaks it. **The one thing a host does** is feed bytes core cannot see — media — through `EndpointRegistry.recordTransferByUrl`, which is additive. **Tom: "make sure that all clients refactor for this change."** The web and phone clients *remove* their wiring: the third constructor argument, their `EndpointBandwidth`, their recorder, their URL match. The web client replaces `setDirectPlayTransferListener(record)` with a call to `recordTransferByUrl`; the phone client does the same from `DownloadManager`. Android TV changes nothing. The abstention half stands: `throughput-unavailable`, once, when configuration order decides with no data.

4. **One storage key convention — BLOCKED, not built.** Converge everything on dotted `macha.<name>.v<n>`. Both React Native clients have widened their hydration filters, so the sequencing precondition is met — **but the obvious target names collide with keys a client already owns, and the migration would overwrite them.**

   **`macha-client-id` → `macha.clientId.v1` is the fatal one.** The phone client already keys its own client identity there, through `state/connection.ts`. Core writing that key would overwrite a live value with a different one — and `macha.clientId.v1` is the namespace that client's per-store keys are built from, so overwriting it orphans its Continue Watching, queue, playlists and music library in one move. **`macha-discovered-endpoints-v1` → `macha.discoveredEndpoints.v1` collides the same way.**

   **The root problem is that core's dotted convention is indistinguishable from the clients'.** Core already holds `macha.session.v1`, `macha.continueWatching.v1.`, `macha.playbackQueue.v1.`, `macha.playlists.v1.`, `macha.musicPlaylist.v1.`; the phone client holds `macha.clientId.v1`, `macha.endpoints.v1`, `macha.discoveredEndpoints.v1`, `macha.downloads.v1.`, `macha.musicLibrary.v1.`, `macha.progress.v1:`. Same shape, one namespace, no rule separating them — it is luck that nothing has collided yet, and completing the convergence is what would spend that luck.

   **Android TV has stated its keys** — exactly two: `macha.volume.v1.<clientId>` (dotted, in the shared namespace, and *formerly core's*: the name was deliberately kept when volume moved to the clients so no migration was needed) and `macha-playback-failure-trail-v1` (hyphenated, shared with the web client on purpose). Its own reading is that it is the proof of the collision class, not an exception: a dotted key core used to own, two clients now own copies of, indistinguishable by name from `macha.session.v1`, and un-collided only because each client is a separate app with separate storage. Its recommendation, weighted on the phone client's six keys and core's five rather than its own two: **take `macha.core.` and move core's existing dotted keys with it**, because a prefix that ends the class for new keys but leaves five ambiguous has documented the problem rather than ended it, and because the migration is the expensive step and is only paid once.

   **So the naming has to be settled before any migration is written**, and it is not core's alone to settle: a distinct core prefix (`macha.core.<name>.v<n>`) would end the collision class permanently but leaves core's five existing dotted keys inconsistent with it unless they move too, which is a second migration. **Needs Tom, and needs the clients to state every key they own.** Two have; the web client has not been asked.

   ~~Both React Native clients have already widened their hydration filters, so the sequencing precondition is met~~ — see *Proposed: one storage key convention* for the constraint that makes order matter, and note the standing warning that **a green web client is not evidence** here, since it reads through `localStorage` synchronously.

5. **`macha.volume.v1.` dropped from the registry.** Done. `0.11.0` removed `VolumeStore`, so core neither writes nor reads it, and the list means the keys core owns today. **Tom: "There's no client we care about this for — everyone's a tester."** The orphaned value on an older install costs nothing. `macha-client-progress:` stays by contrast, because core still *reads* it.

---

## The agreed order of work, Tom 2026-09-21 — READ THIS BEFORE PLANNING ANYTHING

**Everyone does the cap work now → server cutover → testing → fixing → npm publish → clients fix up to the published package → client releases.**

**Nothing is a GO until the state of play is one where the tests are likely to pass** — core, the nodes and the clients all carrying the change at once. Tom: *"We need a state, on core, with the new servers, and clients using core, where all tests are likely to work. It's not a GO until we reach that state."* Getting there is the work; the cutover is not a thing to be argued into, it is a thing to be made ready for.

**And the test is cluster-wide or it is not worth running. Tom vetoed a staged single-node cutover**, which the web client had proposed and core was carrying: *"Nope. Pointless. Macha's valueprop is resilience, cluster, failover. A test against a single server is pointless."* **All three nodes move at once.** A client pointed at one node watching one generation measures the one thing this product is not; the observation worth having is **a node killed under a playing transcode with failover across moved nodes** — which exercises the routes, `410 generation_superseded` on the path that actually produces it, and the cap's interaction with a standby, in the configuration a viewer is really in. The web client withdrew its own proposal on the same reasoning.

**All three clients answered NO-GO on the cap moving with the routes and were overruled, deliberately:** *"it's not a good idea to wait — move the cap too. We'll test everything when the servers have cut over."* So the mitigation is no longer sequencing. It is **the cap's number**, and **making the cap's effects visible** so that a bad number is diagnosable rather than silent. That second half is core's and is what core built for it.

**Core's cap work, and its state:**
1. **`429 account_session_limit` classified account-scoped** — neither walked nor charged. **Done.**
2. **`playbackFailureCode`, `playbackFailureStatus`, `isAccountSessionLimit` exported** so no client parses a message or re-walks a cause chain. **Done**, adopted by all three clients.
3. **A refused standby is no longer silent.** **Done** — see below; this is the one that decides whether a bad cap number is findable.
4. **Read the published limit and count, and decline to prepare a standby that would be refused.** **Blocked on the server shipping the field.** Core holds no cap number and will not.

**Considered and REJECTED, recorded so nobody optimises it later: skipping failover after a cap-refused regeneration.** When the cap refuses a `regenerate`, `buildReplacement`'s catch falls through to `beginSourceFailover`, which creates another session and will be refused identically — the cap is account-scoped, so every node answers the same. That looks like guaranteed-futile work on the viewer's critical path, which is the exact argument that made a cap refusal non-walking in the first place, and the symmetry is tempting.

**It is the wrong call, and the asymmetry is why.** Cost of attempting: one round trip before a terminal screen the viewer was getting anyway. Cost of skipping: a viewer who *could* have kept watching does not, because the cap cleared in that instant — another device on the account stopped, which is not exotic in a household. **Optimistic on the viewer's path, pessimistic on the speculative one** is already the rule written here for the cap, and this is the viewer's path. The standby case is the speculative one and is where the pessimism belongs, which is what `standby-preparation-refused` serves.

**So the walk stops at the cap and the recovery does not.** Those look inconsistent and are not: a walk tries *other nodes* for an answer only the account can change, while a failover retries *the same question* after time has passed. Do not converge them.

### ~~A refused standby was swallowed whole, so the cap could disable seamless failover in silence~~ — shipped in `0.18.0`

In [COMPLETED.md](COMPLETED.md) under `0.18.0`. Kept as a heading because item 3 above and the cutover section point at it: `standby-preparation-refused` at warn, carrying `accountAtSessionLimit` by name, is the discriminator between a cap-caused loss of seamless failover and the unexplained freeze.

## The route break: playback sessions become a REST resource — CORE OWNS THE TRANSITION

**Tom, 2026-09-21: *"We are changing the route structure for sessions and streams"* and *"You will manage this transition with the clients."*** That closes the coordination question that sat in *Waiting on Tom*: **core is the integration point for this one, by instruction.** The server's plan is committed at `macha/TODO/2026-09-21-playback-sessions-as-a-resource-plan.md` and is agreed with the operator but **not yet implemented**.

**The shape.** `GET /api/v1/playback/sessions` is added (the caller's live sessions, under `items`); the stream becomes a subresource, `GET /api/v1/playback/sessions/{id}/stream/{token}/{generation}/{name}` and `.../stream/{token}/direct`; **`/api/v1/playback/stream/{id}/...` is removed outright, with no dual-serve window and no deprecation period.** A second `POST` stops superseding. A per-account cap ships in the same change.

**All four repositories have now grepped, and the route move composes nothing anywhere.** Not core, not the web client (four hits, all test fixtures), not the phone client (only relative module imports; its one composed URL uses core's own `LIVENESS_PATH`), not the Android TV client (two comments, no code, including its Kotlin engine and its scripts). **So the URL half of this break costs the whole fleet test-fixture edits and nothing else** — which is worth recording because "every client rebuilds its stream URLs" was the assumption the plan was written against.

**One conditional core must honour, named by the phone client and correct.** This is free *provided `source.url` stays absolute and server-supplied*. Every consumer downstream — `expo-video`, `FileSystem.downloadAsync`, `recordTransferByUrl`, a Service Worker proxy carrying it opaquely as a query parameter — feeds a native player or a downloader rather than a `fetch`, **so a relative URL would break all of them at once and silently.** `streamUrl()` absolutises today and must go on doing so through the route change; that is core's commitment, not an incidental.

**One thing the Android TV client flagged to fix on the day: its `PlayerScreen.tsx:367` comment justifies showing the session id on screen with *"`GET /api/v1/playback/sessions` is not a route"*.** That sentence becomes false when the collection ships.

**Core's answer to "do you build stream URLs?": no, and this is verifiable rather than remembered.** `grep -rn "playback/stream" src` returns **nothing but the barrel export line**. The only place a stream URL is touched is `MachaPlaybackResolver.streamUrl()` (`:566`), which **absolutises whatever the server handed back** and never composes a path; `hlsWalk` resolves playlist-relative references against that URL, which is ordinary HLS and follows the server too. **So item 1 of the server's client list is a no-op for core and for every client that takes `source.url` from core.**

**Core does not rely on supersession either.** `regenerate` already releases before it creates — `DELETE` then create, which is exactly the pattern the plan prescribes — and `failover`/`prepareAlternate` create on a *different* node. The old entry *"A playback session is keyed on the bearer token, so a second POST supersedes"* recorded that core survived by three incidental facts; **this change removes the exposure rather than creating one.** Items 2 and 3 are no-ops here.

**Item 4 is not a no-op, and it is the one core has to get right.** Two findings, both from core's own tree:

1. **The cap must not be classified as a node failure, and core cannot classify it correctly today.** A cap refusal is **account-scoped** — every node in the cluster will refuse it identically. If it arrives as a 4xx, `retryableEndpointFailure` stops the walk, which is right by accident. If it ever arrives as a 5xx, core **walks the whole cluster collecting identical refusals and charges every healthy node on the way** via `recordEndpointFailure`. Core's classification has buckets for *node* and *per-title* and **none for account**. This is the concrete forcing case for the three-valued `scope` core has been arguing for, and it now has a date attached to it.
2. **Core routinely holds more than one session per account, by design, and the cap has to be sized for it.** `alternateSessions` is a `Map` (`PlaybackCoordinator.ts:756`): core holds the live generation **plus one or more standbys**, and during a failover it can briefly hold **three** — the dying one, the standby, and the new one. **A cap of 2 would break core's standby discipline silently**, turning the seamless-failover machinery into cap refusals at the worst moment. The server must choose the number knowing this, and core should probably learn the cap rather than assume it.

**The cap evidence is now much stronger than core's first estimate, and two clients moved it.**
- **A dead node's session cannot be deleted, by construction.** The web client measured it driving a real failover with a node killed at the socket: `session-stop` → `DELETE` → `session-stop-failed: TypeError: Failed to fetch` → the close ladder retrying into a void. **The session being abandoned lives on the node that just died**, so it stays live from the cluster's point of view until it expires. **A cap that counts those refuses the create the failover depends on, during an outage, which is the worst moment and the hardest case to reproduce.** And a cascade goes further than one hop — one twenty-minute run put sessions on fi-1, es-1, gbni-1 and via ramaroja.
- **Core's "2 live, 3 transient" is the coordinator's shape, not every client's.** The phone client holds **1, transiently 2** — no standby, both warm-standby attempts tried and reverted. So a cap justified as "core needs 3" must not be set *at* 3 on the assumption that is anyone's ceiling. **And a client adopting a session through the new listing while holding its own is 2 for a client that looks like it holds 1.**
- **A cap per *account* is a cap on a household.** The Android TV client's seat: two televisions, a phone, and whoever is on the web client, **is four viewers before a single standby exists**. It reads as tight under 8 and would rather the limit were per-viewer-session than per-account.

**The server has agreed to publish the limit and the count** — *"I will put the limit and current count somewhere you can read before you plan, not only on the refusal"* — **but has not said where, and that is not a detail.** Core has asked, with a preference: the **limit** on `/api/v1/playback/status`, which core already reads per node on a cycle and already caches per-node budgets from, because it is configuration and changes on reload; the **count** on the session payload, because it is state. **The count must carry an age**, not a bare integer — it is the most perishable number in the system, changing whenever anyone on the account starts or stops anything from a device core cannot see, and the server's own reasoning for `produced_age_ms` being an age rather than a timestamp applies unchanged. **Absence means the node cannot say.**

**What core will do with it, decided now so it cannot drift:** decline to prepare a **standby** when the account is at or near the limit, and name the reason. **Never** use it to decide whether to attempt a generation the viewer is waiting on — a refused attempt costs one round trip, a guessed refusal costs a viewer their film. **Optimistic on the viewer's path, pessimistic on the speculative one.**

**Two answers core needs before it writes a sentence for four clients:** whether the count is per node (the listing and the cap are, so probably) — because *"account at its limit"* reads as global and a client will render it globally, and if it is per node the sentence has to say so; and whether the node can distinguish a standby from a live session, which matters only if the cap is tight.

**BOTH OF TOM'S TWO ASSUMPTIONS ARE NOW FIXED, and neither needed the wire field.** He asked for the standby windows and the deferred release to stop guessing at server numbers and read them. **Neither number is on the wire** — confirmed by the server against its current tree, not inferred from a stale checkout — so both were fixed by removing the need for the number instead.

1. **`session_idle_ms`: the dependency is deleted.** `drainAbandonedReleases` no longer expires anything. A `DELETE` for a session the node has already dropped answers `404`, which is treated as success, so the expiry check was an optimisation masquerading as a boundary. **Core's constant was `1_800_000` against a server-validated minimum of `30_000` — up to sixty times over**, and on a node configured near the floor core would have abandoned strands it could have cleared.
2. **`pipeline_idle_ms`: core takes the floor the server guarantees rather than the default it assumed.** `config_base.cpp:359` **refuses to start a node** with `pipeline_idle` under ten seconds, so **10,000 ms is true of every node that is running at all**. `ALTERNATE_RECOVERY_WINDOW_MS` was `30_000` — the default — and is now `10_000`. **`ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS` at `8_000` was already safe by construction**, being below that floor, and is commented so nobody raises it.

**Wasteful in the cheap direction, deliberately.** On a generously configured node core now discards a standby that would still have been good, costing a preparation that must happen again. Holding one *past* teardown costs promoting something that cannot serve — on the viewer's critical path, during a recovery, on the mechanism whose whole job is to be invisible. **A lost standby is cheaper than a dead one.**

**Core now holds no un-derived copy of server configuration on either path.** Replace the floor with the node's stated figure the moment it reaches the wire.

**THE CAP IS 32 per node, `streaming.max_sessions_per_account`, zero disables.** Arithmetic in the server's config comment rather than anyone's head: four viewers before any standby (two televisions, a phone, a browser) x two per viewer steady and three transiently in a failover = twelve, **plus a cascade's worth of strands each holding a slot for the whole of `session_idle`**, more than one possible on a single node because an haproxy front appears twice in a registry. Chosen for the worst day rather than the average one. **Core accepts it and has no reason to argue** — core holds at most a handful per node and 32 clears the disturbance case with room.

**The server also withdrew its own supporting claim, unprompted:** it had said a cascade strands at most one session per node, so a cap would bite only on a client returning to a node it had abandoned. **Wrong, because two registry entries can be one node behind `ramaroja` and no client can tell.** The cap's number never rested on it.

**Where the limit and count live — answered, and the count answer is better than what core asked for.** The **limit** is configuration and rides the status surface core already caches. The **count** appears *only* on surfaces computed live at the instant of the response — creation payload, collection listing, refusal — and is **deliberately absent from anything cacheable**. Core had asked for an age on the count; the server's answer is that an age measured at emission is always zero, because the count is computed under the lock in the same breath as the response. **What ages is core's copy, and core knows that better than the node does.** So rather than ship a field that always reads zero, it made a stale count impossible to receive. That is the right call and core withdraws the request.

**One gap core's question exposed in what the server had already built**, surfaced by them rather than found by core: `max_sessions_per_account` went onto `GET /api/v1/playback/status`, which is **node-local** — it answers *"what may I hold here"* and not *"where should I put a standby"*. Core needs the limit for every node it might fail over **to**, which is the argument the telemetry block's own comment already makes. **So `pipeline_idle_ms`, `session_idle_ms` and the cap limit are one `NodeTelemetry` change rather than three separate ones** — a wire change across all three nodes, not an afternoon's field wiring. **Tom's call; neither core nor the server acts on it.**

**Core holds no cap number, and must never hold one.** *Checked at Tom's prompting 2026-09-21: `grep` finds no session-cap constant anywhere in `src`.* What core has is the **refusal** — `account_session_limit`, a code the server owns and stated — classified account-scoped so core neither walks nor charges. **The limit's value is a node's configuration and the operator's to set**; a copy here would be the `look_ahead_ms` fault again, which cost a 12.7 s viewer freeze, and the two standby-window literals below are open items for the same reason. **A default is not a contract.** When the server publishes the limit and the current count, read it per response and treat absence as *"the node cannot say"* — never as a number. Until then core plans as though uncapped, which is right: a refused attempt costs one round trip, a guessed limit costs a standby that was never built. Written into `endpointFailure.ts` beside the code set so the next reader meets the prohibition where the temptation is.

**So core's ask of the server is now three things, not one:** a 4xx with a distinct code; a limit core can *read* rather than discover by refusal; and **either don't count sessions on endpoints the cluster itself cannot reach, or expire them fast enough that a failover cascade cannot exhaust the cap.**

**The `410` tolerance spans two repositories, not one.** The web client found that **a `410` on a segment never reaches core as a status**: hls.js raises it, and its own classifier sorts it before core hears anything — `isHlsSegmentHold` is `500`, `isHlsSourceNotFound` is `404`, and everything else falls to `isHlsNetworkDegradation`, reported as `stream`, **which is evidence against the endpoint.** Same failure mode as core's, one layer lower. It needs a `410` branch beside its `404` one, classified `not-found`, landing in the same window. **Core's sequencing did not cover that and now does.**

**What core must ship BEFORE any node moves**, and this is the standing rule *"core ships tolerance first, nodes move second"*:
- ~~**`410` tolerance**~~ **Shipped in `0.18.0`.** `SOURCE_SUPERSEDED_STATUS = 410`, mapped to **`not-found`** rather than to a seventh kind — the required action is identical (the object is gone, the node is fine, ask the session route), and `not-found` already carries the `Player.subscribeFailure` obligation not to tear the presentation down. **A new kind would put that obligation behind a value every existing host meets as `default`**, so an un-updated host would read `410` as unhandled and condemn a node: the exact failure this tolerance exists to stop, arriving through the fix for it. Three tests, two verified red against the branch; the third guards that `418` and `451` still answer `unknown`, because tolerance is not a licence to invent meanings.
- Whatever status the **cap refusal** uses, core must not walk or charge on it.

**Open questions core has put to the server** (see the message log): whether the collection `GET` is **node-local or cluster-wide** — core's sessions are keyed `${endpoint.id}::${nodeSessionId}` and are node-local, so a client adopting "the account's sessions" must either fan out across nodes or be told the listing is per-node; and whether an adopted session arrives **with its endpoint**, because every core recovery path needs provenance and throws `has no endpoint provenance` without it.

**Sequencing, and where it stands:** core's tolerance (`410`, cap status, provenance recovered from a session id) **shipped in `0.18.0` and every client's `main` pins it** — the clients' half of "first" is done. The server moves the routes **second**, and the clients need nothing for the URL move because they follow `source.url`. **Whether the nodes have moved is not visible from this tree; ask the server session.**

## Waiting on Tom

- ~~**The package alias split.**~~ Decided 2026-09-15: `@machafoundation/core`, because `@macha` is an unclaimed scope and `@machafoundation/core` is already published and owned. See *Moving the clients onto public npm* above.
- **Coverage.** Deferred 2026-09-13: *"not at this time, we'll update later."* Re-measured 2026-09-15 and the cheap half taken; see *Coverage: what is done and what is left* below for where it now stands and what the rest costs.
- ~~**Does `macha.volume.v1.` stay in the storage registry?**~~ **Decided: dropped**, in `0.12.0`. `runtime/storageKeys.ts:28` records it as "Retired and deliberately absent" with the reasoning, which is the opposite of the "leaning keep" below. The argument is kept because it is the one that still governs `macha-client-progress:`, which stays listed because core still reads it.

  Original entry: `0.11.0` deleted `VolumeStore`, so **nothing in core writes that key any more**, but it is still listed in `MACHA_STORAGE_KEY_PREFIXES` — surfaced by the new registry test, which drives what core writes and cannot speak to what it no longer writes. Both answers are defensible and they are not the same: *keep it* and hosts clearing Macha data through `isMachaStorageKey` still collect the value core left on every device that ran `0.10.0` or earlier — but then the file's opening line, "every storage key this package **owns**", is no longer quite what the list means and should say so. *Drop it* and the registry stays honest, but a value core wrote is orphaned on every existing install and a host enumerating keys reads it as someone else's. **Leaning keep**, with the doc amended to say the list includes keys core has retired but still owns — the same reasoning that keeps `macha-client-progress:` listed. Cheap either way; it just needs deciding before someone deletes it as dead.

### The server is publishing encoder speed, and the operator has asked core to own the client-side coordination

**Raised 2026-09-20 by the server session, on its operator's instruction.** *"I implement it server-side, Core consumes and exposes it, and the clients use what Core gives them"* — with core asked to manage the refactor by talking to the web and Android TV sessions directly.

**The technical half is done and needs no decision.** Core has told the server what it needs on the wire, and the reasoning is in the entry below. Nothing is blocked on Tom for that.

**What is his: whether this repo takes on being the integration point for a three-repository refactor, and on what schedule.** Core said yes to the design question and explicitly declined to promise the coordination, because committing this tree to owning work across two client repos is a scope decision and a peer session's operator cannot make it here. **The server has promised no timeline and its operator decides scheduling**, so nothing is waiting on an answer today — but the ask is real and it should not be absorbed by default.

**Worth knowing before deciding: core is already the natural place.** The chooser lives here precisely so every client decides the same way from the same facts, and a speed figure is another fact of exactly that kind. The alternative — the server explaining it to three clients separately — is the shape that produced two of the divergences already recorded in this file.

### ~~The law numbers mean different things in core and on the server~~ — RULED 2026-09-20, do not spend more time on it

Core raised that `docs/principles-and-laws.md` numbers the laws control/viewer/loader 1-2-3 while the server's `ARCHITECTURE.md` numbers them viewer/loader/control, and that both trees cite by number.

**Tom's answer, and it is the useful part:** *"the only reason 3 is 3 is because it's actually kind of 0 — without fast, resilient, top priority control, none of the other rules are possible."* **Control is a precondition, not a rank.** That is the same claim core's own file makes with a strict class order and the server makes as a floor the viewer law may not eat through; they were never two positions. **The laws will be homogenised for everyone soon** and core is not to be pedantic about the numbering meanwhile.

**So: read a law citation for its content, not its number, until the homogenised set lands.** No renumbering here, no Waiting-on-Tom, no more messages about it.

**Law 4 stands and is adopted unchanged**, since neither tree had a fourth: *Thou Shalt Not Shoot Thyself In The Foot* — no operation may leave the node, or the client, in a state it cannot recover from on its own. A veto over the priority laws rather than a rank among them. Its test is *"if this goes wrong on the node furthest away, does it come back without me?"*; the client's version is a television in another room nobody will relaunch.

**Three of its self-healing disciplines already have items in this file, and naming them is worth more than the items were separately:**
- ***A bound smaller than one unit of its own work is not a bound.*** The cooldown-ladder entry in the low register verbatim — 500 ms and 2 s against a 10 s probe interval — and also why `replacementLeadTimeMs` has an attempt-budget floor. The register called it a missing comment; the discipline makes it a defect.
- ***Re-derive, do not assert.*** The runway re-read at the decision point is exactly this, built the day before the law existed.
- ***Every retried work item gets backoff, a failure budget, a parked state and an operator action.*** `releaseFailedSession`'s close ladder has all four; the facts retry has a budget; **the cooldown ladder has backoff and none of the other three.**

### ~~How an unreleased core change reaches a client~~ — SETTLED 2026-09-20 for all four clients: they may link, and should

**Tom ruled 2026-09-20, unprompted, for the macha-client pair: direct linking to core's tree during development is fine** — *"the projects need to work together"* — **and the gate is before `main`, not before the link.** Switch `package.json` back to a published `^x.y.z`, `npm install`, and only then merge and push, because `main` has people looking at it and must work at all times. That client has written it up as a procedure rather than a principle, *because the principle is what failed last time*, and the step worth copying is the second:

1. **`npm install @machafoundation/core@^x.y.z`, explicitly and by name.** **Not** a lockfile edit, and **not** a bare `package.json` spec change followed by `npm install`. *Established 2026-09-21 by two clients across two machines, after **both** of their causal explanations were falsified — including the one this file adopted for an hour.*

   **The unlink is a check, not a step, and that is the whole finding.** The explicit ranged install is the only action that rewrote the lockfile entry **every time on both machines**. Everything else disagreed:
   - *"A bare spec change keeps the link, because the installed version satisfies the range."* Core recorded this from the Android TV client's morning run. **That client re-ran the identical step on the identical tree six hours later and got a real directory** — same command, opposite answer.
   - *"The lockfile entry survives a delete and npm restores the link from it."* The phone client measured exactly that and core adopted it, because it explained both observations and the first account could not. **The Android TV client's afternoon run falsifies it too**: directory deleted, plain `npm install`, lockfile untouched — real directory.

   **Neither session has isolated what npm is keying on, and neither is guessing in a durable file.** Same npm 11.9.0, same node 24.14.0, same lockfile v3. **Recorded as unresolved in all three repositories rather than settled by core picking a winner** — core has now been wrong about the cause twice in one afternoon, in both directions, which is the argument for writing down the check instead of the theory.

   **What survives, and it is enough:** the explicit ranged install always worked, and the verification below cannot be fooled. The `0.7.0`-against-`0.11.1` incident still belongs here, and the moral has narrowed to **verify the artifact** — which is the rule the Android TV repo already had for APKs and is now applying to its own dependencies.

2. **`test -L node_modules/@machafoundation/core` must fail.** **`package.json`, the installed `version` string and a green typecheck all agreed with the link every single time, on both machines.** Those three cannot tell you anything; this one cannot lie.
3. **Read `resolved` in the lockfile** — it must be a registry tarball URL. Not `package.json`, and never the version string, which agreed with the range through all three of the phone client's attempts. Then `typecheck` and the suite green **against the registry copy** rather than the tree the link pointed at.
4. Then merge and push.

Plus the Vite trap, now part of that gate rather than folklore: `node_modules/.vite/deps` survives a symlink swap, so `rm -rf node_modules/.vite` and `--force`, or the verification is of the copy you think you just replaced.

**Settled for the whole class later the same day, and the per-pair answer this entry reached is dead.** Tom, correcting core twice in one turn: *"that's not accurate for either RN TV or phone. They may link for development and should"*, then *"Web client can do the same."* **One rule, four clients: link during development, gate before `main`.** The four-step procedure above is the procedure for everyone.

**Core got this wrong in the most avoidable way and it is worth keeping.** Within the same minute this file was recording "registry only" for the phone client, core sent that client the same instruction — on the strength of the Android TV `AGENTS.md:69` text quoted below, which is **a client repo's record of what that repo believed, not the operator's standing instruction**. Core had already found that exact file stale once (`c658bae`, below) and still treated the next quotation from it as authority. **Where a repo rule and Tom disagree, Tom decides, and the contradiction gets surfaced rather than settled from the file.** The per-pair framing was a careful answer to a question that had one answer all along; the everything-below is kept because the three scars it records are all real and are why the gate exists.

**Closed for the Android TV pair on 2026-09-20, and it went the other way from what this entry predicted.** That client's tree already carried `"@machafoundation/core": "file:../macha-ts"`; core spotted the contradiction with the `AGENTS.md:69` rule recorded below and asked rather than assuming either side was wrong. **The rule was stale, not the tree** — Tom's ruling had superseded it and the file had not been updated. The client has corrected `AGENTS.md` (`c658bae`): registry on `main` and restored before anything merges there, the link on `develop`, and three commands that check the **resolved** copy. It verified all four before rebuilding: the symlink, `package-lock.json` recording `{"resolved": "../macha-ts", "link": true}`, core's head commit, and `withRestatedTransforms` present in the `dist` its build actually imports. Its own incident is kept as the reason the checks exist, which is right — the rule expired, the scar did not.

**The step worth copying from that exchange:** the check that mattered was grepping `dist`, not the version string and not the lockfile, because `dist` is built rather than committed and can lag its own `src`. Core's file already said a version string agrees while a stale link is in place; this adds that a *current* link agrees while a stale build is in place.

**Core has published no prerelease and will not without Tom's word**, because a publish is permanent. Nothing needs one now: both clients that want unreleased core have a sanctioned route to it.

**The original entry, kept for the three-way divergence it records.** Raised 2026-09-20 when core asked both clients to take a temporary `file:` link and **both declined, each citing a rule in its own tree.**

**What this file says** (under *Moving the clients onto public npm*): *verifying a fix that is not yet releasable* is a `file:` link taken and removed in one sitting; *handing a client something to adopt, port against or ship on* is a prerelease under `next`. The link is sanctioned for exactly the case core is in.

**What the Android TV client's `AGENTS.md:69` says**, quoted: *"`@machafoundation/core` comes from the registry. No `file:` link, no `npm link`, and a local `../macha-ts` checkout does not feed this tree — the cycle is deliberately what a user sees on install. For an unreleased core change, core publishes under a dist-tag."* No verification exemption.

**Do not merge these by picking one.** They disagree about a real case and each was written against evidence the other did not have. Core's version is built on the 2026-09-15 finding that three of the four link-loop failures were *caused by the loop*; the client's is built on a lockfile that had cached a link at `0.7.0` while the checkout on disk was `0.11.1`, with a green suite hiding it. **The web client has a third reason and it is not about linking at all:** on 2026-09-18 a link ended up inside its `0.17.2` release commit and would have shipped a tag nobody could install from; the amend was a force-push over a release already pushed, and `main` and the tag held two different trees under one version. *"Tom owns git"* is a standing rule there with that episode cited.

**The clients' proposal is a prerelease under `next`, and it answers the objection core raised.** Your 2026-09-17 amendment was against *"Forever RC candidate versions — amateur hour"*, and that argument is about spending a *release* number per turn of a verify-fix-verify loop. A dist-tag does not spend one: `0.15.0-next.1` is not `0.15.0` and nobody installs it by accident. **Core has not published one and will not without your word**, because publishing is permanent and cannot be undone.

**What is actually blocked:** the runway fix is built, tested and in `dist`, and neither client can exercise it against a real node. The Android TV client's sitting goes ahead regardless — its own probe budget subtracts the event age itself, so it is correct on the paused path either way, and it argues its run is *more* honest against the released core because a pause-blindness symptom would then be unambiguously core's. That is a good argument and it means nothing waits on this except confirmation of core's half.

---

**Two further decisions below are written out in full because each is blocking a P1 that core cannot start without it.** They are ordered by what the laws say they cost: the first is a principle violation reaching viewers today; the second is a contract question.

### The chooser decides with no facts, and the guess reaches the viewer as a corrupt file
**Waiting on Tom** — a decision, not a patch. **Against the principles this is not a tuning question:** *"the server serves facts; the client negotiates … made in core so every client decides the same way from the same facts"* — and here it decided from none. And a `Format error` on screen is the opposite of *"failure and degraded states must be visible and actionable"*. `src/playback/choosePlaybackInstruction.ts:324-329`, `:373`. *Measured on the deployed web client 2026-09-15.*

With the facts call failed, core logged `instruction-facts-failed`, then `instruction-without-facts`, then chose anyway:

    instruction-chosen  mode: direct, video: copy, audio: copy,
                        reasons: ["source-plays-as-is"], assumed: ["hlsVideoCodecs"]

The viewer got `MEDIA_ELEMENT_ERROR: Format error` — **which reads as a broken file rather than as "the client could not ask what this file is"**. The same title plays correctly when facts are available.

**The design question, which is the web client's and is the right one:** `assumed` is built at `:324-329` from missing *capability* fields — `operations`, `hlsVideoCodecs`, `hlsAudioCodecs`, `hlsTs`, `videoBitDepth`. That is "the device did not tell us one thing about itself". It is **not** "we have no idea what this file is", and the two are being expressed by the same mechanism. Should `assumed` ever cover the absence of *facts* rather than the absence of a single capability?

**This is squarely core's.** The chooser lives here precisely so every client decides the same way from the same facts — and here it decided from none. A warning in a ring buffer is not a degraded mode a viewer can act on. Holding for the facts, or failing with a message that says what actually went wrong, both look better than guessing; which one is Tom's call.

**Reachable by any client**, not just the one that found it: a node 500ing or a network blip on the facts call gets here, and neither is a client bug. The web client separately fixed the trigger it owned — a `0.16.0` regression where route reconstruction started playback ~700 ms before an endpoint existed — but that gate only closes the path it opened.

### A failover from an `https` page dies on a plain-`http` node, and core cannot see the scheme

**Waiting on:** Tom for the shape, then core. **Opened here 2026-09-17 on the web client's evidence.** It had been carried in *that* client's `TODO/ACTIVE.md` as "both items are core's" and never opened here, so core did not know it existed. Recorded because it is the second time a finding has lived in one tree while the repo that owns the fix had no entry for it — **saying "this is yours" in your own file is not telling anyone.**

`EndpointRegistry.candidates()` ranks on health, stickiness and throughput. It has no concept of whether a candidate is *reachable from where the page is*. A client served over `https` cannot fetch `http://10.35.1.50:7438` at all — the browser refuses it as mixed content before any request goes out — so every failover from an `https` deployment onto a plain-`http` LAN endpoint dies, and dies as a transport error indistinguishable from a node being down.

**Kept separate from the P0 above on purpose.** It is what made the reaped-session failure *look* like a node problem: the screen named the `http` node the failover had just tried, so the report went to a machine that was never involved. Conflating them is how a day was spent in the wrong place, and merging them here would repeat that.

**The shape, and why it is not simply "filter by scheme".** Core is no-DOM by construction — `npm run lint:platform` is the gate — so it cannot read `location.protocol`, and it must not sniff. The fact has to arrive from the host, which makes this a contract question rather than a filter: something like a stated page scheme on `MachaHost`, or an eligibility predicate the registry consults. Both are public surface. **Do not implement before the shape is settled**, and note the constraint that makes it awkward: the same endpoint list is correct for a React Native client, which has no page scheme at all and can reach both.

---

## P1 — correctness

**Eleven entries that stood here marked *BUILT on `develop`, unreleased* shipped in `0.18.0` and moved to [COMPLETED.md](COMPLETED.md)** — so an entry below that says "the entry above" or "below" about one of these is pointing at that file now: the recovery supervision (`superviseRecovery`), the transform restatement (`withRestatedTransforms`, `recoverWithPreferences`, `interchangeableGeneration`), the playlist `404` reaching the host (`HlsManifestUnavailableError`), the runway re-read (`spentSince`, `emptyBufferIsEvidence`, `readAheadBytes`), advisory status routing, `close()` awaiting its recoveries, the session manager's `generation`, the health loop surviving a storage write, the `/users` envelope comment, the `signIn` obligation, and `find`'s `onAbsence`.

**Ordered against the laws on 2026-09-20, not by age or by who found them.** *Numbering is core's, per `docs/principles-and-laws.md`; the server numbers the same three differently — see the entry in* Waiting on Tom. Law 2 first — anything that makes the viewer wait or stall. Then Law 1 — control work reaching into the viewer's data path, which the principles call a correctness failure rather than a benchmark. Then failures the contract says must be *visible and actionable* and are currently neither. Then the two remaining places core still holds a private copy of server configuration, which is the class `0.14.0` set out to end. The rest is real, verified, and cheaper. Everything here is core's to do; the items that need a decision first have moved up to *Waiting on Tom*.

### A regeneration waits for ever on a close nobody bounded — bound shipped in `0.18.0`, **cause NOT confirmed**

**Waiting on:** a freeze reproduced on the television with the `info` trail on. `releaseWithin` and `superviseRecovery` both shipped in `0.18.0`, so the next one ends in a failover carrying `client_recovery_deadline` after 48 s rather than a frozen frame — and finally leaves a line. **Found 2026-09-20 on hardware by the Android TV client, in front of Tom, within an hour of core opening the path that reaches it.** `ClusterPlaybackResolver.ts` — `releaseWithin`, `regenerate`; `PlaybackCoordinator.ts` — `session-regenerated`'s level.

**What the viewer saw.** A reaped session classified correctly as `not-found`, `source-reaped` → `session-reaped-regenerating` on the right node — and then **nothing, for minutes**. Chrome stuck on *"Preparing new stream"*, position frozen at 5:00, no failure screen, no further trail line. **Strictly worse than the bug it replaced:** before the walk fix the same reap was misclassified `unknown`, took the failover path, and recovered in 7.2 s with the viewer seeing nothing.

**The await, and core had written down both halves of it.** `regenerate` does `await this.releaseFailedSession(failedSession)` at `:295`. That resolves when the **first `DELETE` settles, and nothing anywhere bounds that `DELETE`** — `awaitWithEndpointDeadline` wraps only the `POST` inside `createOn` at `:573`. Meanwhile `releaseFailedSession`'s own docblock says, in bold, *"Never awaited, and never allowed to fail the failover. A slow node is exactly where failover fires, so awaiting this would hang the recovery it is part of."* `failover` honours it (`:212`, `void`). `regenerate` cannot — the node's transcode slot is held by the very session being replaced, so asking before releasing is asking to be refused. **Core knew both halves, wrote both down, and never bounded the one place they collide.**

**Not the retry ladder, which was the obvious suspect and is innocent.** `FAILED_SESSION_CLOSE_ATTEMPTS` and its 1/2/4/8/16 s backoff run in the background; `firstAttempt` resolves on the first settle either way. The ladder could have cost 31 s. This cost minutes, which is the tell.

**Why nothing threw, and this is the general lesson.** **A hang is not an error.** Every bounded thing on the path was waiting on the one unbounded thing above it, so the attempt deadline never fired — it wraps a request that had not been issued yet. No `generation-regenerate-failed`, no `client_endpoint_deadline`, no failover. **Law 4's discipline names this exactly**: *"every retried work item gets backoff, a failure budget, a parked state and an operator action."* The close ladder had backoff and a budget; the thing waiting on it had neither.

**The fix.** `releaseWithin` races the close against the same budget the create uses and proceeds either way, **never rejecting** — the caller's next act is bounded and can fail honestly, so rejecting would turn a slow close into a failure the node never reported. If the slot really is still held, the node refuses, that throws, failover runs: bounded and visible. The ladder continues in the background and `failed-session-close-timeout` (warn) says so, because the node is then holding a slot nothing will release before `session_idle`.

**And the diagnostic asymmetry that made it cost a hardware run.** `generation-regenerate` and `session-regenerated` were at `info` while **every other step of that recovery is `warn`**. So a capture could not distinguish *"the POST never returned"* from *"the POST returned and the failure is after it"* — the one distinction needed. Both are `warn` now. There was no reason for it in any comment, and a regeneration is a degraded state by definition.

**Three tests. The two hang cases are verified red by reproducing the symptom rather than an assertion** — with the bound removed they do not fail, they **time out**, which is what "the viewer waits for ever" looks like from a test. The third guards that a prompt `404` close (the commonest case, since the session was reaped) acquires no delay, and is green either way by design.

**Re-run 2026-09-21 against `0e787f8`: recovered in 1.2 s, and it did NOT confirm the diagnosis.** Close settled (`failed-session-closed`, `attempts: 1`) → create → `session-regenerated` → activate → first fragment in 59 ms → presented. Same node, copy intact. **But `failed-session-close-timeout` never fired, so the bound was never exercised.** The client insisted on the distinction and is right: **this run shows "did not reproduce, and the path works when the close settles", not "fixed".** Recorded that way here at its request and on the merits.

**What the elimination now says, done properly rather than asserted.** Working back through the first freeze's trail:
- `http-error-response` for the `DELETE` **is logged after the body read** (`MachaPlaybackResolver.throwResponseError` awaits `response.json()` first). Its presence proves the body completed, which **rules out a hung body read** — the most plausible receive-then-hang mechanism.
- `stop()` then catches, and a failed `instanceof MachaPlaybackError` (two bundled copies of core, a real hazard under Metro) would log `session-stop-failed` at **error**. Not seen, so the `instanceof` held and `stop()` returned normally.
- `releaseFailedSession`'s `.then` therefore ran, which means **the release settled in run 1**.
- The `POST` is bounded: `generationAttemptBudgetMs` returns at least `ENDPOINT_TRANSPORT_ALLOWANCE_MS` (4 s) and can never be `0`, so `deadlineMs` is always truthy and `awaitWithEndpointDeadline` always applies. A 19 s expiry would have thrown `generation-regenerate-failed` at **warn**. Not seen.
- `activateSession` is synchronous (`:1603`) and returns `void`; a throw inside it lands in the catch as `session-regeneration-failed` at **error**. Not seen, and `preparingSource` stayed `true`, which it can only do if `activateSession` was never reached.

**Those five facts do not fit together, and saying so is the honest position.** Each path that could hang is either bounded or would have logged at a level the run 1 capture could see. **So either the run 1 capture was incomplete, or there is a mechanism nobody has named.** The client has since found that its own trail-watching detector was silently broken — an image crop producing nothing — which is a reason to hold run 1's *absence* of lines more loosely than its presence of them. Tom watching the position stay frozen at 5:00 is not in doubt; what the trail did and did not contain in the gap is.

**The client then closed the three escapes, and the mechanism is genuinely unnamed.** (1) **Run 1's silence is solid.** The broken `sips` crop existed only in run 2's watch loop; run 1 was read by eye across three frames minutes apart — 23:01:02, ~23:04, and after a keypress a minute later — all showing the identical six-line band ending at the `DELETE ... 404`, chrome on "Preparing new stream", position at 5:00. (2) **One copy of core in the bundle**, counted from the installed APK's Hermes bytecode by core-only literals, so the `instanceof` cannot fail. (3) **Nothing was disposed**: `subscribePlayback` forwards from whichever coordinator is current so a swap cannot strand the screen, `setResolver` disposes nothing, and `retry` is gated on `lifecycle.phase === 'failed'` which needs a terminal failure that never happened — and the app was foreground, screensaver off, no route change.

**So all four hold at once: every branch bounded or loud, the close settled, nothing disposed, and `preparingSource` true for minutes. Neither session has a candidate that survives, and neither is inventing one.**

### A playback session is keyed on the bearer token, so a second POST supersedes — core is clear, and not by design

**Established 2026-09-20**: measured against fi-1 by the web client, then confirmed from server source by the server session. **Not core's bug, recorded because core's standby model would be fatally exposed if any of three incidental facts changed.**

**What the server does.** A playback session is keyed on the **authenticated API session — the bearer token** (`src/playback.cpp:2236`, `logical_session_for(request.session->id)`). A second POST on the same token **supersedes whatever that token was playing, across all media**, reusing the session id and incrementing the generation; the previous generation's segments begin answering `404` within about a second. Measured three ways — no keys, distinct `idempotency_key` query parameters as core sends them, and distinct `Macha-Viewer-Session` headers. Same session id every time, generations 1→2→3→4. **`Macha-Viewer-Session` is not read anywhere in the server**; the string appears once, in a comment calling it retired, and `docs/streaming.md`'s claim that omitting it makes each POST a distinct logical session is wrong and is being corrected.

**Why core survives this, stated as three separate facts rather than one intention.** `prepareAlternate` excludes the active endpoint (`ClusterPlaybackResolver.ts:467`), so a standby is never on the same node as the live generation and the two never share a logical session. `regenerate` *does* target the same node, but `releaseFailedSession` runs before the create. And a seek is a PATCH on the existing session, not a second POST. **At most one generation per node per token, on every path.**

**None of those three was written for this reason**, which is the point of the entry. The exclusion exists so a standby is on a *different* node for failover purposes; the release-first exists so the node's transcode slot is free; the PATCH exists because it is cheaper. Any of them could be changed by someone reasoning correctly about its own purpose and unknowingly turn a handover into a black screen. **Cite this entry if any of the three is ever revisited.** The obvious future breakage is a same-node standby for a mode switch, which reads like an optimisation and is not obtainable.

### A representation change lands the viewer where they were when they clicked, not where they are when it arrives — measured live

**Waiting on:** core. **Measured against fi-1 by the web client on 2026-09-20**, in the browser, and traced to the line here the same day. `PlaybackCoordinator.ts:1479`, `:1518-1520`, `:1226`. **This is the arrival-point fault on a path with no handover in it at all**, which is why it matters more than the entry below: it makes arrival-point placement the general fix rather than a handover-specific one.

**The trace, as captured.** A viewer at 93.671 s on Direct Play presses Transcode. Core PATCHes `{mode: transcode, seek_ms: 93671}`. **The negotiation takes 11.5 s.** The node returns a generation beginning at 93,671 — correctly, that is what was asked for — and by then the viewer is at 105,092. Core activates at 105,092 inside a generation starting at 93,671, so the local seek is 11,421 ms in. **The node had produced 1.96 s of it.** Seven seconds of nothing, terminal failure, failover, a new generation built at 105,092 — which worked immediately, because that one was created where the viewer actually was.

**Where it comes from, and the code already has the machinery.** `:1479` binds `seekMs` to `this.snapshot.intent.positionMs` **at dispatch time**, which is right as far as it goes — it stops a queued mutation carrying stale transport intent — but it is still the position at the moment the request leaves, with no allowance for how long the request will take. Then `:1519` computes `userMovedDuringRequest` from `positionRevision`, and consults `activationPosition` only when that is true. **`positionRevision` is incremented in exactly one place, `seek()` (`:1226`) — a viewer action.** Playback simply advancing does not touch it.

**So core compensates for the viewer moving during a negotiation and not for the negotiation taking time.** A viewer who sits perfectly still is the case that breaks, and on a transformed generation the elapsed negotiation is exactly the deficit the encoder then has to make up from a standing start.

**Why this is the same fault as the lead-time entry below.** Both place a new generation at where the viewer *was* rather than where they *will be* when it is usable. One is measured in the lead time, the other in the round trip, and neither has anything to do with handovers — the web client's run never reached its handover code at all, because a mid-playback mode switch is a representation change: PATCH, element reuse, teardown and reattach. **Fixing the placement fixes both.**

**Half the fix is confirmed live, by core's own recovery path.** The failover in that same trace built at 105,092 and presented at 105,092 — arrival point, no rewind. The machinery works; it is simply not on this path.

**What has to be decided, and it is not obvious.** The honest arrival point is *the position the viewer will have reached when the generation is usable*, which needs an estimate of the round trip — and an over-estimate lands the generation ahead of the viewer, which `activationPosition` then has to resolve against the seek contract. The node states `startup_timeout_ms`; core already derives an attempt budget from it and carries it on `PlaybackSource.budgets.deadlineMs`. **That is probably the right input and it is already in core's hands.** But a budget is a ceiling rather than an expectation, and using a 19 s ceiling to place a generation a viewer reaches in 11.5 s is its own fault in the other direction.

### A host driving the resolver directly must not failover on a probe that threw — core's contract says so nowhere

**Waiting on:** core, and it is documentation rather than code. **Raised 2026-09-20** by the phone client, which called the resolver contract correctly from the `.d.ts` and then proposed one rule core has already measured the cost of.

**That client's shape is the case core's docs do not cover.** It constructs no `PlaybackCoordinator`: it calls `ClusterPlaybackResolver` directly, and every `expo-video` error goes `failoverSource` → `resolver.failover` → `recordEndpointFailure`. So a node that reaps a paused session and answers `404` is charged and walked away from — the `0.13.0` fault, in a tree that has `0.13.0`, because the fix lives in a class it does not use. Its plan is to probe `sessionAlive` before spending failover budget, `regenerate` on false, `failover` on true. **Both of those are right and the contract supports them**: `sessionAlive` is pinned to the owning node and **records nothing against the registry in either direction** (`:618-635`), and `regenerate` releases before creating and re-applies `withServedSegmentContainer` (`:274-316`).

**The third clause is the one core has already paid for: *failover on a probe that throws*.** `sessionAlive` throws for two unrelated reasons and they want opposite actions.
- **`has no endpoint provenance`** — the resolver holds no record of that `sessionId`, because it was already released. **Nothing is wrong and nothing needs recovering.** Core's own comment at `PlaybackCoordinator.ts:2331` records what treating this as "could not find out" cost: **82 seconds of playable video**, measured 2026-09-17. A late fatal named a superseded source, the probe threw, the throw sent it to failover, and failover released the replacement on its way past. Every step doing exactly what it was told.
- **A transport failure** — genuinely could not find out, and the caller's ordinary evidence handling applies.

**The trap is sharper for a single-player host than it was for core.** That client regenerates, `expo-video` delivers a second error for the *old* source moments later, it probes the old `sessionId`, the probe throws provenance, and it fails over — discarding the regeneration it just completed. Core survives this only because `failNow` checks `pendingReplacement` **before** reaching the probe, which is coordinator machinery a resolver-only host does not have.

**And `alive === true` does not mean failover in core.** The coordinator logs `source-not-found-on-live-session` and **stops** on the degradation path: an alive session answering `404` for a fragment is a fragment past the end of a live plan, the node is fine, and replacing it fixes nothing. That is the churn `not-found` exists to stop. **A host that cannot read the status cannot distinguish that case**, so `alive → failover` is defensible for `expo-video` and is still strictly better than what it does today — but it will fail over on a case core deliberately does not, and that should be a decision rather than a side effect.

**The guard core suggested does not close the trap, and the client proved it.** Core proposed tracking which `sessionId` is current and ignoring failures naming a superseded one. **That cannot work there:** `failoverSource` reads `sessionRef.current`, so a late fatal from a dying source **does not probe the old id at all — it probes the new one, finds it alive**, and under `alive → failover` discards the regeneration completed a second earlier. And the error **never names a generation**: `expo-video` gives `{ message }` and nothing else, so there is no id to match on. The attribution has to come from somewhere other than the error — that client's own proposal is a short quiet period after `player.replace`, in the spirit of its existing seek window. **It is not building the probe until that is settled**, which is right: a wrong guard here converts a fixed fault into a worse one, which is exactly what core did to the television tonight.

**What core owes here, and it is the actual defect.** `sessionAlive` and `regenerate` are public, documented individually, and **nowhere is the sequence written down** — which of the two throws means "stop", the bound on repeated regeneration (`session-regeneration-made-no-progress`, `:2601`), or that `regenerate` throws its own distinct `has no endpoint to regenerate on` when the node has left the registry, where failover *is* right. Three of the four clients now drive playback at a level core has only ever documented through the coordinator. **This belongs in `docs/writing-a-player.md` as a resolver-level recovery section**, not in a message to one client.

### `look_ahead_ms` can describe a gate the running generation will not honour — and core is accidentally right

**Waiting on:** the server (filed there as a P1, Tom decides scheduling) and **one narrow fix here**. **Raised 2026-09-20** by the server session after the web client asked whether the value could move; the server read its own source rather than answering from docs.

**The divergence.** `look_ahead_ms` is serialised from **live configuration** every time a session is rendered, and `PlaybackManager::reconfigure` updates the knobs on a SIGHUP reload. But a running generation's producer gate is **not** live: `MediaSegmentStore` takes `max_ahead_segments` as a **constructor argument** and the `cv.wait` predicate uses that construction-time value for the life of the generation. So after a reload, a session already in flight **reports a frontier its own producer will not honour**, and nothing on the wire distinguishes that from an honest one.

**A second divergence, same root, and it is a refusal rather than a prediction:** `segment_hold_window` **is** read live at request time. The invariant those two are meant to keep — hold window and gate at the same distance, so a request inside it is one production is authorised to reach — is broken by a reload of `max_ahead_segments` alone.

**Core is right here by construction, and the obvious defensive move is the one that breaks it.** `leadTimeMs(session)` reads `session.lookAheadMs` off the held session object (`PlaybackCoordinator.ts:2791`), and that object was serialised **when the generation was created** — from the same configuration `MediaSegmentStore` captured. So core's held value matches the generation's real gate. **A client that "re-reads per session" to stay fresh gets the *new* config's number and is wrong.** The 0.45.0 advice to re-read does not help and actively hurts; the web client has withdrawn its own version of that mechanism for exactly this reason, noting that *"a re-read is confidence-shaped"* — it makes a client believe staleness is handled and stop looking.

**Core's one real exposure, verified rather than assumed.** A PATCH that does **not** create a new generation still replaces the held session wholesale. `PlaybackCoordinator.ts:1567-1570`: a subtitle-only change takes the `sourceIdentity(current) === sourceIdentity(next)` branch — same generation, no new store — and calls `setSession(next)`, adopting that response's `lookAheadMs`. **After a reload, a viewer changing subtitles silently swaps a correct frontier for a wrong one.** Every other `setSession` caller is a genuinely new generation and is fine. **The fix is narrow: preserve `lookAheadMs` across a same-generation PATCH rather than adopting it.** Not built — it wants the server's decision first, since if the server reports from the store instead of the config the adopt becomes correct and this fix becomes wrong.

**Scope, so nobody over-reacts:** it needs a `reload_config` touching those knobs while sessions are in flight. Not an everyday event, no evidence it has happened in the field. It is a P1 there rather than a P2 because **neither side can detect it from a capture** — no log line, no PATCH, no field reveals the disagreement. **`producer_parked` reads the store**, so on a node in this state it tells the truth while `look_ahead_ms` beside it does not.

### The encoder speed is on the wire as of server `0.47.0`, and core has not read it yet

**Waiting on:** core, and it is now unblocked — **the field shipped to all three nodes on 2026-09-20**. Specified by core, built by the server session, documented in its `docs/streaming.md` under *How fast this generation is producing*.

**The shape, verbatim, because getting it wrong is the expensive case.** It is on the **session payload inside `stream`, beside `look_ahead_ms`** — not on `/api/v1/status`, which is what core asked for and why: it is a fact about *this generation*, not about the node.

```json
"stream": {
  "look_ahead_ms": 32000,
  "production": {
    "produced_ms": 48000,
    "producing_ms": 32000,
    "produced_age_ms": 120,
    "producer_parked": false
  }
}
```

- **`produced_ms`** — media produced, in media time. **This is also the production frontier**, so it is the `produced` term in core's `t >= (P - produced) / (rate - 1)` directly. One field doing both jobs.
- **`producing_ms`** — encoder time spent producing it. Rate is `produced_ms / producing_ms`. **Raw and unsmoothed, as core asked**: a rate computed on the node would carry the node's window and the node's smoothing, and the decision is core's.
- **`produced_age_ms`** — how long since the last fragment published, **measured on the node**. An age rather than a timestamp deliberately, so core's confidence decay does not depend on the two clocks agreeing.
- **`producer_parked`** — whether the producer is blocked on the look-ahead gate.

**The trap, and it is aimed at core specifically.** `producing_ms` **excludes time the producer sat parked**, and it has to: the producer runs to `max_ahead_segments` beyond demand and then blocks, so a viewer watching at normal speed keeps it parked for most of a generation's life. **A rate reconstructed from `produced_ms` and wall time between two polls reads about 1.0x however fast the encoder really is** — and `1.0x` is exactly the value at which core refuses the handover. So the wrong implementation refuses precisely the handovers that would have worked, silently, and looks correct. The web client measured **1.49x** by pulling flat out; this field reports that same 1.49x for a viewer watching normally. **Do not reconstruct the rate. Divide the two fields the node sent.**

**Three guards, stated by the server rather than discovered by core.**
1. **`producing_ms == 0` means no reading yet, not an infinite rate.** It is zero until the first fragment lands. Guard the division.
2. **A large `produced_age_ms` means two opposite things** — a wedged pipeline, or one comfortably ahead and waiting for this viewer. **`producer_parked` is the only thing that separates them.** Parked and old is healthy; not parked and old is mid-fragment or stuck.
3. **`stream.production` is absent for direct play**, and absent on an older node. **Absent means the node cannot say, never zero and never a default** — the same convention the per-node budgets already use, which is why it lands safely in a mixed-version cluster.

**One bias the server chose deliberately and told core about rather than letting it be found.** `produced_ms` and `producing_ms` cover the same fragments *including the first*, so pipeline start-up is charged to the rate: the figure reads low early in a generation and settles as it runs. The alternative — excluding the first fragment — times `n-1` fragments while counting the media of `n`, a **2x overstatement at the second fragment**, which is exactly when a handover call gets made. **Understating defers a handover; overstating stalls a viewer on a promise the node cannot keep.** The right one was taken.

**Deploy skew, which bites before it settles.** gbni-1 was on `0.43.0` and es-1 on `0.46.2` when this was sent; all three go to `0.47.0` the same day. Until they do, **gbni-1 has neither this field nor the `0.46.0` seek contract**. Handled for free by rule 3 above.

**What core does with it, already agreed with the web client and not yet built.** A **deadline on `PlaybackSource.budgets` that can say "never"**, plus the rate itself for viewer-facing messaging; and **on `rate <= 1` core skips the handover and names the reason** rather than attempting a join it can prove is unreachable. **The Android TV client does not do source handover at all** — `promoteStandby` hands the surface to an already-primed second `VideoPlayer`, sets `currentTime` and plays, with no join point computed — so for that client the figure is **diagnostics only**: *"a generation producing below 1.0x is a node that will never keep up, and that now has somewhere to be read"*. Its instruction to core was explicit: **expose it if it is free, do not build anything for that client.**

**Two questions core asked and the server answered the same day, both from mechanism rather than intent.**

*Does `producing_ms` exclude only look-ahead parking, or all producer idle?* **Only the gate, and structurally rather than by subtraction.** `producing_ms` accumulates from the moment one `publish_segment` returns to the moment the next is *entered*, and the timestamp is taken at the top of the function before the mutex is acquired — the `cv.wait` on the gate happens after that point, inside the call, so the parked interval falls outside the measured span. **Everything else is in**: demux, decode, filter, encode, mux, disk, a busy GPU, contention with another session's pipeline. So the rate means *"how fast this node will actually produce for this viewer"* and **not** an upper bound on the encoder — a node under contention reports a genuinely lower figure, which is the correct input to a reachability decision. This was the answer core wanted and the one that would have been silently wrong the other way: an upper bound makes core optimistic in exactly the direction that stalls a viewer.

*Is it on a PATCH response as well as a create?* **On all three** — `201` from create, `200` from `GET /sessions/{id}`, `200` from every PATCH, through one `session_json` serialiser.

**And the wrinkle that would have bitten core, which the server volunteered.** A PATCH that changes mode, quality, seek or media **creates a new generation with a new segment store**, so `stream.production` on that response describes a pipeline that has produced nothing yet — typically `producing_ms: 0`. That is guard 1 working, not a node that has stopped. **The trap is reading a PATCH response as a fresh reading of the same pipeline; it is the first reading of a different one.** The corollary for core's deadline work is sharp: **a rate carried across a PATCH is a rate for a pipeline that no longer exists — discard it when the generation changes rather than decaying it.** For a current rate on a running generation, `GET` the session. Core's own arrival-point entry is about a mode-change PATCH, so this is exactly the path where the two meet.

**Deploy:** `0.47.0` goes to es-1, fi-1 and gbni-1 today, closing the gbni-1 `0.43.0` skew. gbni-2 has been defunct for months and is not in the deploy — worth knowing, because core's candidate walk should not be counting it as a node that might help.

**Shipped in `0.18.0` — the reading half.** `MachaPlaybackResolver` parses `stream.production` into `PlaybackSession.production` (`PlaybackProduction`: `producedMs`, `producingMs`, `producedAgeMs`, `producerParked`), dropping a partial block **whole** rather than filling it in — a rate built from a present `produced_ms` and a missing `producing_ms` is a number nobody sent, and absent lands in a branch every consumer already handles. `streamProtocol.ts` gains `productionRate()` and `outpacesPlayback()`. **Seven tests**, pinned to the server's own measured numbers rather than invented ones: 2000/771 on the first fragment, 34031/10832 settled, and the three parked readings whose `producedAgeMs` climbs while the rate must not move. `outpacesPlayback(undefined)` is `undefined`, never `false` — collapsing those refuses every handover on direct play and across a mixed-version cluster, which is the class `0.14.0` existed to end.

**Still to build, and it is the half that touches the viewer:** the deadline on `PlaybackSource.budgets` that can say "never", and the `rate <= 1` refusal that names its reason. Neither is started.

**This does not resolve the arrival-point item below, and must not be allowed to look as though it does.** That entry's own conclusion still stands: making the lead a function of a measured production rate is *strictly worse* than splitting the two positions, because it uses a per-node per-title measurement to choose a number the arrival-point fix makes irrelevant. **The speed factor's job is deciding whether a join is reachable at all, not where to place a generation.** Build the placement fix on its own terms.

### The replacement is built at the position the viewer is at, not the one they will arrive at — and the docblock says the opposite

**Waiting on:** core, and the shape needs deciding before it is built. **Measured against fi-1 by the web client on 2026-09-20 (server 0.46.2, curl, before any browser work); verified in core's own tree the same day.** `PlaybackCoordinator.ts` — `REPLACEMENT_LEAD_TIME_MS`'s docblock, `buildReplacement`, `prepareAlternate`, `leadTimeMs`.

**What the docblock claims.** *"A generation is created at the position the viewer will reach, so a longer lead puts the join deeper into it — and past the node's look-ahead the encoder has to run forward sequentially to get there... Inside the look-ahead the join is already produced and costs nothing."*

**What the code does.** Every replacement is created at `this.snapshot.intent.positionMs` — the playhead *now*. **Nowhere in the file is the lead added to a position**; `leadTimeMs` is used only as a timing threshold, at `:2187`, `:2275` and `:2468`, deciding *when* to build and never *where*. So the "bounded above by `look_ahead_ms`" reasoning, which is the argument for leading long being safe, is an argument about a generation core does not create.

**Why that is the fault rather than a documentation slip.** The build starts when the runway has fallen to the lead — so the viewer has `lead` of buffer left, and the new generation begins `lead` *behind* where they will be when it runs out. The replacement has to produce that whole gap and keep up before the buffer empties. **Measured on fi-1: the encoder runs at 1.49x realtime** (70.1 s of media in 47.0 s of wall clock, steady, first fragment ~3.8 s), so it closes the gap at 0.49 s per second. A 26 s lead needs **~53 s** to converge against a 25 s handover budget and 26 s of remaining buffer. The viewer runs dry with the replacement roughly halfway there. **A ~12 s lead on that title would have been reached in ~8 s.**

**It also explains "sometimes it works", which nothing else did.** The margin is the ratio between production rate and lead, and both vary by title and by node — so the same code stalls on one film and not the next.

**The frontier hypothesis is dead, and core raised it.** Core proposed that fi-1 might not state `look_ahead_ms`, leaving the lead unclamped. It states it: **32000** on every transcode session, and `/api/v1/status` gives `{startup_timeout_ms: 15000, segment_timeout_ms: 6000}`. So the clamp computes `min(26000, 32000-4000) = 26000` and the floor `19000`, and `replacementLeadTimeMs` returns the flat 26000 — **the clamp never binds on this node.** Core's position was that the lead needs the frontier rather than encoder speed. The frontier is stated, it is obeyed, and the join is *still* unreachable inside it, which is the condition core itself named as settling the question. **The encoder-speed item is real and it is core's.**

**Two items, now recorded here with their provenance.** Both are from macha-client's `TODO/ACTIVE.md` under *P0 — A transcode handover can never reach its join*, and core had no record of either until the client sent the wording: **re-requesting a generation at the arrival point once the join proves unreachable** — the "a fresh generation seeked to the arrival point beats making an existing one encode its way there" rule, with 1.92 s of cold start measured against ~9 s of catch-up — and **having the lead time account for encoder speed**. Core had been treating its silence on these as considered; it was not.

**What has to be decided before building, because the two positions are right for different cases.** Creating at the *current* position is correct for a reap: the viewer needs media from where they are, immediately. Creating at the *arrival* point is correct for a deferred handover: the old buffer covers the gap and the join wants to be at the new generation's first fragment, which costs a ~1.9 s cold start instead of tens of seconds of catch-up. **The code uses one position for both.** Splitting them is the fix; making the lead a function of a measured production rate is the alternative, and it is strictly worse — it needs a measurement core does not have, per node and per title, to choose a number that the arrival-point change makes irrelevant.

### ~~`segment_not_ready` as a `500` is under review~~ — both stacks answered, and they disagree

**Raised 2026-09-20 by Tom through the server session**, with core coordinating one answer rather than three. **Both stacks have now answered from shipped artifacts, and they do not agree.** hls.js makes `425` expensive; media3 makes `500` harmful. The conclusion is still `500`, and the reason for it is no longer the one this entry started with.

**hls.js 1.6.18, read from the artifact this client ships.** A 4xx is refused an outright retry by an explicit rule, not an accident: `retryForHttpStatus` returns false across `400-499`, widened only by `status === 0 && navigator.onLine === false`. `404` and `425` are abandoned identically; a 5xx retries. **The reasoning core recorded has not rotted.** `Retry-After` is still ignored on the fragment path — the only read of it in the bundle is the content-steering loader, for a `429` on the steering manifest.

**But the refusal is a default, not a law, and that is the part worth keeping.** `fragLoadPolicy.default.errorRetry.shouldRetry` is handed the computed answer as its last argument and **its return value wins outright**, so about five lines make hls.js retry a `425`. The hook has to sit on the error controller's path: for fragments the loader is built with `getLoaderConfigWithoutReties(...)`, so `errorRetry` is null there.

**So `425` is "viable at a price", and the price is the argument against it.** An honest status would be **per-client opt-in** — every player must ship the hook, and one that does not sees a hold as a hard failure, which is the expensive direction. `500` works everywhere by default and asks nothing of a new host. **That is a better argument than either one core had written down**, both of which were about intermediaries (`503` is emitted by every proxy; a `404` invites caching of the absence) and neither of which excluded `425` at all.

**media3 answered on 2026-09-20 and it is the opposite answer, read from `media3-exoplayer-1.9.0.aar`** — the version `expo-video` pins at its `build.gradle:21`. `DefaultLoadErrorHandlingPolicy.getRetryDelayMsFor` withholds a retry for exactly five things, and **a response code is not among them**: `ParserException`, `FileNotFoundException`, `CleartextNotPermittedException`, `Loader$UnexpectedLoaderException`, position-out-of-range. Everything else retries — `404`, `425` and `500` alike — after `min((errorCount - 1) x 1000, 5000)` ms. **So the premise that made hls.js decisive does not hold on the other stack**: there is no 4xx refusal here to design around, and `425` needs no hook, no opt-in and no coordinated release.

**And `500` is not neutral there — it is in the exclusion set.** `isEligibleForFallback` is true for `403, 404, 410, 416, 500, 503`, and a fallback switches track or location and **excludes the failed one for 300 s** (60 s at the second level). Core's hold status therefore tells that client's own player to hold the serving location against the node for five minutes, at the exact moment the node is working and asking to be asked again. **`425` would be retried and would exclude nothing.** On this stack it is not merely acceptable, it is better.

**Two things stop this from flipping the decision today, and both are honest limits rather than hedging.** First, no `425` has been served to that television: this is shipped policy read from bytecode, stated as such by the client that read it. Second — **core's own qualification, not theirs, and it needs checking by whoever has the artifact** — media3 only excludes where a fallback exists; `getFallbackSelectionFor` consults `FallbackOptions`, so on a playlist offering one location and one variant there is nothing to exclude and the retry is the whole behaviour. **How much the `500` actually costs on Android TV turns on whether a Macha generation's playlist gives media3 a second choice**, and nobody has established that. If it does not, the exclusion finding is a latent hazard rather than a live cost, and the balance stays where it is.

**hls.js has no penalty box without content steering, which completes the comparison.** Read by the web client from `hls.js/dist/hls.js` 1.6.18: `PATHWAY_PENALTY_DURATION_MS = 300000` **does** exist — the same 300 s media3 uses — but it lives in `ContentSteeringController`, is keyed on pathway, and **only fires when the manifest declares content steering. Macha's do not.** Without steering, exhausted retries become a level switch or an unresolved `SendAlternateToPenaltyBox` that sets `fatal` and calls `stopLoad()`. **No host is remembered and nothing is excluded for a period.** Default `fragLoadPolicy.default.errorRetry` is `{maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000}`, so about 31 s of backoff; that client overrides none of it.

**So the two stacks are now fully mapped and the asymmetry is clean.** On hls.js a `500` costs **only retries it wanted anyway** and no exclusion. On media3 a `500` costs retries **plus** a 300 s exclusion of the location. A `425` is silently fatal by default on hls.js and free on media3. **Both remedies are client work; the difference is that a missing hls.js hook fails visibly on the first hold, while media3's policy override is already in the RN tree.**

**A contradiction nobody has resolved, and it blocks deciding on the reading alone.** The phone client disassembled `DefaultLoadErrorHandlingPolicy` from media3 **1.8.0 and 1.9.0, byte-identical in the relevant methods**, and reads it the same way the television client does: a `500` retries with backoff *and* is fallback-eligible; a `425` retries and is not — **which would make `425` the weaker signal on media3, not the stronger one.** But that contradicts that client's own `COMPLETED` measurement from **2026-09-13 on the A85 against a real node: a segment `500` was fatal on first occurrence on the HLS path, with no retry at all.** Both cannot be true. Its own hypothesis, offered explicitly as unverified: the HLS chunk path reaches the loader through `HlsChunkSource.onChunkLoadError` and **a fallback that is unavailable with one variant**, so something above the policy goes terminal before the retry delay is ever consulted. **That is the same `isFallbackAvailable` question core raised independently**, arrived at from the other direction, and it is now the single fact the whole `425` decision turns on.

**The cheap experiment exists and is offered.** The phone client will stand up a node answering `425` for a not-yet-produced fragment and watch `logcat` on the A85 for retry versus terminal — *"one afternoon with a phone"*, and it needs Tom's word for the node. **It has explicitly asked that the server not be moved on the strength of its reading.** Correct posture and the reason to take the offer rather than the reading.

**And the argument core must answer rather than step around, from the web client's `WebHlsPolicy.ts`:** the reason the hold is `500` and not `503` was never retry policy. **Every proxy emits `503` for a service genuinely down**, so a client taught that `503` means "hold, stay on this node" reads a dead node as healthy and never fails over. **haproxy is in front of es-1, one configuration change from fronting that path.** Any move to `425` must not quietly re-open that, and `425` does not — but a future "let us just use 503" will, and this is where that gets refused.

**Conclusion: `500` stays, and the reason has changed — which matters more than the conclusion holding.** It is no longer *"`500` is free everywhere and `425` costs every client a hook"*. It is *"the two shipped stacks want opposite statuses, and the hls.js side is the one that needs new code in every client to get what it wants"*. That is a weaker argument than the one recorded this morning, and it is the true one. **The asymmetry to watch: the hls.js cost is paid once per client and is visible at build time; the media3 cost is paid per hold, in production, by a node that did nothing wrong.** If a coordinated release ever becomes cheap — and with three clients and one operator it is cheaper here than almost anywhere — `425` wins on the merits. Written into `docs/writing-a-player.md` with both readings dated. The web client reached the old conclusion independently and should be told the ground under it moved.

**Two corrections to core's own docs came out of it.** `choosing-playback.md` claimed the body's machine code is *unreachable* on a fragment error in every stack checked. **It is awkward, not unreachable**: `onError`'s third argument is the `XMLHttpRequest` itself, so the envelope is there — with the trap that fragment requests set `responseType = 'arraybuffer'`, so `responseText` throws `InvalidStateError` and it must be decoded out of `networkDetails.response`. Also recorded: hls.js 1.6.18 still ships `loader: XhrLoader` by default, so the doc's caveat about `networkDetails` becoming something else under `FetchLoader` does not bite the web client today.

**Still core's to do when anything moves:** the migration hazard below is unchanged. `playbackFailureKindForStatus` sends an unrecognised status to `unknown`, which is endpoint evidence, so a node that moves ahead of its clients charges a healthy node and builds a standby that cannot help. **Core ships tolerance first, nodes move second**, and the same release wants the `410` the server is adding for a superseded generation. `hlsWalk.ts` has been routed through `SEGMENT_NOT_READY_STATUS` so the protocol has one definition in core rather than three.

**Not taken: an empirical 425 fixture on hls.js — but the media3 answer makes one worth having on the other side.** The web client offered to stand a fixture up and watch hls.js against it; declined then and still declined, because the source reading plus the `shouldRetry` finding settles those mechanics and the cost there is an opt-in no fixture measures. **The media3 question is the opposite shape.** Whether the `500` exclusion bites is a fact about a real playlist meeting a real player, it is exactly what a fixture answers, and it is currently the only thing standing between `425` and being the better status on evidence rather than on reading. Cheap for whoever holds the television; nothing core can run.

### Error context: core decides three things from a failure and the wire states none of them directly

**Waiting on:** the server, which is building this at Tom's direction as of 2026-09-20. **Not a blocker for anything core has shipped or is about to** — the entry exists so that what gets built answers the whole question rather than the one code that started it.

**Core's plumbing is already there and is not the gap.** `parseErrorEnvelope` (`src/api/errorEnvelope.ts:64`) reads `code` and `reason` from three body shapes, `MachaPlaybackError` carries `status`, `code`, `retryAfterMs` and `reason`, and `retryableEndpointFailure` **already prefers a stated reason over the status** — *"a node reporting a 5xx for a file it cannot decode is telling the truth about the file"*. What is missing is not a field to put it in; it is the server saying enough for the fields to be decidable.

**Core makes exactly three decisions from a failure, and they are orthogonal.** Every classifier in `cluster/endpointFailure.ts` is one of these wearing a different name:
1. **Walk or stop** — is another node worth trying for this title? (`retryableEndpointFailure`, `TERMINAL_SOURCE_REASONS` vs `NODE_LOCAL_SOURCE_REASONS`)
2. **Charge or not** — is this evidence about the node's *health*, or about one title on it? (`isPerTitleFailure`, `PER_TITLE_FAILURE_CODES`)
3. **Retry with less, or not** — could a *different instruction* succeed on this node? (`isExecutorRefusal`)

**All three are currently inferred, and the defaults are guesses.** Absent a stated reason, the walk/stop answer falls back to `status === 429 || status >= 500`, so **every 4xx except 429 stops the cluster walk**. The charge/no-charge answer falls back to a three-entry code list. The retry-with-less answer is a bare `status === 400`.

**What the guess costs today, traced rather than supposed.** A node refuses a copy it cannot perform: 400, `bad_playback_request`. `retryableEndpointFailure` returns false, so `create` throws out of the candidate walk on the first refusal rather than trying the next node. `recoverWithPreferences` then degrades the instruction and restarts the walk from the beginning — and the *first* node now accepts the transcode. **So a viewer gets a full re-encode on node B because node B could not copy, while node C, which could have, was never asked.** That is a quality loss on every failover of a copied stream in a mixed-build cluster, and it is invisible: every step behaves exactly as designed.

**What core needs, stated as the three axes rather than as a list of codes.** A capability refusal is *walk: yes, charge: no, retry-with-less: yes* — and getting that one right is what turns the trace above into "ask node C for the copy first, and only then step down". Compare `source_unsupported`, which is *walk: no* because every node holds the same bytes, and `source_unreadable`, which is *walk: yes, charge: no*. Those two already work precisely because the server states them. **The taxonomy exists; it is just incomplete.**

**Two constraints on whatever is built.** Core will not key on message text — it is prose, not contract, and matching it would make recovery depend on server wording. And an unstated axis must stay unstated rather than defaulting: core's own rule for the container is that an unanswered question must not read as an answer, and the same applies here.

**Until it lands, the mitigation is in place and is deliberately narrow.** The step down fires only when the request actually asked a node to copy something, so a 400 for any other reason is rethrown untouched. Core's field types also make most malformed shapes unsendable — `mode`, `video`, `audio` and `container` are union types. What remains is a host-supplied preference reaching `instructedPreferences` untyped at runtime, and that is small enough to live with.

**Shape, as the server proposed it back and core amended it.** Three optional fields beside `code`, each omitted when the server cannot honestly state it: a **scope** (content, this node, or the request), a **node-health** flag answering charge, and an **alternative-may-succeed** flag answering retry-with-less.

**Core's one amendment, and it is the case that started this: `scope` must be three-valued.** Content-versus-node has nowhere to put a *malformed request*, which is neither. Labelled node-scoped, core walks the whole cluster collecting identical refusals for its own bug — **worse than today**, where a 400 stops the walk at once. Labelled content-scoped, core behaves correctly but the wire says a core bug is a property of the viewer's film, which is what a diagnostic surface then shows a person. Three values and the walk decision follows unambiguously in all three. **If the approved scope stays narrow, the three-valued `scope` alone delivers it**; the other two fields are the general half and can follow.

**The strongest argument for doing it at all is not the trace above — it is that core is still holding server knowledge it should not hold.** `src/cluster/endpointFailure.ts` holds three hardcoded sets — `TERMINAL_SOURCE_REASONS`, `NODE_LOCAL_SOURCE_REASONS`, `PER_TITLE_FAILURE_CODES` — which are core's private copy of the server's judgement about the server's own failures. They are correct only while someone updates them by hand, and **nothing fails when they drift**: the walk silently starts making the wrong call. That is the class `0.14.0` was spent removing. Stating the axes lets core **delete all three**, and a fault the server adds next year is classified correctly by a core that has never heard of it.

**`alternative_may_succeed` is permission, not instruction** — core keeps its own narrowing regardless. **Not needed:** a fourth axis for "same node, same instruction, wait"; 429 plus `retry-after` already carries it.

**The server's precedent, worth keeping:** the per-node playback budgets are already documented as *"absence means the node cannot say, never a default"*, so unstated-stays-unstated is how this server already talks about unknowns rather than a new convention. That also makes incremental landing safe.

**Status 2026-09-20:** the server judged the three-axis version wider than what Tom approved — a distinct code for the capability case, correct HTTP status, specific code in the body — and took it back to him rather than building past it. Correct call. **Core is not blocked either way**, and the server has been asked to say so to Tom, so it is scheduled on merit rather than as an unblock.

### A node substitutes a remux for a transcode and says so in the payload, and core has never looked

**Waiting on:** core. **Found 2026-09-20** from the server session, unprompted, while answering a different question. Nothing in core reads this today.

**The one substitution shape that exists.** `media_engine.cpp:1770`: when a remux's keyframe index is unusable as a segment plan and `allow_video_transcode_fallback` is set, the planner sets `result.playback.mode = transcode` and logs at INFO. **It is not silent on the wire.** The session reports the substituted mode honestly — top-level `mode` is what was actually *performed*, while `preferences` echoes what was *asked for*. So `session.preferences.mode !== session.mode` is the detector, on every create and every PATCH response, and it is the only shape the server knows of.

**Why core wants it.** This is the exact uncertainty the transform-restatement item above was written around: *"they differ after a server-side substitution, and restating the node's own downgrade would make one bad plan permanent."* Core resolved that by restating from the instruction and never from the echo — which is right, and which means core is now **re-asking for a remux every recovery on a title whose keyframe index will never be usable**, getting substituted every time, with nothing anywhere saying so. One comparison of two fields core already holds turns that from invisible into a fact.

**Shipped in `0.18.0` — the reporting half.** `PlaybackInstructionReport` gains `performedMode` and `modeHonoured`, computed once in `instructionWithServed` beside `containerHonoured`, plus one `generation-mode-substituted` warning per generation — once, not once per snapshot patch, because on the Android TV client warn-level events are on screen for the whole of a film. Four tests, each verified red against its own line, and **two of them were rewritten after passing for the wrong reason**: the first version of the viewer-mode-change test could not distinguish the two candidate comparisons at all, and the once-per-generation test never patched the report twice.

**The memory half is still open and still needs deciding.** Whether core should remember per media that the remux was substituted and choose transcode directly next time. Not obviously right: the fallback is a fact about one node's view of one title, and pinning it would be the same mistake as caching `operations` as a cluster property. **Do not build it without deciding that.**

**What it should do with it, and the shape needs deciding before it is built.** At minimum report it: a substitution is a degraded state and the contract says those must be *visible and actionable*, and it belongs in `PlaybackInstructionReport` beside `containerHonoured`, which is the same question asked about the carriage. Whether it should also stop core re-asking — remembering per media that the remux was substituted, and choosing transcode directly next time — is a real design question and not obviously right: the fallback is a fact about one node's view of one title, and pinning it would be the same mistake as caching `operations` as a cluster property. **Do not build the memory half without deciding that.** The reporting half is unambiguous and can go first.

**This is `containerHonoured`'s twin and should be built like it** — requested and performed kept side by side, absent rather than false when either side is unknown, because an unanswered question must not read as an answer.

### `fetch` still returns a bare 401 when the mint failed — decision 1 closed only half the window
**Waiting on:** core, and it needs its own go/no-go. **Re-verified on `develop` 2026-09-20** — `:509` refuses only on no registry; `:513` hands back the 401 whenever `sent === undefined`. Unchanged since `0.12.0`. **Under the laws this is a visibility failure, not a nicety:** a mint that failed is a degraded state, and the contract says it must be *visible and actionable* — a bare 401 is neither, because it reads as an auth rejection. `src/api/SessionManager.ts`, the `fetch` guard. **Found by the phone client on 2026-09-15 by declining an instruction of mine and checking the installed build.**

`0.12.0` refuses when there is **no registry** — never started, or stopped. It does not refuse when the manager *is* started and simply has no token because **the mint failed**. Verified in the published `dist`:

    if (!this.registry) throw new SessionNotStartedError(...)
    ...
    if (response.status !== 401 || sent === undefined) return response;

With a registry present, a failed mint leaves `token` undefined and `inFlight` cleared, so nothing waits and nothing refuses: the request goes out tokenless, is answered `401`, and `sent === undefined` short-circuits the re-mint and hands that `401` straight back. **That is the same symptom the web client originally reported, reached by a different route** — a caller that read the contract still gets a 401 it was promised it would never see.

**I told the phone client its comment describing this was stale. It was not**, and it had checked rather than complied — the third time today that habit caught something, and the second time it caught me. It widened its own provider's comment instead, since "early" now fails in two distinct ways, and left the accurate one alone.

**The fix is not obvious and that is why it is its own item.** A pending `refreshTimer` means recovery is already scheduled, so `fetch` could wait for it rather than refuse — but `lastMintFailure` may be a *refusal* (`anonymous_disabled`) rather than unreachability, where waiting achieves nothing and refusing is right. The two need distinguishing, which is the same distinction `mintNow` already draws for connectivity.

### The standby windows are bounded by a server number nobody had read — `pipeline_idle_ms`

**Waiting on:** the server for one open question, then core — **but core has a half it can do now**, below. **Re-verified 2026-09-20:** `ALTERNATE_RECOVERY_WINDOW_MS = 30_000` (`PlaybackCoordinator.ts:183`) and `ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS = 8_000` (`:214`) are still literals. **This is the class the principles name outright** — *"the client must not … invent a parallel server model"* — and it is the same class `0.14.0` spent its whole release ending for the other three budgets. Two are left, and they are these. **Found 2026-09-18** while bounding something else, and it is the same shape as the `look_ahead_ms` fault: a client constant sized against a server default that is configurable and on the wire.

`ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS` is 8 s and `ALTERNATE_RECOVERY_WINDOW_MS` is 30 s. A node reclaims an idle pipeline at `streaming.pipeline_idle_ms` — **default 60000, configured minimum 10000**, reported live by `GET /api/v1/playback/status` as `pipeline_idle_ms` alongside `idle_pipelines_reclaimed`.

A standby is created, preflighted with one byte fetch, and then **not requested again until it is promoted**. So on a node at the 10 s floor the 30 s window outlives the pipeline by 20 s, and the 8 s window clears it by 2 s. Both numbers were chosen against what a standby costs the node, with no knowledge that the node would take it away.

**What reclamation takes, from the server: the physical pipeline is stopped and the generation directory removed. The session id, its capability and its transcode entitlement survive.** So a reclaimed standby is not obviously dead — and whether a fragment request afterwards revives the pipeline or fails is **not established**. The server has that open and marked open; nobody should treat a reclaimed generation as recoverable until it is answered.

**If it does not revive**, a promoted standby on a short-idle node hands the viewer a generation whose media is gone, which is worse than having no standby at all. **If it does revive**, the windows only cost a cold start on promotion and the present numbers are merely unlucky rather than wrong.

Either way the fix is the same shape as `look_ahead_ms`: read `pipeline_idle_ms` from the node and assert the windows against it, rather than pinning a figure. **Do not hardcode 60 s** — that is the default, not the contract, and the whole class of fault this repository keeps recording is a client believing a default.

**The half core can do without the server**, folded in from what was a separate design entry: assert the windows against the node's figure once it exists, and until then **bound them by the configured floor of 10,000 ms rather than the 60,000 ms default** — correct but wasteful, and wasteful in the direction that costs a standby rather than a viewer. Do not hardcode 60 s: that is the default, not the contract.

**The ask to the server, when the channel reopens** (previously its own entry under *design and contract*):

**Waiting on:** Tom to reopen the server channel, then the server. **Not started, and the server has not been asked.**

Server `0.46.2` reports `startup_timeout_ms` and `segment_timeout_ms` per node, in a `playback` object on the per-node entries of `GET /api/v1/status`. Core reads both and derives every deadline that descends from them. **`pipeline_idle_ms` is a third figure of exactly the same character, it is relevant to core, and it is in the wrong place to be read.**

**What it bounds, and why it is ours.** It is how long a client may hold a generation before first requesting media, after which the node reclaims the physical remux/transcode pipeline. A standby is precisely that: created on another node, deliberately never streamed from, held against a failure that may not come. `ALTERNATE_RECOVERY_WINDOW_MS` holds remux and direct standbys for **30 s**; the default is 60,000 so today there is room, but the configured floor is **10,000**. On a node at or near that floor core would keep a standby it believes is warm for up to 20 s after the pipeline behind it was reclaimed, and find out at the moment of failover — the one moment the standby exists to make fast. `ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS` is 8 s and is safe at any configuration.

**Not a live bug.** Both nodes run the 60,000 default, so nothing is broken on this cluster today. It is the same class as the 12,000-against-15,000 attempt budget: a core constant whose safety depends on a server value core cannot read, which held until someone reconfigured a node.

**Why it is not already done.** It is reported on `GET /api/v1/playback/status`, a per-endpoint route core does not poll. Reading it there means a second per-endpoint request every cycle alongside the health probe, which is the Law 1 cost we deliberately declined when choosing where the other two budgets should live — and it cannot ride on the existing probe, because `probeEndpoint` tolerates a session without `media_viewer` on purpose so a gated node ends up ungraded rather than condemned (`EndpointHealthMonitor.ts:141`).

**The ask, when the channel reopens:** move or copy `pipeline_idle_ms` into the same per-node `playback` object as the other two. It is each node's statement about itself, it moves under `reconfigure()` exactly as they do, and core already reads that payload every 10 s for endpoint discovery and capacity. Zero new requests, and the standby window stops being a guess. If the server prefers to leave it where it is, the fallback is for core to bound `ALTERNATE_RECOVERY_WINDOW_MS` by the configured floor of 10,000 rather than the default — correct but wasteful, since it would shorten every standby on every node to protect against a configuration almost nobody runs.

**Do not close this by tuning the 30 s.** The number is not the fault; reading a figure the node already knows is the fix, and the whole point of the 0.46.2 work was to stop core holding private copies of server configuration.

### A 5 s preflight budget has been throwing away healthy standbys, silently

**Waiting on:** the web client for the budget, core for the window. `PlaybackCoordinator.prepareAlternate`; `WebPlatform.preflightWebHlsSource`. **Found 2026-09-17 while designing something else, and it is in shipping code.**

`prepareAlternate` builds a standby generation on another node and then gates it on `Player.preflightSource`, closing and discarding the session when that returns `false`. The web adapter's preflight fetches real bytes from the first media segment — correct, and the only honest way to know a node will serve it — with **a 5 s budget covering the whole walk**: playlist, init segment and first segment share one `AbortController`.

**A standby is a freshly created transcode generation, so its pipeline is cold**, and the client measured a cold first fragment at **9.0 s**. So the gate has been rejecting nodes that were working perfectly and merely had not finished starting. It reads as "that node could not serve it"; it means "that node had not finished starting yet". Nothing surfaces, because a failed standby is opportunistic by design and is swallowed on purpose.

Two numbers chosen independently and never compared — the fault this file keeps recording. **It compounds with `ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS` at 8 s**: even a standby that passes the gate is closed again before a cold pipeline could have become useful, which is the same product-of-two-budgets shape that `degrade()`'s comment already documents for the 30 s window against a player's retry schedule.

**The client's half is closed, and `0.14.0` closed it better than the item asked.** The client landed `58bb0b0` (5 s -> 25 s); then `0.14.0` made `hlsWalk` derive its deadline from `PlaybackSource.budgets.segmentHoldMs` (`hlsWalk.ts:55`, `:99-104`), so the client copy of `SERVER_STARTUP_TIMEOUT_MS` this paragraph wanted deleted is no longer the mechanism at all. The original account: The node's own `streaming.startup_timeout_ms` is **15,000 ms**, read off a deployed `/etc/macha/macha.yaml`. That is what a node is *entitled* to take, so a 5 s client budget was calling a working node broken for doing what it is allowed to do; 9.0 s is then a measured point comfortably inside the entitlement rather than the basis for the number. Written as a sum, not a figure, and both tests seen red at the old value. `SERVER_STARTUP_TIMEOUT_MS` is now exported from core so that client copy can be deleted — the same one-declaration rule as the two status constants.

**Core's half is open and is now the binding constraint** — re-verified 2026-09-20, `:214` is still `8_000`. `ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS` is 8 s, so a standby that *now correctly passes* a 12 s preflight is still closed before it can be used, and the client's fix does not reach a viewer without this. **Do not raise it to taste — derive it**, which needs facing something the 8 s was set without:

- The window starts when the standby is *ready*, so preflight duration does not eat it. What it has to outlast is the gap between the degradation that **built** the rescue and the second one that **promotes** it, because `promoteReadyAlternate` needs two failures inside the standby's own lifetime.
- Measured on hls.js: non-fatal errors about **every 8 s**, fatal at **~28 s**. So an 8 s window is level with the retry interval it must outlast, and may routinely miss the second failure by a hair.
- Which means the reduction from 30 s to 8 s, made to protect the node's only transcode slot, **may have made the transcode standby path unable to fire at all** — a rescue built, validated, and guaranteed to expire before the evidence that would promote it arrives. That is the same product-of-two-budgets shape `degrade()`'s own comment documents for the 30 s window against a player's retry schedule, which is uncomfortable: the fix for that comment appears to have recreated it one size down.
- **Not yet verified.** It is a reading of two measurements and a code path, not an observation. The cheap check is whether `alternate-promoted-on-degradation` has ever fired against a transcode session in any capture either side holds.

**Do not fold this into the `not-found` work.** It predates it, it affects a path that ships today, and it deserves its own before-and-after.

### The throughput axis may never have ranked anything, anywhere
**Waiting on:** core for one small change, and on the web client for one measurement. **Rewritten 2026-09-20 after reading the code this entry had admitted not reading.**

**Three of the four wiring steps this entry listed were closed by decision 3 in `0.12.0`.** `createMachaServices` calls `wireThroughput` (`createMachaServices.ts:117-123`), which attaches an `EndpointBandwidth` and installs the transfer recorder for every host. A host no longer constructs, passes or records anything for JSON traffic; the only thing it can still forget is `recordTransferByUrl` for media bytes, which has its own entry under *Throughput after `0.12.0`*.

**The reading this entry flagged as unverified was wrong.** It said `evaluatePreferredSwap`'s gates were latency-only, so throughput could never dislodge a sticky endpoint. `EndpointRegistry.ts:787-797` consults `compareThroughput` and admits a `fatterPipe` swap when the candidate's pipe is materially fatter and its latency has not regressed. So throughput *can* dislodge sticky. **What is true and narrower:** a swap needs a latency figure on *both* sides (`:776`, `:785`) and never happens on throughput alone, and a candidate that measurably carries *less* is refused however fast it answers (`:790`). The web client's `decidedBy: { sticky: 155 }` is therefore consistent with the gates being reached and correctly declining, which is what three nodes with one plainly right should look like. Not a defect.

**What survived is now written down.** `EndpointBandwidth.restore()` re-enters a persisted record at `samples: 1` (`EndpointBandwidth.ts:142`) against `THROUGHPUT_MIN_SAMPLES = 2` (`EndpointRegistry.ts:137`), so a restored record never ranks on its own however much history it holds — sound, because a stale reading must not outvote a live link, but "two samples" reads like a low bar and is not one. **BUILT on `develop` 2026-09-20, unreleased:** the `THROUGHPUT_MIN_SAMPLES` docblock now says what actually produces a sample — a body read of 32 KB or more through `readJsonBody`, or a media transfer a host feeds in through `recordTransferByUrl`, and **never the health cycle**, whose probes and status calls are far too small — and that a reload before the session's second large read puts the client back to no axis. `recordTransferByUrl`'s docblock carries the other half: on a client that mostly streams it is the only thing that produces a sample at all. Documentation only; no behaviour changed.

**The cross-client lesson stands and is the reason the entry is kept:** until `0.12.0` the web client wired the full cascade and the phone client wired none of it, so they were ranking on different axes against the same cluster, and every cross-client comparison of *which node each chose* measured their wiring rather than the cluster. Ask what a client wires before comparing what it chose.

### ~~`recordTransferByUrl` attributes by URL~~ — CLOSED, by construction

Raised by the phone client and **closed by it the same day**, on reading rather than waiting for hardware: `MachaPlaybackResolver` builds the stream URL as `${this.baseUrl}${path}`, and `recordTransferByUrl` matches `startsWith(baseUrl + '/')`. The two can only diverge if core changes how it absolutises, which would be a deliberate act. No silent-drop case exists today.

### ~~Core does not check the seek invariant~~ — WRONG ENTRY: the check shipped in `0.14.0`

**Closed 2026-09-20 by reading the file it cites.** The entry said "one half did not [ship]: nothing checks the invariant at runtime". `MachaPlaybackResolver.mapSession` calls `checkSeekInvariant(wire, this.log)` on its first line, the function is at `:247`, and `git show 0.14.0:src/playback/MachaPlaybackResolver.ts` contains it twice — so it is in the released tag, in the published tarball and in `dist`. `seekContract.test.ts` pins both directions: silence on a node too old to state the fields, and a report that does not refuse the generation.

**What it does, since it is the answer to a question a client is currently holding.** A node whose `seek_ms + seek_offset_ms` does not equal `seek_requested_ms` produces one `error`-level client-diagnostics entry, `seek-invariant-violated`, carrying `sessionId`, `mode`, all three figures and `differenceMs`. It is reported and never acted on, and an end-of-title clamp cannot trip it because the server reports the clamped value as `seek_requested_ms`.

**Amended the same day, on the web client's reading of it.** The untestable case used to be silent, which made it indistinguishable in a capture from a check that passed — three readings, two records. A node that does not state `seek_offset_ms` or `seek_requested_ms` now leaves `seek-invariant-not-stated` at **`debug`**, carrying the session, the mode and which field is missing. Debug rather than warn deliberately: that client's failure trail puts warnings and errors on the television screen itself, and an old node in a mixed-version set is ordinary rather than a failure. So a capture taken at `warn` still cannot separate "held" from "could not check" — one taken at `debug` can.

**How this entry came to be wrong is the part worth keeping.** The `0.14.0` seek work was moved to COMPLETED.md wholesale during the 2026-09-19 reconciliation; a later session re-opened the half it could not find evidence for, and re-opened it on the strength of not finding it rather than on looking. That is fault 1 in the list above, in its cheapest form: the whole check is one call on the first line of the function the entry cites by line number.

### Smaller correctness items
**Waiting on:** core, for the one that is left. **Four of five shipped in `0.18.0`** and are in COMPLETED: the README seeding snippet, the emptied bootstrap set, the per-title guard on `ClusterPlaybackFactsApi`, and `envelopeArray` with the `502 invalid_response` classification.

- **`TorrentJob.catalogue` is declared required but version-gated.** `api/AcquisitionApi.ts:72`, "since 0.28.1", and the package supports mixed-version endpoint sets with no runtime check. Make it optional; absent stays absent. **Held deliberately:** widening a required field to optional is a compile break in every consumer that reads it, so it is not internal work and wants to go out with whatever else moves that type, announced rather than discovered.

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


### Core estimates what a generation start costs, and a move starts ahead of the viewer — BUILT on `develop` in `d58375a`, unreleased
**Superseded in part, 2026-09-23: Tom ruled out core's one-byte probe — *"one-byte request - we're not doing this. Talk to server."*** The probe was removed in `38d0524`, and the `readinessFetch` / `noStoreFetch` wiring reverted in `5ca3661`. Core sends nothing to a stream route. **What stays:** the lead on `moveTo`, `holdsThroughLead`, and the evidence store the estimate reads. Nothing feeds that store now, so without a host lead a move asks for no lead.
- **The server has been asked what it can offer** for a node's start cost on a request core already makes; waiting on its answer and Tom's word.
- **The gbni-1 failures were transfer-bound, measured:** the node answered each fragment in 0.1-0.35 s, while the link from the fi-1-site client delivered 0.50 MB/s against a 0.63 MB/s stream. When throughput to a node is below the stream's bitrate, no lead helps, and the move should decline with a reason. Core has per-endpoint throughput and the bitrate, but that decision is only sound if the throughput is media throughput. Asked the web client whether it feeds `recordTransferByUrl`.
- **Throughput is now media throughput on web.** From web client `98f4e3c` it feeds every hls.js fragment to `recordTransferByUrl`; before that, core's gbni-1 figure came from JSON reads. With media, gbni-1 reads about 1.6 MB/s steady against a 0.63 MB/s stream. **But the lost joins happened in the opening:** the first fragments of a cold connection arrived at 0.28-0.57 MB/s. So there are two separate questions:
  - whether a node can sustain a stream — recorded rate against bitrate, now a meaningful decline to build;
  - whether a join can be won — the lead. A lead computed from steady-state throughput would pass and then lose in the opening, so the host's end-to-end lead stays the source for it.
- The notes below are the history that led here.

**The lead is verified live; core's own estimate is not.** Web client `1fcec95` against `d58375a`, 2026-09-23, fi-1 and gbni-1:
- **Unled**, with no evidence on either side: the join lost the race and froze the picture for 15.3 s. gbni-1 measured 19.6 s to a first fragment.
- **Led, host lead 24,614 ms:** the adapter received `-21959`, the lead less the 2.7 s the create took while the viewer played on. The first fragment arrived at +9.0 s, and the cut came at +24.9 s with 27 s buffered ahead of the join. Across 270 samples at 100 ms the shown element never paused, never dropped below readyState 3 and never stopped advancing. The old session was stopped at the cut, and every session answered 404 afterwards.
- **Led the other way, host lead 6,419 ms:** complete 5.9 s after the click.
- **Node CORS allows `Range`** (204 preflight, `Allow-Headers` includes it), so the probe is not blocked on web.

**Core's own estimate did not record on web, and the cause is core's.** In a run with the host lead suppressed, no `generation-start-measured` line appeared. The probe's request was blocked by CORS: core's no-cache headers are not in the nodes' allow-list (`Authorization, Content-Type, If-Match, Range`). Tom kept the probe and asked for the CORS fixed. The fix is `createMachaServices({ readinessFetch: noStoreFetch(fetch) })` for a browser host, unreleased. **Done, and it showed the mechanics are right while the figure is too short.** Web client, `07bd029`, 2026-09-23, no host lead:
- Samples record per node and kind: fi-1 `video-copy` 1,970 ms; gbni-1 4,196 and 4,504 ms.
- The second move into a node reads `leadSource: estimate`, with the lead = longest sample + 5,000 exactly.
- fi-1 at 6,970 ms was seamless. gbni-1 at 9,196 ms lost the race and froze for 15 s, where a 24.6 s host lead on the same move held.

**The probe is not measuring a partial segment.** Checked in the server at `eea4795`: `MediaSegmentStore::publish_segment` (`src/media_segments.cpp:129`) publishes whole segments, and requests are served from that store. So a `206` means the first segment is complete, and 4.2-4.5 s is gbni-1's real time to produce it.

**The gap to the web client's 14-20 s create-to-first-fragment-loaded is most likely transfer. That is inferred, not measured:** fetching segments of a video-copy stream over the link to 10.44.1.50, against a join that needs resident + 5 s ahead. If so, the lead has to be start cost + (bytes the join needs / throughput to that node). Core already holds per-endpoint throughput and the session bitrate. **Waiting on** hls.js per-fragment timings and sizes for one gbni-1 move before the formula changes.

Meanwhile a host lead measured end to end wins wherever the host has one, and that is the reliable figure. A Tizen build shares the web tree, and `cache: 'no-store'` is dropped there, so it needs checking separately. **Also: the one-byte probe for progressive direct play (`9885730`) was rejected by Tom — *"a filthy brittle hack"* — and reverted in `629e89c`.** The television's direct-play fatals still reach core as `unknown` and charge a healthy node. That client is taking what should replace the probe back to Tom.

**Still open:** the first move to a node is unled on both sides, because neither has evidence yet. gbni-1's start varied 9.0 to 20.3 s for one title in one afternoon, which is the case for keeping the longest of the recent samples rather than an average. **Ruled by Tom first-hand on 2026-09-23: core measures, a host may override.** Two peer sessions had relayed his earlier answer two different ways — the server as "core's job", the web client as "the client measures" — and core asked him rather than pick one.

**What was built, and it is a lead rather than a decline.** The web client's analysis, checked and adopted: declining up front only reaches the freeze sooner. The node produces sequentially from where it is asked, at no better than realtime on the slow boxes, so the fix is to ask for the viewer's position plus the start cost. The outgoing source then plays on until the viewer reaches the new generation, and the host cuts there. Core measures each create and relocating PATCH with a `bytes=0-0` readiness probe on the first fragment, keyed per node and per kind, and uses the longest of five samples from the last thirty minutes. `moveTo(endpointId, { leadMs })` takes the host's lead, or that estimate plus `MOVE_LEAD_MARGIN_MS`, but only for a player declaring `holdsThroughLead`. The activation hands such a player a negative position instead of PATCHing the lead away. The notes below are the design as it stood before the build, kept for its reasoning.

**Why it is needed.** The first live moves (web client, fi-1 to gbni-1, 2026-09-23) were correct and still bad for the viewer. gbni-1 took 8.5-12.3 s to produce a first fragment at every new position. The handover raced that join, lost, froze the picture for 15-19 s and fell back to a fresh start. Nothing let anything decline before paying.

**What core has today, checked:** probe round-trip time per endpoint (`recordLatency`), throughput per endpoint (`EndpointBandwidth`), and `production` on a live generation. **Nothing times a generation start.** So there is no evidence to estimate from yet, and the first half of this is recording it.

**Shape, a sketch rather than a decision:**
1. **Measure where core already waits.** Time every create and relocating PATCH per endpoint, from request to a usable first fragment. Take off that endpoint's transport latency, and key the sample on what the start involved: a video re-encode, a copy-video start, or a remux. Those differ by an order of magnitude, and one number per node would describe neither. Hold a small recent window per endpoint, as `EndpointBandwidth` does, and treat stale samples as absent.
2. **Decide with it only on the speculative path.** `moveTo`, and a host's handover through it, compare the estimate for the target against the runway they have. If the join cannot win, they answer `false` with a reason the host can show. This is **optimistic on the viewer's path and pessimistic on the speculative one**, the rule already written for the cap. An absent estimate never blocks anything, and a start the viewer is waiting on is never refused on it.
3. **No constant.** An absent sample means "unknown", never a default. The failure to avoid is the `look_ahead_ms` one: a figure frozen where it should have been re-read.

**Open before building:** whether the host's handover or core's `moveTo` owns the decline (probably core, since the host calls `moveTo`); and what "usable first fragment" means for a create whose response returns before the fragment. That needs reading `MachaPlaybackResolver`'s create path, not assuming it.

### The server can place a torrent download on a chosen node, and core's `submitMagnet` cannot say where a job went
**Waiting on:** the server to deploy and name the version; then core. **Contract reviewed 2026-09-22, feedback sent, nothing built.** Building against an undeployed server would spend a version on a loop.

**What the server built, unreleased.** `POST /api/v1/torrents/jobs` takes an optional `node_id` (32 hex); absent, the job runs on the receiving node as before. The `202` now **always** returns `{ id, node_id }`, including for a local add. `400 bad_request` on a malformed id; `409 placement_failed` when the named node is not an active member or is unreachable — **deliberately never a silent local download instead.** The nodes are not interchangeable: one of the three is a four-core, 4 GB, single-spinning-disk machine, and which node ran a download was previously decided by which address the client happened to be configured with.

**Where it lands here.** `MachaAcquisitionApi.submitMagnet` (`api/MachaAcquisitionApi.ts:65`) reads `IdEnvelope { id }` and returns `Promise<string>`, so today the node a job went to is unknowable from core. The always-returned `node_id` is worth a **hard cut** of that signature to return both; four clients rebuild. Routing needs nothing: `ClusterAcquisitionApi.write()` goes through `ClusterEndpointRouter.mutation()`, which picks `candidates()[0]` and never walks, so the receiving node is already the best-ranked one and forwards from there. **Core never sends `acquisition_ref`, only `magnet`** — said to the server in case that path matters.

**The `409` is already classified correctly, and it is worth saying that rather than leaving it to luck.** `retryableEndpointFailure` returns `false` for a `409`, so `mutation()` neither walks nor calls `recordFailure` on the receiving endpoint. That is the right outcome: the receiving node is healthy — it forwarded and truthfully reported a fact about a *different* node — and charging it would cool a working node for someone else's condition. Same scope distinction `0.18.0` was about.

**Two asks sent to the server, both cheap while unreleased:**
1. **Return `node_id` on the single-job action responses too** — `/{id}/pause|resume|retry|cancel` omit it, which is why `TorrentJob.node_id` is optional here (`api/AcquisitionApi.ts:76-78`). If create always carries it, the actions should, and core drops the optional. A client that just placed a job otherwise loses the node the moment it pauses it.
2. **`placement_failed` needs a machine `code`, the target `node_id` and a viewer-facing `detail` as fields**, not "the reason in the message". A host never parses a message; `playbackFailureCode` and `playbackFailureDetail` exist because clients were string-matching server prose, and a client that matches on wording goes silent the first time it is reworded.

**Two things declined, and the second is against core as much as the server.** No to a name instead of the hex id — core has `nodes[].id`, `host` and `version` off `/api/v1/status` and can render a label itself; a name as the placement key becomes a second identifier that has to be policed for uniqueness and stability. **No to a server-side "best node" option**, because it would be a second ranking on different inputs from core's cascade, and when the two disagree nobody can explain a placement to an operator — **but core's cascade ranks for playback** (availability, sticky, failures, throughput, latency, capacity) and measures neither free disk nor sustained write, and its capacity axis abstains without `cpu_cores`. So core cannot claim to rank downloads today either. **The ask is facts, not a verdict:** per-node free disk on status (`ByteUsage` is already in core at `api/ClusterStatusApi.ts:30-34`), and core ranks and sends an explicit `node_id`. Whoever decides should be able to say why.

**When it ships:** hard-cut `submitMagnet` to return `{ id, nodeId }`, make `TorrentJob.node_id` required if ask 1 lands, and surface the `409`'s stated code and target through the existing accessors. Nothing else moves.

### ~~An unclassified fatal charges a node whose session was simply reaped~~ — BUILT on `develop` in `2bcce57`, unreleased
**Waiting on:** a reap on the Android TV set to confirm `session-regenerated` on the same endpoint with no `source-failover-start` in between. **Tried 2026-09-23 and not exercisable, for a reason that is the server's:** a direct session DELETEd with 204 (and listed on no node afterwards) went on streaming for 8 minutes, including after a seek two minutes past the buffered edge. No fatal ever reached the player, so there was nothing to classify. It is with the server, and matches the earlier report of a deleted macnessa session streaming for 2 min 28 s. Next try: a transcode session. Asked for by that client and approved by Tom, relayed. expo-video's terminal error carries no status, so both of that set's reaps on 2026-09-23 reached core as `unknown`, charged a healthy 10.35.1.50, and failed over across the internet.

An unclassified terminal failure bound for failover now asks `sessionAlive()` first, the same recovery a `not-found` takes:
- gone: regenerate on the same node, nothing charged;
- alive, or no answer: failover and the charge, as before.

The degradation channel is unchanged. **The liveness GET had no timeout at all** — plain host fetch, no signal — which already affected the `not-found` path. It is now bounded at `SESSION_LIVENESS_TIMEOUT_MS`, core's 8 s JSON bound, and a timeout reads as could-not-tell.

**The replacement for the rejected one-byte probe, `probeSourceReadiness`, is this.** It asks the session API instead of the stream.

### ~~Previous and next episode, across season boundaries~~ — BUILT on `develop` in `8dd1fcf`, unreleased
Tom's business P0, asked for by the Android TV client: every episode shows previous and next in the player, and back navigation goes episode → season → series → TV Shows. `episodeNeighbours(api, episode, signal)` works out the neighbours from `details()` alone, crossing seasons and stepping over empty ones. It returns the show and season for the back stack. **Specials (season 0) are a chain of their own**, core's call and stated to the client. It never throws for a broken hierarchy. **Verified on the Android TV set 2026-09-23 against `3f77ef4`**:
- Resumed from Continue Watching (Bushwhacked S01E02): both neighbours present, and Next went to S01E03.
- From the season page, S01E01: previous greyed, next present.
- Back walked season → series → TV Shows from the returned show and season, with no errors.

**Waiting on:** the web client, which has nothing like it and will want it.

### ~~A player that cannot ride a hold needed a media probe~~ — BUILT on `develop` in `3e611b8`, unreleased
Tom ruled zero-byte checks out, the web client's own included. **The standby preflight's `bytes=0-65535` read stays** — Tom: *"it is reasonable to request initial media from a node you're about to failover to."* The web client's native-HLS path (Samsung) waited for a `bytes=0-0` 206 on the first segment before handing over a source. That wait is replaced by the node's own statement: `production.produced_ms > 0` on the session route. **Checked in the server at `eea4795`:** `produced_media` advances only in `publish_segment`, which publishes whole segments with init first, and create, PATCH and GET all carry `production` through `session_json`.
- A player declaring `needsProducedSource` gets a transcode or remux source only once `awaitProduced` says so: reads every `PRODUCED_POLL_INTERVAL_MS` (500 ms, client policy documented as a guess), each bounded at 8 s, the whole wait bounded by the node's attempt budget.
- No production reading means hand over as before. A 404 means not-found and the reaped-session recovery.

**Waiting on:** the web client to declare it on the native path, delete `probeFirstFragment`, and show a Samsung start.

### Continue Watching owns the store but not the cadence
**Waiting on:** core. **Has a consumer waiting with an implementation to delete, not a speculative ask.**

Core owns `ContinueWatchingStore` and `progressFor()` (`state/continueWatching.ts:35,39`). **Nothing owns when to call them.** So each client invents a write policy, and the Android TV client has now written one it wants to delete in favour of core's.

**The incident, which is the reason this is P1 rather than a nicety.** On 2026-09-22 at 20:42:15 a TCL at 10.35.1.133 replaced Android System WebView and force-stopped the TV client while it was in the foreground — `Killing 3554:foundation.macha.client.tv/u0a96 (adj 0): stop com.google.android.webview due to installPackageLI`. `ApplicationExitInfo` records it as `reason=10` (USER REQUESTED); all 16 recorded exits for the package are that reason and **none is a crash**. A kill of that shape runs no teardown — no stop, no unmount, no final write. The TV client wrote progress only on deliberate exit, so a viewer killed an hour into a film resumed from wherever they last pressed Back, which on a first viewing is the beginning.

**The rule, as the TV client states it** — dependency-free, two booleans, a duration and a clock, which is why it belongs here:

    progressWriteDue(
      previous: { paused: boolean; wroteAtMs: number },
      current: { paused: boolean; durationMs: number } | undefined,
      nowMs: number,
      intervalMs: number,
    ): 'paused' | 'interval' | undefined

- no playback (`undefined`) → no write. The clean stop; writing stamps a position after the viewer has left.
- `durationMs <= 0` → no write. The fraction is meaningless and renders as an entry with no position.
- playing → paused, **the edge and not the state** → `'paused'`. Held paused it must not rewrite: the position is not advancing and the RN stores are AsyncStorage-backed, so it is pure churn.
- playing and `nowMs - wroteAtMs >= intervalMs` → `'interval'`. The interval does **not** run while paused.

**Hosts keep the timer, the playback subscription, and where the writer lives.** The TV client's sits at app scope rather than the player screen's, because a screen that unmounts on Back stops writing exactly when there is still something to record. That part is platform and stays with the client.

**Do not adopt the calibration that came with it.** The TV client chose its 5-minute interval by pinning it to `SERVER_SESSION_IDLE_MS` "as a relationship, not a number", reasoning that the kill which orphans a session on the node is the kill which strands the resume point on the device. **The constant checks out — `streamProtocol.ts:68` is `1_800_000` — and the inference from it is still wrong, twice over.**

1. **It re-creates a dependency core deliberately deleted.** The doc on that constant says it: it is *the server's default*, each node states its own `session_idle_ms` on `/api/v1/status`, **core does not read it on purpose** — *"nothing here should be timing against a session's erasure, and the dependency that did was deleted rather than re-pointed at the wire"* — and *"treat it as a ceiling to stay well under rather than a number to match, and never let correctness depend on it."* The 30 minutes was measured once, on fi-1 on 2026-09-17, off `/etc/macha/macha.yaml:176` running the default. **A default is not a contract**, and this is the fault class recorded at `ACCOUNT_SCOPED_FAILURE_CODES` in `cluster/endpointFailure.ts`: a client sized itself against `look_ahead_ms`'s default of 8 segments where the node was configured for 4, and sat refused at the frontier for a 12.7 s viewer freeze.
2. **The relationship does no work even where the number is right.** What bounds the viewer's loss is `intervalMs` alone: an unannounced kill lands whenever it lands, and the stored position is stale by at most one interval whether the node reaps at thirty minutes, at five, or never. Session reaping is the *node* reclaiming a transcode slot; the write cadence is *the device* surviving a process kill. The TV client's incident shares a trigger with reaping, not a mechanism. Tie the interval to what it actually bounds — how much progress a viewer may lose — and 5 minutes is then Tom's call on that question, which is the right question. Deriving it from session idle means a node configured to reap sooner silently argues for more AsyncStorage churn that buys nothing.

**Unverified, and flagged as the TV client flagged it:** it believes the phone and web clients have the same exposure to an unannounced kill and has **not** read either tree. Ask each client rather than assuming — the two RN trees are separate codebases.

**When this lands, say so on the thread and name the version.** The TV client has recorded at the declaration in its `src/player/progressPersistence.ts` and in its own `TODO/ACTIVE.md` that the local copy is to be removed when core publishes this; two implementations of this rule drifting across four clients is the thing to avoid.

---

## P2

### Probe a standby before promoting it
**Waiting on:** core.

Specified, not built. `GET /api/v1/playback/sessions/{id}` returns `engine_running` and `segments_ready` **only when an engine is present**, so their absence is the "reclaimed, needs a cold start" signal — one cheap round trip, and the same GET renews the 30-minute session timer without touching the 60 s pipeline clock. Promotion should expect a cold start rather than counting the promotion as failed.

---

## Throughput after `0.12.0`: what is settled and what is not

**Three clients returned GO on the `0.12.0` refactor.** Two things they surfaced are not closed by it and should not be lost.

### Persistence may never engage on either React Native client — and "nearly free" is an inference, not a measurement

`macha-client-id` is written by exactly one thing: `MachaClientConfiguration.clientId()`. **Neither RN client calls it** — both key their own identity elsewhere — and `0.12.0` deliberately reads that key without ever minting it. So `existingClientId()` may answer `undefined` on those platforms indefinitely, and throughput lives in memory per session and never persists.

What persistence actually buys is **one** live sample instead of two, because `restore()` re-enters a record at `samples: 1` against a `THROUGHPUT_MIN_SAMPLES` of 2. So the thing that makes the axis work is not persistence at all — it is that `0.12.0` records core's own JSON reads, which nothing did before. Every read over `MIN_SAMPLE_BYTES` (32 KB) counts.

**Whether that closes the gap is unmeasured, and the phone client was right to stop me repeating "nearly free" on a structural argument.** Its catalogue calls are unpaginated — `movies()`, `shows()`, `artists()`, `albums()`, `tracks()`, `search()` take only an `AbortSignal` and return whole collections — so on a populated library those responses are very likely well over 32 KB. *Very likely* is an inference, and this project has a bad record with those. **State it as: it depends on catalogue size, it is measured for nobody, and on a client whose only other evidence is downloads it engages late or never if the reads come in small.**

**The Android TV client argues the gap costs it nothing, and the shape is worth keeping:** a television session is a burst of catalogue traffic — Home, Library, a detail page — then one long title during which almost nothing is fetched. Two samples accumulate in the first seconds of browsing, well before any playback decision needs ranking, and the axis then stops gaining evidence. Not persisting across launches costs the first few seconds of each session, which is exactly when nothing is playing. **Both RN clients independently oppose reintroducing minting to buy the one sample.**

**MEASURED 2026-09-15 by the web client, against a live node.** `Content-Length` was present and exact on every response — none chunked — which matters more than the sizes, because `readJsonBody` only records when the declared length is finite and positive. On this server every read is recordable.

| Route | `Content-Length` | vs 32 KB floor |
|---|---|---|
| `/api/v1/catalogue/items?type=movie` | 416,241 | **clears** |
| `/api/v1/catalogue/items?type=show` | 66,911 | **clears** |
| `/api/v1/status` | 5,682 | below |
| `/api/v1/catalogue/status` | 303 | below |

**The finding is not the sizes, it is what clears the floor and what does not.** Catalogue reads do; **the background health cycle does not**. That ten-second probe is the one piece of traffic that runs whether anyone is watching or not, and it contributes no throughput evidence at all. So "two samples per endpoint" means **two catalogue reads per endpoint** — not two of anything.

Three consequences, and none of them is a defect to fix. `MIN_SAMPLE_BYTES` is right: a 303-byte response measures latency wearing a throughput costume, which is the confusion `MachaHost.now()` already carries three warnings about.

1. **Throughput is browse-driven.** The axis gains evidence when a viewer lists a library and at no other time.
2. **A cold client ranks on latency until the viewer browses** — and endpoint ranking matters most exactly then, before anything is sticky. "Two transfers" sounds like it happens on its own; it does not.
3. **A client that opens straight into a player and never lists a library gets no JSON evidence whatsoever**, and the host media feed becomes the only source. That is a stronger argument for `recordTransferByUrl` than the one made at GO, and it bears directly on the Android TV client having none — its model of browse-then-play is what saves it, and a deep link or a resume-on-launch would bypass exactly that.

**Do not conflate the two reasons an axis decides nothing.** The same client measured 155 probe cycles all `decidedBy: sticky` with no swaps: there, throughput had evidence and was never consulted, because the preference never came up for reconsideration. Evidence-absent and never-consulted are different states and this backlog has treated them as one.

### RETRACTED: the cold-start offline flip was never observed

**Retracted 2026-09-16 by the client that reported it, on hardware.** It built the A85 twice — once with the `SessionNotStartedError` branch, once with it deliberately removed — cold-started both against the live WAN cluster, and **both showed the full library**. No offline notice, no downloads-only view, no connectivity transition in the logs.

So the harm this file carried — a healthy cluster marked offline on every launch, requests withheld for twenty seconds, a viewer served downloads instead of their library — **is not supported by hardware and nobody has seen it**. Its own reading of why: even if the window is entered, the next successful request calls `reportReachable()` and clears the flag before anything depends on it; the suppression needs the offline state to persist and it does not.

**What survives is narrower and still worth having:** without the branch, `serve` classifies the error as a transport failure and calls `reportUnreachable()`, which its unit test proves. That is correctness. It is not a fix for a measured regression, and `SessionNotStartedError extending MachaConnectionError` should be weighed on its own merits — giving hosts a sane default — rather than on a harm that was never observed.

**I had told Tom this was the only viewer-visible harm anyone traced in the release.** It was traced in code and never in the world. That is the fourth correction today to something recorded here as evidence, and the second where hardware contradicted a reading of the source.

### On-device findings from the A85, `0.12.0`

- **`throughput-unavailable` fires at 211 ms on every launch**, with `reason: 'insufficient-samples'`. Decision 3's abstention half verified from outside on real hardware — and the reason code also proves a bandwidth store *is* attached, since `no-bandwidth-store` is the other branch. That client hand-builds services and never calls `createMachaServices`, so it wired `attachBandwidth` directly, which was the choice it was offered.
- **Catalogue sizes measured independently against the 32,768 B floor**, and one number matters more than the rest: movie 416,241 · track 849,912 · album 240,298 · show 66,911 · **artist 42,517** · `/api/v1/status` 5,395 · `catalogue/status` 300 · `health` 52. **Artist is 1.3× the floor.** A smaller library puts that listing *under* it, and it stops being throughput evidence entirely. "Browse-driven" therefore has a library-size dependency that neither measurement had exposed.
- **Server note:** the query parameter is `type`, not `kind`. A wrong one is ignored and returns the entire 2.9 MB catalogue.
- **Four seconds of cold start are spent on a dead node.** Seven route attempts to `macnessa` between 213 ms and 230 ms, then silence until 4,231 ms when the walk gives up and reaches `ramaroja`. That is the real startup cost on this cluster and it is nothing to do with this release — but it is the cooldown-ladder item in the low register, measured.
- **Unexplained, claimed by nobody:** between two runs the device went from a named signed-in account to anonymous, Continue Watching and downloads intact. It has the shape of the 30-day expiry item; nothing confirms it.
- **Observability correction, theirs:** `ReactNativeJS` logs reach `logcat` from a **release** build, so core's routing, health and registry logs are readable live without a debug build or a new UI surface. That client had told me otherwise and corrected it.

### "Two samples" is not a low bar, and that is why `sticky` won 155 times

**Demonstrated against the published `0.12.0` build, not reasoned about.** A record persisted with `samples: 9` restores as `samples: 1` (`EndpointBandwidth.js:133`) against a `THROUGHPUT_MIN_SAMPLES` of 2, so `bytesPerSecond` answers `undefined` and the endpoint **cannot rank**. One live sample later it ranks. Persistence therefore buys exactly one sample's head start and nothing else — it never ranks alone, however much history it holds.

**Put that beside the `content-length` measurement and the consequence is sharper than either fact.** The only things that produce a live sample are a catalogue read over 32 KB or a host media feed; the ten-second health cycle is far below the floor and produces none. So:

- **A browse-first client ranks after one catalogue read** — persistence supplying the other sample.
- **A player-first client with no media feed never ranks at all.** Not late: never.

**This is the mechanism behind `decidedBy: { sticky: 155 }`.** The web client wired throughput completely, held persisted records for all three nodes, and ran 26 minutes including playback — and throughput was **never eligible to rank**, rather than having been consulted and lost. Those are different states and this backlog conflated them until today.

**The web client is not proposing a fix and neither am I.** Restore-at-one presumably exists so a stale record cannot outvote a live one, which is sound. The defect is in what the numbers *look* like: "two samples" reads like a low bar and is not one. **The docs must say what actually produces a sample.** That is the third time today a small number in isolation has looked harmless — the others being the 32 KB floor and the 40% relative-difference gate.

### Forgetting `recordTransferByUrl` is invisible, and core could make it visible

It is now the only throughput wiring a host can forget, and forgetting it means ranking on JSON alone — the fault that had the web client streaming from its slowest node for an afternoon. That is the same property that let the third constructor argument go unpassed in two clients for months.

**The phone client's suggestion, which it explicitly did not ask for:** core could record whether *any* host-fed transfer has ever reached a registry, and say so in the abstention reason — so a client can assert it in a smoke test rather than trusting a docblock. Not in `0.12.0`; it is a core change and would have cost a fourth go/no-go round on a release that already had three GOs.

**What that deferred doc must say, gathered from asking:**

- **The obvious wiring is the wrong one.** The Android TV client's `PlayerEngine.kt` attaches a media3 `TransferListener` whose `onBytesTransferred` fires **per chunk**, not per transfer. Calling `recordTransferByUrl` from it would cross the JS bridge hundreds of times per segment on a device whose CPU is the scarcest thing in the building, and would feed chunk-rate noise rather than a transfer measurement. **Accumulate between `onTransferStart` and `onTransferEnd`, emit once.** `EndpointBandwidth.record` already discards anything under `MIN_SAMPLE_BYTES`, so chunk-sized samples would mostly be dropped — silently, after paying the bridge cost.
- The `durationMs` must cover reading the body, not receiving headers — the same rule `readJsonBody` follows, and for the same reason.

**Who will actually call it, asked rather than assumed:**

- **Phone client: yes**, from `DownloadManager`, and structurally hard to lose there — a tested `throughputSample` module and a named `recordThroughput` method, so removing it orphans a test and leaves an unused import.
- **Android TV: no, and not through inattention.** Its live player is `expo-video`, which builds its own `OkHttpDataSource.Factory` with **no injection point** — the same fact that blocked reinstating the `500 segment_not_ready` retry and forced `awaitFirstFragment` out-of-band. Its *other* adapter, `ExoPlayerAdapter`, already has the listener attached with `onBytesTransferred` and `onTransferEnd` stubbed to `Unit`: the evidence arrives at a callback and is discarded. A small addition if that adapter ever goes live.
- **Web client: yes**, the Direct Play read-ahead worker, which is the only media-byte evidence any client has today.

**The web client's point stands alongside it and is the cheaper half:** the doc is not what prevents this, asking each client directly is. Both RN clients were asked and both answered — the phone client committed to the call and named why it is structurally hard to lose there (a tested `throughputSample` module and a named `recordThroughput` method, so removal orphans a test and leaves an unused import).

---

## Coverage: what is done and what is left

**Measured 2026-09-15, not estimated.** `npm run test:coverage` prints the table; `coverage/coverage-summary.json` has the per-file numbers.

| | 2026-09-13 (600) | before the pass (720) | after it (786) | 2026-09-20 (897) | 2026-09-20 (939) |
|---|---|---|---|---|---|
| Statements | 93.4% | 92.1% | 93.94% | 94.12% | **94.99%** |
| Branches | 84.4% | 84.39% | 85.39% | 85.66% | **86.45%** |
| Functions | — | 88.16% | 91.56% | 92.01% | **93.12%** |

Note the middle column: between 600 and 720 tests statements fell 1.3 points. Tests were added and coverage went *down*, because what landed in `0.10.0` and `0.11.0` was covered below the existing average. Worth re-measuring after a release rather than assuming a rising number.

### Done — the cheap half

Each of these guards a rule that had already failed once somewhere, and none needed new harness:

- **`storageKeys.ts` 0% → 100%.** The test drives every persisting component against a recording `StorageLike` and asserts every key touched satisfies `isMachaStorageKey`, rather than comparing the registry against a copy of itself. It went red on its first run: **`macha-client-progress:` — the legacy Continue Watching key, read on every cold start and deliberately never deleted — was not in the registry**, so a host clearing Macha's data through `isMachaStorageKey` left it behind. Now listed. **Add a component to `driveEveryPersistingComponent` when you add one that persists**; the assertion cannot know about a store nobody drove.
- **`ClusterUsersApi` 65.5% → 100%** (functions 14.28% → 92.85%). Released in `0.14.0`; the P2 entry it used to point at has moved to COMPLETED.md.
- **`MachaUsersApi` 65.1% → 100%.** Only `list` was covered; the eight other methods, the 401-vs-403 split, and the "send only the fields the caller set" rule on `update` now are.
- **`SessionAuth` 74.8% → 93.9%.** The revoke path had no tests at all: 401/403 as already-revoked, a refusal being terminal rather than walked, transport failover, and the empty-registry message that must not read as "cluster unreachable".
- **`ClientLog` 87.4% → 100%.** Level filtering, the ring buffer and its 100-entry floor, `Error` unpacking, nested and in-array redaction, the depth limit, and `clientDiagnosticsConsole()`. The Android TV failure trail runs through this.
- **`errors.ts` 55.6% → 100%.** `abortError()`'s fallback branch — the one that *only* runs on React Native and therefore never ran in a Node suite — is now exercised by stubbing `DOMException` away.
- **`PlaybackRuntime` 86.4% → 90.2%.** The parts that did not need a scenario: capability re-probe after a failed probe, `dispose()` closing the session, the host wait, and a throwing transition not poisoning the queue.

### Left — and it is mostly one place

**Re-measured 2026-09-20 at 935 tests.** `PlaybackCoordinator` is 92.35% statements / 80.76% branches — it has risen through two releases that added several hundred lines to it, so the new code is now arriving *above* the file's own average rather than at it. `PlaybackRuntime` was the laggard and is not any more (see below): 94.41% / 79.23% / **100% functions**. `ClusterPlaybackResolver` was the lowest branch figure of any file this backlog named, at 77.57%; **it is now 82.14% / 95.92% statements**, and what was uncovered there was the whole of teardown-that-will-not-close — the layer two of the four clients use *directly*, without a coordinator, so a gap there was a gap nothing else covered for them. Four tests, each verified red against its own line: `stop()` charging a refusing node exactly once and naming which node it was; `endpointAlreadyCharged` suppressing the second charge and dropping the map entry *before* the attempt rather than on success; the five-rung close ladder giving up rather than holding a timer for the life of the process; and a standby that came back as a different mode being closed rather than offered. The ladder had never been run at all — it is the mechanism keeping a dead node's transcode slot from being held until `session_idle` reclaims it half an hour later. Those three are **most of what remains uncovered**. ACTIVE.md has always said these need scenarios rather than assertions, and that is still true of what is left.

**The leverage: several of those scenarios are the P1 fixes.** Build the scenario and the fix together so the test is seen red — a test written against today's behaviour would pin the bug.

| Scenario to build | Item it closes |
|---|---|
| Storage write throws during the health cycle | P1 — the loop dies silently; `probeNow()` shares it |
| `setBootstrapEndpoints([])` then restart | P1 — permanently unconfigured after a "clear" |
| 200 with an HTML body / JSON missing `items` | P1 — `SyntaxError` to the viewer, node cooled for a schema mismatch |
| A per-title fault on a facts read | P1 — `ClusterPlaybackFactsApi` demotes a node for one bad extent |
| Degrade during failover; `close()` with a failover in flight | Low register — coordinator `1134-1140`, `698-718` |

**~~What is blocking that work: there are three `FakePlayer` implementations.~~ MERGED, shipped in `0.18.0`.** There is now one, `src/testing/FakePlayer.ts`, and both local copies are gone. The header records what the split cost — a round of "prove the test fails against the broken code" that ran green every time because the code it was meant to break was never the code under test, and a good test deleted on the strength of it.

**The two divergences the merge had to settle, neither of which any test named.** The runtime's copy recorded `play()` as a bare `PlaybackSource`, so its assertions could not see the position, the start-paused flag or the transition; nothing asserted on those, so the shared shape absorbed it with no test change. The other is a real behaviour difference: the runtime's `detach()` also stopped, the other two only counted. **Settled in favour of the interface** — `Player.detach` is documented as *"Final player destruction. This is resource-destructive."*, so a double whose `detach()` only counts lets a test pass where the real player would have torn the source down. The coordinator never calls `detach` (it deliberately leaves host ownership to `PlaybackRuntime`), so nothing there moved.

**Note for the release:** `FakePlayer` ships publicly on the `./testing` export, so `detach()` now stopping is a visible change to a test double a client may be asserting against. It is a fix, not a widening, and it belongs in the release note rather than in a client's surprise.

917 tests, typecheck and `lint:platform` clean.

**Four of the five scenarios in the table above were built today**, each alongside the fix it pins, each seen red against the unfixed code: the health-cycle storage write, `setBootstrapEndpoints([])`, the HTML-200 and missing-`items` pair, and the per-title fault on a facts read.

**The fifth is now built too, and it produced a finding rather than just a number.** A dead source goes on talking while its replacement is negotiated — the element drains, reports `ended` short of duration, and `onPlayerEvent` sends that back as a second fatal one to three seconds after the first. Two tests: one for an in-flight failover, one for an in-flight regeneration. The regeneration guard is load-bearing and the test is red without it. **The failover one is not.** `failNow` returns early on `failoverPromise`, and `beginSourceFailover` independently refuses to start a second failover — and **the entire 935-test suite passes with the `failNow` branch removed**, so on current code it is shadowed for every input any test can construct. Both are kept: they are different intents (drop a dying source's noise; keep recovery single) that happen to coincide, and the `failNow` comment records a measured 82-second viewer loss. But the test says so rather than claiming to pin a line it does not. **Do not remove `beginSourceFailover`'s guard on the strength of `failNow` having one.**

**`PlaybackRuntime` is no longer the laggard.** The surface a viewer still has *after* a generation has failed had no coverage at all — `seek`, `seekBy`, the bound on a nonsense scrub, and the scrub-then-retry chain a viewer actually takes out of a failure screen. Nine tests later: statements 90.15% → **94.41%**, branches 72.80% → **79.23%**, functions 86.11% → **100%**. Each was verified red against the specific line it pins, and two of them were re-checked after a first version passed for the wrong reason. Also pinned: immediate delivery to a new subscriber (a subscription that only fires on the next change leaves a host blank on an idle runtime), `getPlaybackSnapshot` handing out a copy a host may keep and mutate, a resolver installed after construction, and `setVolume` forwarding a level and holding none — the half of the distinction whose docblock records two occasions when applying a level was confused with persisting one.

### Not worth chasing

- **`checkPlatformSurface`, 51.9% branches.** Those branches are "what this platform lacks", and on Node everything is present. Faking absence per branch tests the mock, not the truth. The honest answer is the Android TV hardware run already tracked under *Watching, not doing*.
- **The coverage-excluded barrels and type files.** `vitest.config.ts` excludes them deliberately and the reasoning there holds.
- **The number itself.** The point of the pass above is that seven specific silent failures became loud, not that a percentage moved.

---

## Proposed: one storage key convention

**Waiting on Tom**, who asked for keys that are standard across every implementation and platform. Designed with the Android TV client; **not started, and it must not start out of order — see the sequencing constraint, which is the whole of the risk.**

**The target:** everything core owns takes the dotted `macha.<name>.v<n>` form. Core's own header already calls the two conventions *"a defect rather than a design"* and says new keys take the dotted shape; this finishes it.

**The remaining set is six keys and two prefixes** — `macha-client-id`, `macha-server-url`, `macha-server-endpoints-v1`, `macha-bootstrap-endpoints-v1`, `macha-discovered-endpoints-v1`, `macha-storage-probe`, plus `macha-client-bandwidth:` and `macha-client-progress:`.

### Only two of the four `macha` spellings are storage

Verified in core rather than assumed, because a rename sweeping the wrong ones would be a wire-format change wearing a tidy-up's clothes:

- `macha:server-unreachable` / `macha:server-reachable` (`api/serverConnection.ts:4-5`) are **event names**.
- `macha_version` (`api/MachaServerApi.ts:49`) is a **server JSON field**, read alongside `server_version` and `version`.

Neither is a storage key. Neither goes anywhere near this. It is a two-convention problem, not a four-convention one.

### Migrate on read, never on write, and keep the old key readable for at least one release

There is precedent in core's own tree: `MachaClientConfiguration.bootstrapEndpoints()` already reads `macha-server-url` and the interim endpoints key, adopts them, and removes them — at read time, so no caller has to remember a migration step. Same shape as `ContinueWatchingStore.read()`.

### The sequencing constraint — and getting this wrong destroys the data the work exists to preserve

**Hosts widen their filter → core migrates → hosts may narrow again, if ever.**

A read-time migration asks a caching host for a legacy key. A host that did not hydrate that key answers `null`, and core **cannot tell that from the key being absent** — so the migration concludes there is nothing to carry across and quietly drops it. **If core standardises before the React Native clients have widened, the standardisation silently discards exactly the data it was written to preserve.**

The web client will not show this: `localStorage` is synchronous and reads through, so its migrations will appear to work perfectly while both React Native clients lose everything. **A green web client is not evidence here.**

Both RN clients have now widened — the phone client by accident of `macha-`, the Android TV client as of today and deliberately, driven by core's exported constants. So the precondition is met for those two. The Tizen build shares the web client. **Confirm all four before starting, not three.**

The Android TV client notes it would not narrow its filter again afterwards: the cost is a few unused map entries, and the failure it prevents is silent.

### Why this is worth doing rather than living with

Two conventions have now produced the same incident on three clients — the phone client's session written-and-never-read, and the Android TV client's client id re-minted on every cold start, which orphaned four stores that were themselves keyed correctly. Core named the conventions in `0.10.0` but did not converge them, and naming alone did not stop the second occurrence.

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

## Verification outstanding — the `0.13.0` deferral has never reached a swap on a real node

**It has now: verified live on 2026-09-23 by the web client, against core `0ac8f21`, fi-1 on server 0.53 with `session_idle` at 30 min, transcode HLS.** A 34.7-minute pause with 127 s buffered; nothing touched the session while paused.
- **Resume:** the picture played on from the buffer at once. The first fragment 404 came 9.1 s later: `session-gone`, `source-reaped`, and a replacement deferred at `runwayMs 119892` against `leadTimeMs 26000`.
- **The adapter's fatal 31 s later** was absorbed as `source-failure-superseded-by-replacement`. No failure screen.
- **At `lead-time-reached`** (`runwayMs 25939`), core regenerated **on the same node**. The session was created in 1.6 s, the web handover completed in 1.28 s, and the cut went from 157.5 s on the old element to 2.8 s on the new, 100 ms apart, `readyState 4` throughout.
- **No stall** in 1,257 visible samples.

That closes *Re-verify the stall is gone* below. **Two caveats from the run:**
- The tab was hidden from the resume click until 20:02:31, so the resume and the first 404 happened in a background tab; the rebuild and the cut were foregrounded.
- At 19:40:31, mid-pause, routing logged `route-endpoint-failed` for fi-1 as unreachable, with no visible consequence. **Unexplained.** A throttled timer in a background tab expiring a request is one candidate, not a finding.


**Core's half is complete and released in `0.13.0`, and the shipped account is in [COMPLETED.md](COMPLETED.md).** What is left here is verification nobody has been able to run and one cross-repo half: the web client's `fail-not-found` teardown change and the three-arm comparison. Neither is core's and neither blocks anyone else — see *Still to do* at the end of this section, which is the only part that is actually outstanding.

**The account below is kept in full even though it is now duplicated**, because the shape changed three times and each change was forced by a measurement rather than an argument. COMPLETED.md has the release-shaped telling; this is the working one, and the open items reference it.

**Built and verified live on `develop` 2026-09-17; shipped in `0.13.0`.** Found by the web client, reproduced live twice, fixed in core and in that client together.

**What happens.** `streaming.session_idle_ms` is thirty minutes and erases any session whose client has stopped asking for media. A paused client is exactly that: hls.js fills its bounded forward buffer, hits `maxBufferLength` and stops requesting, so the session survives about a minute of pause and then the reaper's clock runs unopposed. **A pause longer than the budget is a certainty, not a risk.** The viewer comes back, their cache plays out, and they get a failure screen.

**The three defects, and only the middle one was load-bearing.**

1. Nothing revalidated the session across a pause. `0.17.1` was right that a pause must not be judged as a stall; it gave the resume nothing to check.
2. **A `404` on a playback route was read as a bad node.** `playbackFailureKindForStatus(404)` returned `stream`, `stream` is endpoint evidence, so `failover()` ran — and its first act is `recordEndpointFailure`. A node that had merely forgotten one session was charged for answering honestly and dropped from the candidate list. This is what turned a recoverable condition into a terminal one.
3. The walk then reported **the last endpoint it tried** rather than the one that failed. Measured: the session was on es-1, the screen read `Macha endpoint http://10.35.1.50:7438 failed: Failed to fetch`, which is fi-1 — a node that had never held the session. **A day of diagnosis went to the wrong machine on the strength of that line.**

**What core does now.**

- `PlaybackFailureKind` gains **`not-found`**, which is not endpoint evidence. Named for what the node said rather than what it means, because the adapter genuinely cannot know: measured on one node in one run, a reaped session and a fragment past the end of a live plan both answer `404` with the identical code `not_found`, differing only in one word of English in a message the fragment loader never sees. **Classification has to be on the status, and the status is ambiguous.**
- `PlaybackResolver.sessionAlive()` resolves the ambiguity by asking the owning node whether the session exists — pinned, recording nothing either way. A `404` is the answer; anything else throws, because *"I could not find out"* is not *"it is gone"*.
- `PlaybackResolver.regenerate()` replaces the generation **on the same node**, releasing the old session first and waiting for it, because on a one-slot node the session being replaced holds the slot the replacement needs. It lives on the resolver rather than only in the coordinator, so the phone client gets it.
- The coordinator branches on `not-found` in **`degrade()` before the endpoint-evidence guard**, which is where the real prize turned out to be — see below — and in `failNow()` for adapters with no degradation channel. Bounded: a second `not-found` at the same position means the regeneration changed nothing and the next step must differ.
- The terminal error leads with the failure that started the recovery and keeps the walk's last refusal as its `cause`.
- `SERVER_SESSION_IDLE_MS`, `SEGMENT_NOT_READY_STATUS`, `BROKEN_GENERATION_STATUS` and `SOURCE_NOT_FOUND_STATUS` are exported, beside `SERVER_SEGMENT_HOLD_MS`.

**The measurement that changed the design, and it is the good part.** The client expected ~32 s of buffered cover to recover inside. What it actually measured is better: hls.js topping up its buffer *during the pause* hit the reaped session and reported the first `404` **3.7 seconds before the viewer pressed play**, with 62.8 s of buffer still ahead of them — on the degradation channel, which core already had. Core was being told, on the right channel, at the right moment, and was doing the wrong thing with it: `alternate-preparation-start`, a standby on a different node, because the kind said `stream`. **Recovery inside that cover is invisible to the viewer**, and the resume-time probe that was originally proposed is now only a latency optimisation sitting behind it.

**It must not be a keepalive, and this is the trap.** The transcode entitlement is held by the session rather than the pipeline, so polling to hold a paused session open pins the node's only video transcode slot for as long as the tab is open. The reaping is correct behaviour. What core owes is to notice on the way back.

**Verified live, 2026-09-17, against `es-1` (10.34.1.50).** The web client ran it through a `file:` link to this tree and unlinked afterwards. Deliberately against the node directly rather than through `ramaroja`, so haproxy and the mixed-scheme item could not colour the result. Paused at content position 222 s with 62.1 s of cover; session deleted on the node; resumed.

`session-reaped-regenerating` and `session-regenerated` both carry `endpoint.id: http://10.34.1.50:7438` — the same node, which is the whole claim. Across the capture: `alternate-preparation-start` 0, `source-failover-start` 0, `generation-exclusion-relaxed` 0, `session-liveness-unknown` 0, `source-not-found-on-live-session` 0, `session-regeneration-made-no-progress` 0. First 404 to new session created: **3.44 s**. Position preserved: regenerated at 222093 ms, on-screen clock ran 3:42 → 4:52 continuously.

**Two notes from the run worth keeping.** The client nearly reported a position regression and checked first: raw `currentTime` read 13 after the swap against 51.9 before it, which is the MSE clock being generation-local, not a lost position. And the title direct-plays in Chrome on macOS — reaching this code at all needed transcode asked for explicitly, so **the original report's episode does not exercise this path by default on that host.**

### The 5.2 second stall, and it is the one thing still wrong

**Found by the client in the same run, and it is core's.** At `source-activate` the element still held cover from 51.9 to 114.1 with the viewer at ~52 — about a minute of playable video. Activation hands hls.js a new MediaSource, the element empties, and the viewer gets a spinner:

```
17:16:37.560  source-activate
17:16:37.580  media-emptied
17:16:37.581  media-waiting
17:16:42.739  media-playing     <- 5.16 s
```

The 3.44 s spent probing and regenerating was free, paid for out of buffer. The 5.16 s after it was not. **The whole margin this design exists to exploit is discarded one step before it is used**, because `source-activate` fires the moment `session-created` returns rather than when the cover is nearly spent.

Against the old behaviour — 62 s of blind retries, a spent network restart, then a terminal screen naming a node that never served the title — this is still unambiguously a fix. It is not the invisible recovery it was designed to be.

**Decided by Tom, 2026-09-17: defer activation. Built.** *"The assumption is they're not watching anything else, so it's ok to hold the slot. Just make sure it gets cleaned up if they close the media before the buffer expires."*

Core had recommended deferring the whole regeneration instead, to avoid holding the node's only video transcode slot for up to a minute — the concern that makes `ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS` 8 s rather than 30 s. **Tom's reasoning retires that objection rather than overruling it, and it is worth writing down because it generalises:** the slot would be held for the viewer whose session was reaped, and that is the same viewer who would otherwise be occupying it. Nobody is kept out of anything they were using. The 8 s standby window is about a *speculative* session on a *second* node, held on the chance it is needed — a different question with a different answer.

The session is created at once, because failing early is worth knowing about, and then held. `HELD_REPLACEMENT_SWAP_FLOOR_MS` is **30 s** and is a budget rather than a preference: it must cover the new source's first fragment arriving, and a node near the production frontier may hold that request for `SERVER_SEGMENT_HOLD_MS` before answering at all — twice over if the retry is held too, before a byte of transfer. Asserted as an inequality against the hold rather than pinned, the way `MEDIA_STALL_TIMEOUT_MS` is.

**Raised from 15 s by Tom, 2026-09-17, before it had failed anything**: the worst case is not the measured case, and the 5.16 s once measured against a healthy node is no guide to the ceiling. The two errors are not symmetric — too low and the viewer stalls, which is the whole fault; too high and some buffer that could have been played is discarded, which nobody can see. Against the 66.9 s and 110 s runways since measured in the field, 30 s still spends most of the cover.

**Runway is derived from `bufferedRangesMs` when `forwardBufferMs` is absent**, rather than treating a reported buffer as no buffer. An adapter reporting ranges and not the scalar was getting no deferral at all, for no reason.

**What swaps it in**, in the order the cases actually arrive: the runway falling to the floor; the element reporting `buffering`, because whatever the arithmetic said the viewer is already waiting; a premature `ended`, which is how the dead source running dry surfaces on some hosts; and a seek — which also has to happen *before* the seek is issued, because until the swap the coordinator still names the session the node reaped and the seek would PATCH a session answering 404.

**What releases it unused**, which is the half Tom named: closing the player, failing over to another node, and a terminal failure. It is torn down in `close()` explicitly rather than through `serverSession`, which still points at the source actually playing — so nothing else in teardown knows it exists, and without that branch the node's transcode slot stays held until `session_idle` thirty minutes later.

**Silence reads as no runway.** `forwardBufferMs` is optional on `PlaybackEvent`, and an adapter reporting none is not an adapter with an empty buffer — but a replacement held against a runway nobody measures is never swapped in, and the source it replaces is already dead. Costing a buffer flush is the safe direction; costing the session is not.

**Not measured, and it only matters if this shows a problem:** whether a transcode generation created at position X and left unrequested for a minute has produced that far ahead, or whether the first request at X+60 s sits on `500 segment_not_ready` holds. The client can answer it against a node. If it holds, the floor is doing its job and the swap is merely slower than modelled; it does not make the deferral wrong.

### Resolved by the run, no longer open

`regenerate()` awaits the old session's teardown before creating the replacement, and there was a worry that this could stall against a node that had just gone. Measured: `session-stop` to `session-stop-already-gone` was **161 ms**, because a reaped session answers `404` at once and `MachaPlaybackResolver.stop` treats that as success. Not a problem in the case it was raised for. Left alone.

**Still to do.**

### Regenerating destroys the provenance the probe needs — found live, fixed, not re-verified

**Run 1 of the deferral failed, and the failure was worse than the stall it replaced.** The hold itself worked — `replacement-held` with `runwayMs: 110592` against `floorMs: 15000` — and was then thrown away 28 s later. The viewer lost 82 s of playable video, the element was emptied, and playback failed over onto a node that had never served the title.

**The mechanism, and it is structural rather than incidental.** `regenerate()` releases the old session from `ClusterPlaybackResolver`'s ownership map — correctly; it has been closed. But that map is what `sessionAlive()` resolves an endpoint through, so **a session that has been replaced can no longer be probed at all**. Meanwhile hls.js goes on retrying the dead source for ~30 s and eventually goes fatal. That fatal named the old session, reached the probe, threw `has no endpoint provenance`, was read by the new fall-through as "could not find out", and went to failover — which releases the held replacement on its way past. Every step doing exactly what it was told.

**It is not about the error's kind, and not about Direct Play.** Core had reasoned its way to a narrower version of this — that the follow-up arrives as `media` on the Direct Play path — and that framing was wrong. **Any player that retries a dead source for longer than a replacement takes to build arrives here**, and hls.js always does. The web client found it on the managed-HLS path where the error is a clean `not-found`.

Fixed by refusing to probe at all while a replacement is held or being built: on the fatal channel swap it in, on the degradation channel drop it. Dropping is the only sane answer on degradation — a retrying player emits one every few seconds, and acting on the first would collapse the deferral into the buffer flush it exists to prevent.

**Why the fatal swaps in rather than holding on, which is a fact about the host and not a preference.** `WebPlayer.failSourceGeneration` tears the element down *inside* its terminal — `hls.destroy()`, `video.pause()`, and a flag suppressing the next play request — **synchronously, before core's listener is called**. So the runway is already gone by the time core decides, whatever the last event said. Core had inferred the opposite from the run 1 log, where `media-abort` lands 6 ms after `source-terminal-failure`; the log genuinely cannot separate them and the client read the code. **A timeline can order two events and still not tell you which caused which.**

### Run 2 passes: no slot leak

Player closed 18 s into a hold. `session-stop` -> `session-stopped`, and verified against the node afterwards: `GET /api/v1/playback/sessions/44a2fc74…` -> `404`. Run 1's replacement is also gone, released by the failover path. The half Tom asked for works.

### The adapter stops tearing down — shipped in `0.18.0`; the *Still to do* list below is what is left

**Tom, 2026-09-17:** *"There's no point in two NPM packages published when we already know there's an issue. Continue and work with Client until we have a clean NPM to publish that solves the problems."* So the sequencing below is reversed: this lands with the rest and there is one release, not two. **That also disposes of the coupling hazard entirely** — the danger was only ever in the two halves shipping apart, and now they cannot.

Core's half is built: on a fatal with a replacement held, the failure is absorbed and the ordinary triggers go on deciding, unless the runway is already spent. The obligation is written onto `Player.subscribeFailure` rather than left to be inferred from a message: **an adapter reporting `not-found` must not tear the presentation down on it**; the obligation is opt-in and arrives with the kind, so a player that never classifies `404`s is unaffected and still correct; and **core owns telling the viewer when there is no replacement**, through `failTerminal` and the runtime's stop.

`PlaybackEvent.readAheadBytes` is added, and `runwayMs` is now the element's buffer **plus** the host read-ahead converted through the session bitrate. Direct Play stops being blind to its own cover on the path most likely to be serving a large file.

The original framing, kept because the reasoning is what makes the ordering safe:

The client offered to **stop tearing down for `fail-not-found` specifically** — report it and leave hls.js, the element and the viewer's buffer alone, because on that one classification the source is known-dead but the buffer is known-good and the recovery is core's. Core would then drop the fatal and keep holding, and the deferral would keep its full value on managed HLS instead of losing the remainder of the buffer at the moment hls.js gives up (~30 s in, against buffers of 60–110 s).

**It must not ship at the same time as the current fix.** If the adapter stops tearing down while core still swaps on the fatal, core discards a buffer that is by then genuinely intact — no worse than today, but no better. If core drops the fatal while the adapter still tears down, **the viewer is left on a dead element** with no buffer, no MediaSource and playback suppressed. So the safe order is: ship what is built now, then the adapter's change, then core's switch.

It also needs an answer the client has explicitly asked for rather than guessed: **what the adapter should do when core has no replacement and regeneration fails.** Today the teardown is what turns that into a stated failure rather than a silent stall. Under the new contract core owns that, through `failTerminal` and the runtime's cleanup — which needs stating plainly before anyone relies on it.

### Closed by the above: `forwardBufferMs` is element-only, and Direct Play has a second buffer

Definitive from the client: `forwardBufferMs` derives from `video.buffered` and nothing else. **The Direct Play read-ahead worker's cache is not in it**, so on the path that matters most for the reported title core is blind to real cover and swaps earlier than it needs to.

The client can supply it — `directPlayReadAheadMetrics` already carries `residentBytes` and `aheadBytes`, and `publish` already reads them. **A separate field on `PlaybackEvent`, not folded into `forwardBufferMs`**, which would make one number mean two things. Bytes rather than milliseconds, with core converting through the session bitrate it already holds. Core owes them the field name and shape.

### Still to do

- ~~**Re-verify the stall is gone.**~~ **Verified live 2026-09-23** — see the head of this section: in-place regeneration after a 34.7-minute pause, no stall in 1,257 samples.
- The look-ahead question — whether a generation held for a minute is still being produced — remains unanswered for the same reason. Watch for `source-not-found-on-live-session` **after** `replacement-swapped-in`.
- Nothing has met a node in the *node-unreachable* case. The client has a repro that collapses the thirty-minute wait — pause through the UI, `DELETE /api/v1/playback/sessions/<id>` on the owning node, resume — and verifies through a **temporary `file:` link to this tree**, then unlinks. Core's `dist` is built and current, so the link sees all of it today.
- The web client's half is **written and proven live**, and its tree deliberately does not typecheck — four errors, all `SEGMENT_NOT_READY_STATUS` / `SOURCE_NOT_FOUND_STATUS` / `'not-found'` not existing in the registry copy of core. That is the honest state and it was waiting on a real version number, not on more work; `0.13.0` and `0.14.0` have both shipped since, so this is closed unless that tree says otherwise.
- **A trap for whoever links next, which cost the client a cycle.** Vite pre-bundles dependencies into `node_modules/.vite/deps` and swapping the symlink underneath does **not** invalidate it: the browser threw `does not provide an export named 'SEGMENT_NOT_READY_STATUS'` against a cache built from the registry copy while `node -e` in the same directory resolved the linked tree correctly. `rm -rf node_modules/.vite` and `vite --force`. This is the "a swap can silently not happen" failure one layer below the one already on record.
- The resume-time probe after a long pause. Optional, and correctness does not rest on it.
- ~~`HISTORY.md`'s release table gets a row when this actually ships.~~ **Done** — the table now carries `0.13.0` through `0.18.0`, with the three never-published tags marked as such.

**Method note worth keeping.** Every test here was seen red against the unfixed code before being kept, including the ones that assert an *absence* — those failed at `HEAD` because the probe they wait for never happens, rather than passing vacuously. That check was worth running: it is the trap `FakePlayer`'s comment was written about.

---

## Low — the register

Verified, each real, none urgent. Grouped by area so a session cleaning one area can take the set.

**Six items that stood here as *FIXED on `develop`* shipped in `0.18.0` and are gone from this list; they are in COMPLETED. Line numbers here were re-anchored against `develop` on 2026-09-19 and will rot again.** `PlaybackCoordinator.ts` grew from roughly 1,400 lines to 2,643 across `0.13.0` and `0.14.0`, and every citation into it moved by hundreds of lines while the defects themselves stayed exactly where they were. The ones below were re-read; a handful of the shorter files were not, and are marked where that is true. **Treat a line number as a hint and the symbol name as the address** — if they disagree, the symbol is right.

**Coordinator and playback**
- `PlaybackCoordinator.ts:1542-1582` — `degrade()` does not check `failoverPromise`, so a degradation during failover POSTs a redundant standby on a third node. Churn, not a leak.
- `failNow`'s `failoverPromise` branch is **shadowed**, found 2026-09-20 while covering it. `beginSourceFailover` independently refuses to start a second failover, and the whole 935-test suite passes with the `failNow` branch removed — its only unique effect on current code is its `debug` line, and a corner where `snapshot.session` and `serverSession` are both absent mid-failover, which nothing produces. **Keep both**: they are different intents that happen to coincide, and the `failNow` comment records a measured 82-second viewer loss. This entry exists so nobody removes `beginSourceFailover`'s guard believing `failNow` still covers it — it does, today, and only today. Its twin on the degradation channel is the entry above.
- `testing/FakePlayer.ts` — `setVolume()` is declared with **no parameters** and discards the level, so no test anywhere can assert what was applied. The `setVolume` docblock records two occasions when applying a level was confused with persisting one, which makes an unobservable level the wrong gap to leave in the one shared double. **Not widened yet because `FakePlayer` ships on the `./testing` export**: adding a parameter turns `() => void` into `(volume: number) => void`, and a client calling `player.setVolume()` bare would stop typechecking. Do it with a release that carries a note, alongside `detach()` now stopping.
- `PlaybackCoordinator.ts` — **`snapshot.instruction` goes stale on a viewer mode change.** Found 2026-09-20 while building the substitution detector, which had to route around it. `instructedPreferences` patches the report from `startInternal` and from `queueChosenInstruction` (the Auto path), and `applyDegradedInstruction` patches it on a step down — but a plain `update({ preferences: { mode } })` patches nothing. So after a viewer switches from transcode to remux the report still says `transcode`, with `chosenByViewer: false`. A host rendering the instruction notes shows the wrong mode and attributes it to the chooser. Small, real, and the reason `modeHonoured` compares against the node's echo rather than against this.
- `PlaybackCoordinator.ts:1765` — the transcode standby window is keyed on `alternate.mode === 'transcode'`; if the entitlement is video-only, `transform.video === 'transcode'` is the precise test. The 8 s comment records the slot cost but not the quantity it must exceed.
- `PlaybackCoordinator.ts:1712-1756` — there is a disposed/revision re-check after the awaited `prepare` (`:1726`) but none after the preflight that follows it.
- `MachaPlaybackResolver.ts:332`, called at `:407` — `reconcileQualityCaps` runs on `resolve()` but not `update()` (`:430`, verified: one call site), against its own doc. The "skips remux" half is not obviously true of the body at `:335-340` and was not re-verified; check before acting on it.
- `MachaPlaybackFactsApi.ts:45` passes `dolby_vision_profile: 0` through where the other normaliser treats 0 as "not probed". (The dead ternary beside it in `MediaTechnicalProfile.ts` shipped fixed in `0.18.0`.)

**Cluster and routing**
- `EndpointRegistry.ts:185` (`ABSOLUTE_AXES`, and the doc at `:174-177`) — sticky is checked before the both-cooling order, so a sticky node on a 30 s cooldown is walked before a non-sticky one on 0.5 s.
- `EndpointRegistry.ts:49,72` — capacity never expires; `observedAt` is declared on both records, written, and read by nothing (verified 2026-09-20: the only two occurrences are the type fields).
- `EndpointHealthMonitor.ts:136` + `EndpointRegistry.ts:495` — capacity keyed by `api_endpoint` string, so a typed IP versus an advertised hostname yields the same node twice and the in-use bootstrap entry never gets capacity.
- ~~`EndpointRegistry.ts:713-715` — `notify()` does not isolate listeners~~ — **moved into the P1 health-loop item**, where it belongs with its twin.
- ~~`EndpointBandwidth.ts:17-20,124-126` vs `EndpointRegistry.ts:101,563` — restore re-enters at one sample, threshold is two~~ — **folded into *The throughput axis may never have ranked anything* in P1**, which is where it stops looking harmless. `EndpointRegistry.test.ts:266-269` pins the current behaviour.
- `EndpointHealthMonitor.ts:69,164,235` vs `serverConnection.ts:41-44` — a proxy's bodiless 502/503/504 counts as reachable and clears the outage state forever.
- `EndpointRegistry.ts:85` vs `EndpointHealthMonitor.ts:10` — the cooldown ladder (500 ms, 2 s) is uncalibrated against the 10 s probe interval; a probe-failed sticky node is "ready" 0.5 s later. Neither constant records the relation. *This is the same class `hlsWalk` and the stall budget were fixed for: assert the inequality, not the number.*

**API layer**
- `ClusterCatalogueApi.ts:27` — `ARTWORK_ENDPOINT_TIMEOUT_MS = 8_000` exactly equals the inner `DEFAULT_REQUEST_TIMEOUT_MS`, so which error the caller sees depends on timer ordering.
- `ClusterCatalogueApi.ts:51-63` — a not-ready catalogue synthesises a 503 that cools down a node that answered.
- `AcquisitionApi.ts:91-104`, `ManageApi.ts:114-128` — no `AbortSignal` on these families, so a polling screen that unmounts still walks every candidate. `MachaAcquisitionApi.request:107-108` also lacks the 204 handling Manage has.
- `src/connection/connectionConfiguration.ts`, `MachaManageApi.ts:32,71` — `cache: 'no-store'` relied on alone, against `platform-neutral.d.ts:108-125`. *Candidate cause for a client reporting stale node versions — candidate, not cause; nobody has verified it.*

**State, runtime and docs**
- `state/musicPlaylist.ts:26` — `MusicPlaylistStore` still exported after being superseded by `PlaylistStore`, which adopts its key on first read. Against the hard-cuts rule. **Delete it** — and note `0.11.0` proved the sequence for this: clients take a copy first if they have one, then core removes.
- `runtime/configuration.ts:224` and `api/httpCompat.ts:103` — `normalizeUrl` and `normalizeBaseUrl` are the same four lines under two names. **Duplication to delete before it drifts, not a correctness bug** — verified across nine input shapes.
- ~~`README.md:100-103` — omits that throughput is fed only by a host-built `EndpointBandwidth` nothing in this package calls `record()` on~~ — **folded into the same P1 item.** The README line still needs fixing when that is settled.
- **The hyphenated storage keys**, now that `macha.session.v1` has moved: `macha-client-id`, `macha-server-url`, `macha-bootstrap-endpoints-v1`, `macha-discovered-endpoints-v1`, `macha-server-endpoints-v1`, `macha-client-bandwidth:`. Two conventions is a defect, not a design. Each costs a forced re-read or a lost value to rename, so they move **when something else already forces that cost** — never on their own. `MACHA_STORAGE_KEYS` documents both meanwhile.

**Simplification, where the payoff is real**
- `request`/`throwResponseError` is triplicated across Catalogue, Acquisition and Manage (plus PlaybackFacts) with three shape-identical error classes, and has already drifted on 202/204 handling. One `jsonRequest` in `httpCompat` would collapse ~60 lines and make the malformed-body fix a single change. `objectValue`/`asRecord` is re-implemented three times.
- `route()`/`find()` duplicate the walk skeleton; every `Cluster*Api` repeats the `instanceof ClusterEndpointRouter` constructor; `evaluatePreferredSwap` calls `candidates()` (a re-sort plus an axis side effect) where `snapshot()` would do.

---

## Watching, not doing

- **A backgrounded Android TV keeps polling the cluster, indefinitely — and it is not core's to fix, but it is core's to know about.** Reported by that client 2026-09-15 while checking something else. The comment above its provider effect says *"Stop discovery while the app is not foreground… continuing to poll the cluster from behind the launcher costs the nodes requests for nobody's benefit"* — and **nothing in the effect stops anything**. `EndpointHealthMonitor` is started in an effect and stopped only on cleanup, so a television left on the launcher goes on asking `clusterStatusApi` for status for ever. **Recorded here because it is cluster load with no client owning up to it**: a node seeing constant status traffic from an idle set would otherwise be misattributed, and core has spent time this week on exactly that class of error. The client has it ranked below the Settings focus defect and is not fixing it in this session.

- **The platform probe has never run on a device.** `checkPlatformSurface()` ships having produced no runtime truth; its tests run on Node, which supplies everything. `0.8.0` added the three Hermes probes (`Intl.Collator` options, `normalize`, `\p{M}`). The Android TV hardware run is the first chance at real output.
- **The Android TV failure trail is built but cannot be switched on** — its Settings screen has no focus-follows-scroll and the toggle sits below the fold where focus reaches it invisibly. Not core's, but **every on-device diagnosis discussed here depends on that surface being reachable**, so it gates the evidence core is waiting for. That client has put it ahead of its port.
- **`cpu_cores` and capacity ranking.** Live since server 0.36.7 and the axis switched itself on. Nothing to do unless a node reports stale telemetry — `telemetry_freshness` and `live_age_ms` exist and core does not weigh them. Open question rather than known defect.
- **No pairing or QR concept exists in core, and is not going to yet.** **Tom, 2026-09-13: leave it for the future.** The phone client's payload parse stays local. If a format is ever shared it belongs here — otherwise four clients invent their own and drift on normalisation edges — but that is a decision deferred, not a defect, and should not be raised again until someone needs a second scanner.
- **Two clients still hold a duration formatter.** `formatPlaybackTime` is in core and the web client has dropped its copy. The phone and Android TV clients can drop theirs whenever convenient; nothing breaks until they do, and nothing improves either.
- **Server `0.40.1` adds `diagnostics.repair`** under `GET /api/v1/status/diagnostics` (`unsourceable_objects` plus a bounded sample of ids). **Core is unaffected** — `ClusterStatusSnapshot` has never carried that block — recorded so the next session does not rediscover it.
- **A broken function in core grows a copy in every client, and fixing it does not remove them.** `checkEndpointConfiguration` could not accept any endpoint against a live cluster until `0.9.0`, so at least two clients wrote their own pre-save gate — one of which had the same lockout by a different road. Both fixed, but nobody would have gone back to core's version without being told it worked now. **When a defect in a shared function is fixed, say so to the clients that routed around it**, or the duplicate survives and drifts.
- **Findings that turned out to be misattribution**, recorded so they are not raised a third time: `/api/v1/status` answering `200` with an apparently empty roster, and `/api/v1/health` answering `401`, were both a single node on an old build rather than server defects. And a client's "the signature churns on every fetch" was a *different build*, not a contradiction — see how-to-be-wrong item 2.
- **One transient client test failure during a core rebuild**, twice. Both were genuine mid-rebuild races and are closed by the atomic `dist` staging. If one recurs *outside* a rebuild window, treat it as real rather than as a race.
