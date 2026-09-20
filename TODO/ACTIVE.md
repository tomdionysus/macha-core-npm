# Active

Open work for `@machafoundation/core`. Items land here when they are decided-but-undone, or undecided-and-blocking. Anything finished moves to [COMPLETED.md](COMPLETED.md) with the version it shipped in.

An item says who it is waiting on. "Tom" means a decision rather than an implementation; "core" means it is mine to build; a client name means the evidence has to come from there before this can move.

---

## Start here if you are new to this

**Where things stand.** `0.14.0` is the baseline — released, tagged, pushed and **live on npm as `latest`**. It carries the per-node playback budgets, the seek contract, and the failure chain reaching hosts intact, together with `0.13.1`'s four seamless-host fixes, which had been bumped but never tagged. `develop` and `main` are level. Twenty-three tags, `0.2.0` through `0.14.0`; npm holds `0.8.1`, `0.11.1`, `0.12.0`, `0.13.0` and `0.14.0`.

**`develop` is now well ahead of `0.14.0` and none of it is published.** Seventeen commits on 2026-09-20, all core-internal: the runway re-read at the decision point, advisory status routing, `close()` awaiting the recovery it does not own yet, the session-manager generation, the health loop surviving a full store, the success-envelope validation, `find`'s absence reporting, the fake-player merge, the already-charged close, six from the low register, and the recovery transform restatement that closed the one item the previous session opened. **924 tests, typecheck, `lint:platform`, `build` and `dist:check` all clean — in that order, build last.** Every item marked *BUILT on `develop`, unreleased* in this file is in that set, and **no client can see any of it** — they resolve from the registry.

**The release gate on the transform restatement is cleared — the server answered both questions on 2026-09-20, against current source.** Naming `video: 'copy'` at session *creation* is honoured: create calls `parse_preferences` with **no** `current` (`src/playback.cpp:2165`), so there is nothing to clear and the field is simply read, while PATCH passes `old->preferences` (`:2372`) and clears the four. `mode: 'transcode'` with `video: 'copy'` is legal and is not normalised away — the server's own docs call transcode *"the permissive mode, and it is how a mixture is asked for"*. A node that cannot copy a codec into the requested container throws `invalid_argument` and returns **400**, not a 5xx and not a substitution. **The fix does what it was built to do.**

**It left two new items behind, both below in *P1 — correctness*, and one of them is a live hazard rather than a nicety**: `bad_playback_request` does not distinguish "this node cannot do that" from "your request was malformed", and there is exactly one silent-substitution shape which core can detect from the payload and currently does not look at. Two things a release has to carry into its note rather than let a client discover: `FakePlayer.detach()` now stops (it ships on the `./testing` export), and `PlaybackEvent.forwardBufferMs` gained a contract both RN clients have already been told about and checked themselves against.

**Six commits sit on `main` after the `0.14.0` tag and none of them is code** — the README and guide rewrite, and two on the headless sample. `dist` is unaffected, so no client sees a difference and there is nothing to publish. Say so here rather than letting the next session read `git log` and conclude a release is owed.

**The registry is now the answer to "what can a client have".** It was not, for a long stretch — see *Moving the clients onto public npm* for the gap and why `git tag` stopped being a safe question to ask. The last three releases have gone out, so the two questions have converged again; do not let them drift apart without saying so here.

**The web client is on `@machafoundation/core@^0.14.0` from the registry**, not on a `file:` link to this tree. Its `0.17.2` was re-cut against the published tarball so that the tag points at something a user could actually install. A link is for verifying a fix that is not yet releasable, taken and removed in one sitting; anything a client builds on is a published version.

Work happens on `develop`; a release is an annotated bare-semver tag (`0.11.0`, never `v0.11.0`) on `main`, with the version bump *inside* the release commit so the tag points at exactly what ships.

**How to check you have not broken anything:** `npm run typecheck`, `npm run lint:platform` (the no-DOM gate — this is the one that catches a browser global sneaking into core), `npx vitest run`, `npm run build`, `npm run dist:check`. The suite is **897 tests in 64 files, all passing** as of 2026-09-19. Run all five.

**Build LAST, after the final `git checkout`.** `dist:check` compares mtimes, and a branch switch rewrites every source file's. So "build, merge to `main`, tag, checkout `develop`" leaves `dist` stale **even though no source changed**, and every client's `pretest` then refuses. This happened on the `0.10.0` release and blocked a client until it was caught. Core reported "dist is current" in good faith and was wrong within the minute.

**`npm run build` stages and renames; keep it that way.** It compiles to `dist.staging` and moves it into place, because `tsc` removes nothing (so emitting in place leaves orphans that `dist:check` is structurally blind to) and emptying `dist` first made the window *worse* — a client watched its whole suite collapse to "no tests" mid-rebuild. A failed compile leaves `dist` untouched.

**Never put Claude attribution in a commit message.** No `Co-Authored-By`, no `Claude-Session`, no generated-with line. A commit message ends with its last line of prose. This cost a full history rewrite of 16 commits across `main`, `develop` and two release tags on 2026-09-13.

**Four clients consume this package** — a web/TV app, a Samsung Tizen build of the same, a React Native phone app, and a React Native Android TV app. **All three that have been asked resolve it from the registry**, decided 2026-09-15 and completed by 2026-09-17; the Tizen build shares the web client's tree. So a change on `develop` is invisible to every client until it is **published** — use a `--tag next` prerelease to get it in front of a client to adopt or ship on. A temporary `file:` link is for *verifying* something not yet releasable and is removed the same session; see the amendment under *Moving the clients onto public npm* for the line between them, and that section for why the `file:` loop was retired.

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

## Client adoption — which version each client actually resolves

**Adopted and tested is not ported** — that distinction is the web client's and it is worth keeping. A third column is now needed: *how* a client resolves core, because "on core" stopped meaning one thing on 2026-09-15.

**The web row was wrong until 2026-09-17** and said `^0.11.1`: that client's `package.json` had moved to `^0.12.0` and this table had not. It was caught from the other side — the client read its own range while checking what core exported and found both its own TODO and this one stating the older figure. **The same drift happened again and was caught the same way:** the web row said `^0.12.0` until 2026-09-19, by which point that client had moved to `^0.14.0` and this file's own opening paragraph said so three sections above. **A table that has to be updated by hand will be wrong within one release** — twice now, both times about the client that moves fastest. **The other two rows remain unverified**, not confirmed; nobody has read their `package.json` since. Ask the client, do not infer it from here.

| Client | Resolves core by | Suite | Ported |
|---|---|---|---|
| Web | **npm `^0.14.0`** — released as `macha-client` 0.17.2, no link | 46 files / 335 | **no** — `AccountMenu.signOut` onto `sessionManager.signOut()`, `lastIdentityChange` unsubscribed |
| Android TV | **npm `^0.11.1`** — renamed, no link, `expo export` green | 11 files / 159 | **no** — `secureStorage` **not supplied**; token in app-private storage |
| Phone | **npm `^0.11.1`** — renamed, 38 imports, no link | 12 files / 90 | **no** — `secureStorage`, `lastIdentityChange`, `signOut`, `probeNow` |

**All three clients were on `0.12.0`, verified against the published tarball, as of 2026-09-17.** The web client has since moved to `0.14.0`; the other two have not been asked. Web: refactor landed, 338 tests, fresh-clone acceptance. Phone: migrated, 100 tests, `expo export`. Android TV: installed, 166 tests, 841 modules, and the Hermes bundle byte-identical between working tree and fresh clone.

**But the release's central fix is unverified, and no automated check can verify it.** The `memoryStorage` capture typechecked, bundled, and passed a green suite while a viewer lost their configured endpoint on every restart. So a green suite on `0.12.0` says nothing about whether the getter actually fixed it. **That needs a device session on the television:** set an endpoint in Settings, force-quit, relaunch, confirm it survives; confirm `macha-client-id` reaches AsyncStorage for the first time; confirm the trail shows `throughput-unavailable / insufficient-samples` rather than `no-bandwidth-store`, which would mean `attachBandwidth` never ran.

**Gated on Tom**, because the Settings focus defect gates the failure trail those diagnoses are read from. The Android TV client declined to report "verified" without it — correctly, and citing this file's own rule about green clients back at itself.

**One consequence to state rather than discover:** existing Continue Watching and queue data on that client is orphaned by the fix, because those stores were keyed by the per-launch memory id. Nothing is lost that was not already being lost on every launch.

**The web client verified the way the package will actually be met**, not in place: a fresh clone with no `macha-ts` anywhere on disk, `npm ci`, tarball resolved by integrity hash, typecheck clean, 335 tests green. That is the bar for the other two — an install proved against a tree that still contains a local core proves nothing, as its stale-link finding showed.

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

**Found by the phone client on 2026-09-15, by making the change rather than reasoning about it.** Fixed in the working tree; ships next release.

The comment said *"Use this rather than a prefix test of your own."* Read as intended that means "do not hand-roll a test for core's keys". Read as written it means "replace your own key filter with this", and **that is catastrophic**: the registry lists what *core* owns, and a host owns more. The phone client's `owned()` set is strictly larger, and `isMachaStorageKey` returns false for all of `macha.clientId.v1`, `macha.endpoints.v1`, `macha.discoveredEndpoints.v1`, `macha.downloads.v1.`, `macha.musicLibrary.v1.` and `macha.progress.v1:`.

**`macha.clientId.v1` is the one that matters**: it is the namespace the per-client stores are keyed under, so dropping it means a fresh client id on every cold start, orphaning Continue Watching, the queue, the playlists and the music library at once. Silent — and a *larger* version of the sign-out incident this file's own header cites as its reason for existing.

I made this worse before it was caught: I told both RN clients "if you use your own prefix test rather than `isMachaStorageKey`, this is the moment to switch." The phone client checked instead of complying, and its hydrate test failed at the first assertion. **A client that had taken core's word would have shipped it.**

The comment is now explicit that the function answers "is this one of core's", never "is this Macha's", and the boundary is pinned by tests asserting false for each of those six host-owned keys — so the next person to "helpfully" broaden the registry has to delete a test that explains why.

**Two related corrections of fact.** `macha-client-progress:` — the key `0.11.1` added — is core's own legacy Continue Watching key, read by `state/continueWatching.ts`. I described it to the phone client as "directly yours"; it is not. That client's legacy key is `macha.progress.v1:`, which is its own, already matched by its own filter, and needed nothing. And `macha-session` is deliberately absent from the registry, having been retired in `0.10.0`.

### Adopt-on-read silently assumes the host's storage can see a key core never named

**Found by the phone client on 2026-09-15 while verifying a correction.** Fixed in the working tree; ships next release. **The Android TV client has been asked whether it is exposed** — its answer is outstanding.

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

1. `package.json` back to a published `^x.y.z` and `npm install` — **not a lockfile edit**.
2. **`test -L node_modules/@machafoundation/core` must fail.** A version string agrees while a stale link is still in place; that check cannot lie.
3. `typecheck` and the suite green **against the registry copy**, not against the tree the link pointed at.
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

**Ordered against the laws on 2026-09-20, not by age or by who found them.** *Numbering is core's, per `docs/principles-and-laws.md`; the server numbers the same three differently — see the entry in* Waiting on Tom. Law 2 first — anything that makes the viewer wait or stall. Then Law 1 — control work reaching into the viewer's data path, which the principles call a correctness failure rather than a benchmark. Then failures the contract says must be *visible and actionable* and are currently neither. Then the two remaining places core still holds a private copy of server configuration, which is the class `0.14.0` set out to end. The rest is real, verified, and cheaper. Everything here is core's to do; the items that need a decision first have moved up to *Waiting on Tom*.

### ~~A recovery restates the mode and drops the transforms the chooser picked~~ — BUILT on `develop` 2026-09-20, unreleased

**Waiting on:** a release, and on two confirmations from outside this tree that are named below. **Found 2026-09-20 by reading, prompted by an on-hardware report from the Android TV client.** `PlaybackCoordinator.ts` — `withRestatedTransforms`, `currentPreferences`, `recoverWithPreferences`, `applyDegradedInstruction`; `ClusterPlaybackResolver.ts` — `interchangeableGeneration`.

**What the client measured.** A generation with **video COPY** (HEVC 1920x1040 passed through, DTS 5.1 converted to AAC) was reaped on its node. Recovery rebuilt it elsewhere as a full transcode, HEVC re-encoded to H264, taking the new node's only `max_video_transcodes` slot to re-encode a stream the television was decoding natively. The server ruled out its own substitution: that path logs at INFO and did not fire, and the journal shows `mode=transcode` from admission. **Core asked for it.** Both `prepareAlternate` and `failover` were handed `completePreferences(session)` — `mode`, the caps and the stream selections, and **no `video` and no `audio`** — so under the 0.34.0 rule that naming `mode` restates the whole transform, the recovery cleared the `video: 'copy'` that made it a copy.

**The two questions the old entry said had to be answered first, and the answers, both from reading.**

*Instruction or session echo?* **Instruction.** `session.transform` is what the node did; restating it would make a server-side downgrade permanent, because each recovery would rebuild from the last one's and the copy could never come back. It is also the only source that can contradict the `mode` beside it — `mode` comes from the confirmed preferences overlaid with the viewer's pending change, so pairing it with the echo can state `remux` alongside a transcoded video, an instruction nobody chose. `degradeInstruction` is the same coupling seen from the other side: giving up an audio copy forces `remux` to become `transcode`. **Mode and transforms come from one place or not at all**, which is why a report for a *different* mode is left alone entirely.

*Re-consult the replacement node's capabilities?* **No, and that was already decided.** `facts()` documents it: `operations` describes the answering node's build, it is deliberately not re-fetched on failover, and a refusal is left to the 400 path because re-probing would put a request on the viewer's critical path at the moment playback is already struggling.

**But that answer had a consequence the entry did not foresee, and it is why this was not a one-line fix.** Restating `video: 'copy'` asks a node that never agreed to it to perform it, and **a 400 is not a retryable endpoint failure** — `create` throws it rather than walking to the next candidate. The naive fix would have traded a silent full transcode for a *terminal* failure, which is worse by a distance. So `recoverWithPreferences` gives up the copies exactly once on a 400, and only when the request actually asked a node to copy something; every other 400 behaves precisely as before.

**Three changes.**
1. `withRestatedTransforms` restates `video`/`audio` from `snapshot.instruction` on every recovery, guarded on the report describing the same mode being sent, skipping `direct`, and never overwriting a field already present so a viewer's in-flight change still wins.
2. The single step down above, on `failover` and `regenerate` only. **Standby preparation deliberately does not use it**: a downgrade rewrites the instruction the *live* generation will be rebuilt from, and a weak node refusing a copy it was only offered speculatively must not decide that for the session the viewer is watching. A standby that cannot reproduce the generation simply does not get made.
3. `interchangeableGeneration` now compares the per-stream transforms, not just mode and container. `transcode` covers both a passthrough and a full re-encode and they are not substitutes — that is the same fault arriving through the standby door.

**And one staleness found on the way, which the fix needed closed.** A 400 downgrade set the private `chosenInstruction` and left `snapshot.instruction` reporting `video: 'copy'` for a generation the node had refused to copy. A host's diagnostics were wrong, and once recoveries restated from that report every later recovery would have re-asked for the copy the first attempt had already given up. `applyDegradedInstruction` now patches both.

**Three tests, each verified red against the specific line it pins** — the restatement neutered, the fallback neutered, the mode-match guard neutered — rather than merely red. 924 tests, typecheck, `lint:platform`, `build` and `dist:check` all clean.

**Confirmed against server source 2026-09-20, so this no longer rests on a reading.** Create passes no `current` to `parse_preferences`, so `video: 'copy'` is honoured as given rather than cleared; `transcode` with `video: 'copy'` is legal and not normalised; a node that cannot copy returns **400**. The step down fires on the right signal. See the two entries this produced, immediately below.

**Confirmed on hardware 2026-09-20 by the Android TV client, and the fix holds three ways.** The §1.0 reap was re-run on *Life of Brian* against a build of `0.4.0` carrying `32da3e0`, APK verified byte-identical on the set. The replacement **kept the copy**: the control bar read `VIDEO COPY · HEVC · 1920x1040 · 9.8 Mb/s`, the session payload carried `preferences.video: "copy"` and `output.video.transform: "copy"`, and `running_video_transcode_pipelines` was **0 on both nodes** afterwards — which is the independent check, because a silent re-encode cannot hide from a slot count. It also rebuilt on the **local** node rather than across the site. Failure to new source: **7.2 s**, inside the buffer, viewer saw nothing.

**And the remux question dissolves — it was a labelling fault on the client, not a substitution.** The generation was `mode: transcode, video: copy, audio: transcode` throughout, straight from the node, before and after. `describePlaybackSession` prints `CONTAINER : endpoint`, so the screen only ever said `FMP4 :`; the word "remux" in that client's §1.0 was its own inference. There was never a disagreement between what was asked for and what was performed here, and the prediction this entry made — that the 5.1 downmix shape made a transcode-with-copied-video far likelier than a substitution — was right for the reason it gave. **The substitution detector below therefore has no live sighting behind it**, which does not make it wrong; it makes it a detector that has not yet caught anything, and that is worth saying plainly rather than letting this run stand in as evidence for it.

**The node's own answers, probed directly on 10.35.1.50, same title.** `{mode: transcode, video: copy, audio: transcode}` → **201** with `output.video.transform: copy`, so core's reading that the copy is honoured as given was right against the live node as well as against the source. Two `400 bad_playback_request` refusals came back from the same probe and they are the fallback path's test matrix, in the server's own words: `{mode: remux}` → *"fragmented MP4 cannot carry a copied dts audio stream; ask for preferences.audio=transcode"*; `{mode: remux, video: copy, audio: transcode}` → *"remux repackages and copies every stream: to re-encode one, ask for mode=transcode with video=copy or audio=copy"*. **Both are the `isExecutorRefusal` case `recoverWithPreferences` gives up the copies on**, and the second is worth reading twice: a request that names `mode: remux` *with* transforms is refused for naming them at all, so the step down out of `remux` has to change the mode rather than only the transforms — which `degradeInstruction` already does at `choosePlaybackInstruction.ts:441-447`. **Its comment states the server's rule in the server's own terms** — *"giving up the audio copy leaves the mode's own contract violated if it was `remux`, which requires every stream copied"* — written here without sight of that validator, and the two now agree word for word. That is the one kind of duplicated server model this file does not mind: derived independently and confirmed to match, rather than assumed. These two bodies pin it as a fixture rather than a belief.

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

### ~~A `404` on a playlist is thrown away inside core's own walk, so the host cannot classify it~~ — BUILT on `develop` 2026-09-20, unreleased

**Waiting on:** a release. **Found 2026-09-20** by the Android TV client, on hardware, while reporting something else — and it is the third recorded instance of this class reaching a viewer.

**What it measured.** A reaped session arrived at core as `kind: "unknown"` with `Response code: 404` sitting in the error message, and with **no `terminal-failure-classified` line at all**. `isEndpointRetryablePlaybackFailure` reads `unknown` as endpoint evidence, so **core charged a node that had answered honestly and walked a generation that `not-found` would have had regenerated in place on the node already holding it.** Precisely the fault `0.13.0` was spent removing, arriving through a different door.

**And the root cause is core's, which is not what this entry said an hour earlier.** It was first written as "the bug is that client's and it is fixing it", on that client's own first reading. **They then traced it into core's tree and were right.** `hlsWalkTargets` fetched the master playlist, read `.ok`, and **returned `[]`** — discarding the `404`. `probeHlsReadiness` could then only answer `unassessable / empty-manifest`, whose `status` field is only ever populated from a *fragment*. So the host's `kindForTerminalError`, which correctly requires a status before it will classify, had nothing to classify from. `playbackFailureKindForStatus(404)` returned `not-found` the whole time; **nothing ever called it, because nothing still held the 404**. The contract worked at every step except the one where the evidence was thrown away, inside core.

**Worth keeping as a boundary lesson in its own right.** Core accepted a client's account of whose bug it was, wrote it down as settled, and the client — not core — went and disproved it in core's tree within the hour. A peer saying "this one is mine" is no more authoritative than a peer saying "this one is yours", and this file already records the same fault in the other direction twice. **Check the tree named, whichever way the claim points.**

**What core must not do, and it is tempting.** The status was *also* in the message. Reading it out of there is the inference this file already records as a fault class twice over, and the message is the host's to format — `expo-video` builds it as `"A playback exception has occurred: ${localizedMessage} ${cause?.localizedMessage}"` and could change it in any release. Core does not parse it. It holds the number honestly instead, which it had all along.

**The fix, built on `develop` 2026-09-20.** `hlsWalkTargets` throws a typed `HlsManifestUnavailableError` carrying the URL and the status instead of returning `[]`, for both the master and the variant playlist; `probeHlsReadiness` maps it to `{ state: 'unavailable', status, detail }`, mirroring exactly what it already does for a fragment one branch below. **Thrown rather than returned so every caller of the exported primitive meets it** — a host asking the walk its own question got the same empty list and the same missing number, and an empty array reads as "nothing here" however carefully it is documented. `preflightHlsSource` is unaffected: it already catches to `false`, which is the answer it gave on an empty list, and a test pins that so the throw cannot escape into a caller that never expected one. **`empty-manifest` gets its real meaning back** — a `200` that parsed to nothing — which it could not have while the common case was drowning it.

**Six tests. Four verified red against their own neutered line** (the master throw, the variant throw, the status on the outcome, the detail on the outcome). **Two are guards and are green either way, deliberately:** `empty-manifest` still answering for a served-but-empty playlist, and `preflightHlsSource` still answering `false`. Those two pin what must *not* change, and saying they were "verified red" would be the exact claim this file's tenth lesson is about.

**Nothing in core calls either function** — they are exported for hosts, and the grep is the evidence. So this changes no core behaviour and no client breaks; it changes what a host is *able* to see, which was the entire defect. A host that reads `unassessable` today and does nothing will now read `unavailable` with a status, which is the outcome it should have been getting.

**What core can do, and has.** `isEndpointRetryablePlaybackFailure` cannot distinguish three different events that all arrive as "no evidence": a host that never wired classification (which the `Player` contract expressly permits), a host whose classifier ran and could not tell, and a host whose classifier was *meant* to run and silently did not. The first two are fine. The third is a defect that is invisible from both sides — the client sees a kind it did not intend, core sees a node it condemns. `noteUnclassifiedFailure` now emits **`source-failure-unclassified` at `debug`, once per session**, at the two sites where the evidence is actually spent, carrying the endpoint being charged, which channel it came through, `classified` (whether the host tried at all and could not tell, versus never tried), and **the message verbatim** — so a capture shows the evidence the host had and did not use.

**`debug` rather than `warn`, for the `seek-invariant-not-stated` reason.** An unclassified failure is permitted by the contract, so it is ordinary rather than a fault, and one client renders warn-level onto a television for the whole of a film. A capture taken at `warn` still cannot separate these; one taken at `debug` can.

**Four tests, each verified red against its own line — and one was rewritten after passing for the wrong reason.** The once-per-session test was first driven through the fatal channel, where `failNow`'s `failoverPromise` guard drops the second failure before it ever reaches the note: it passed with the latch deleted. It now runs through the degradation channel with `prepareAlternate` returning `undefined`, which is both the case that reaches the note twice and the live shape — a dead source going on emitting while a cluster with no spare node has nothing to prepare. **Third occurrence of this in two days; the neuter check caught all three.**

**What this does not do.** It does not change a single decision — the charge still happens, the walk still walks. It makes an invisible misattribution greppable, which is the whole of it. If unclassified charges turn out to be common in captures, *then* there is a case for core declining to charge on them; that is a behaviour change and is not being made on one sighting.

### A node substitutes a remux for a transcode and says so in the payload, and core has never looked

**Waiting on:** core. **Found 2026-09-20** from the server session, unprompted, while answering a different question. Nothing in core reads this today.

**The one substitution shape that exists.** `media_engine.cpp:1770`: when a remux's keyframe index is unusable as a segment plan and `allow_video_transcode_fallback` is set, the planner sets `result.playback.mode = transcode` and logs at INFO. **It is not silent on the wire.** The session reports the substituted mode honestly — top-level `mode` is what was actually *performed*, while `preferences` echoes what was *asked for*. So `session.preferences.mode !== session.mode` is the detector, on every create and every PATCH response, and it is the only shape the server knows of.

**Why core wants it.** This is the exact uncertainty the transform-restatement item above was written around: *"they differ after a server-side substitution, and restating the node's own downgrade would make one bad plan permanent."* Core resolved that by restating from the instruction and never from the echo — which is right, and which means core is now **re-asking for a remux every recovery on a title whose keyframe index will never be usable**, getting substituted every time, with nothing anywhere saying so. One comparison of two fields core already holds turns that from invisible into a fact.

**BUILT on `develop` 2026-09-20, unreleased — the reporting half.** `PlaybackInstructionReport` gains `performedMode` and `modeHonoured`, computed once in `instructionWithServed` beside `containerHonoured`, plus one `generation-mode-substituted` warning per generation — once, not once per snapshot patch, because on the Android TV client warn-level events are on screen for the whole of a film. Four tests, each verified red against its own line, and **two of them were rewritten after passing for the wrong reason**: the first version of the viewer-mode-change test could not distinguish the two candidate comparisons at all, and the once-per-generation test never patched the report twice.

**The memory half is still open and still needs deciding.** Whether core should remember per media that the remux was substituted and choose transcode directly next time. Not obviously right: the fallback is a fact about one node's view of one title, and pinning it would be the same mistake as caching `operations` as a cluster property. **Do not build it without deciding that.**

**What it should do with it, and the shape needs deciding before it is built.** At minimum report it: a substitution is a degraded state and the contract says those must be *visible and actionable*, and it belongs in `PlaybackInstructionReport` beside `containerHonoured`, which is the same question asked about the carriage. Whether it should also stop core re-asking — remembering per media that the remux was substituted, and choosing transcode directly next time — is a real design question and not obviously right: the fallback is a fact about one node's view of one title, and pinning it would be the same mistake as caching `operations` as a cluster property. **Do not build the memory half without deciding that.** The reporting half is unambiguous and can go first.

**This is `containerHonoured`'s twin and should be built like it** — requested and performed kept side by side, absent rather than false when either side is unknown, because an unanswered question must not read as an answer.

### ~~The runway is read from a stale snapshot, and the field that would refresh it has no guard~~ — BUILT on `develop` 2026-09-20, unreleased

**Waiting on:** a release, and on both RN clients to know the event contract moved. **Found 2026-09-19**, while answering the Android TV client's question about how long it may spend classifying a statusless player error. Not found by reading core — found because a client asked what core's deadlines were and the answer required opening the path.

**What landed.** `elementRunwayMs` splits into a reported figure and an aged one: `spentSince` subtracts time elapsed since the last player event, **but only while the viewer is playing**, because a paused element drains nothing and a pause long enough to have the session reaped is the common case here rather than the corner. `readAheadBytes` is aged the same way, against the same playhead. `forwardBufferMs` gains the guard `positionMs` already had, as `emptyBufferIsEvidence`: while a recovery is in flight, an element reporting no cover while also reporting that it is *playing*, not buffering and not ended is describing a state that cannot occur, so the last trusted figure stands, decayed. Outside a recovery nothing is about to spend the figure and the player is believed.

**Five tests, three of them seen red against code that lacked the specific half they pin.** Two pin the defect itself. Two pin its boundaries and passed before the fix, deliberately: a paused viewer's cover must not be spent (which a naive elapsed-time decay would break), and a `buffering` report must still be believed at once (which a naive guard would swallow).

**The fifth came from the web client and is the one worth keeping.** It asked what happens on a `source-gone` generation where that adapter deliberately does not tear down: as the element plays out its last buffer, `currentMs` passes the end of the final range, so `forwardBufferMs` is *genuinely* `0` while `readyState` stays at 4 for a beat and `buffering` has not flipped yet. **A real zero, in exactly the shape the guard distrusts.** It is harmless, and the reason is that the two halves of this fix are not independent: **a buffer that drained by being watched took exactly as long to drain as it was worth**, so the decayed trusted figure reaches zero at the same moment the true one does. The guard can only ever hold a figure the viewer has already spent. Pinned with a 40 s figure deliberately above the 26 s lead so the two behaviours differ — **verified red when `spentSince` is neutered** (it defers instead of building), which the first version of the test at 3 s did not do, because 3 s is under the lead and both branches build.

902 tests, typecheck and `lint:platform` clean.

**Both RN clients have been told**, because the event contract moved: an adapter that reports `forwardBufferMs: 0` during a recovery without also setting `buffering` is no longer taken at its word. **Both have checked their own source and both are clean** — the web client computes the field purely as a measurement and signals exhaustion through `buffering`; the Android TV client takes `buffering` from `expo-video`'s own `status === 'loading'` rather than inferring it from the buffer. Neither uses a zero as a request to give up.

**One gap the checking turned up, and it is now closed.** The web adapter has a Direct Play read-ahead cache on 453 of 748 titles and **had never emitted `readAheadBytes`** — it wired it the same day, from the worker's `aheadBytes` measured beyond `lastServedOffset`, absent rather than zero where there is no read-ahead so core's absent-means-no-cache reading stays true. **Worth passing to any host wiring the same field:** that client deliberately excludes it from its event dedupe, because it changes on every prefetch response and comparing it would turn the dedupe into a firehose on the path already moving the most bytes. The omission is commented as deliberate, because it reads exactly like a bug. Core's docblock says absence means the host has no read-ahead, never that it holds zero — so core has been reading that host as having no second cache rather than one it cannot see, on the path where the element buffer understates cover the most. The field's contract being undocumented is what had stopped them; that is settled now. **Core asserted they were already emitting it and was wrong** — a claim about another tree made without reading it, which is the boundary fault this file already records twice.

**Two halves. The first is the defect; the second is why the obvious fix makes it worse.**

**The runway is measured before two round trips and spent after them.** `recoverFromMissingSession` reads `this.runwayMs()` at `:2263`, which reads `elementRunwayMs()` at `:2521`, which takes `forwardBufferMs` from `this.snapshot.event` — the last event the player sent. On the terminal path that snapshot is already stale by however long the player has been dead, because `failNow` reaches `beginMissingSessionRecovery(fatalError, true)` at `:2129` and **a player that has stopped is a player that has stopped emitting**. Then `recoverFromMissingSession` *awaits* `sessionAlive()` — a full router walk with its own deadline — and only then compares `runwayMs > leadTimeMs` at `:2287` to decide whether to defer the replacement or build it now.

So the comparison is between a cover figure measured before the walk and a lead time that assumes it is current. **Three terms of staleness**, named by the client that hit them from the other side: time since the player stopped emitting, the adapter's own classification round trip, and core's `sessionAlive` await. Core is doing exactly the thing that client's probe budget exists to bound, and then deciding on pre-probe numbers.

**Which way it fails.** The runway only ever reads *high*, so core defers a replacement it no longer has the cover to defer, and the swap lands after the buffer it was pacing against has already run out. That is the stall the deferral exists to prevent, arriving through the mechanism that prevents it.

**The obvious fix — have the adapter emit a fresh event before it reports — is currently unsafe, and core already knows why.** `onPlayerEvent` is synchronous (`:711`, `:1854`), so an event emitted immediately before the failure listener would land in the snapshot first; the plumbing works. But `:1858-1871` records that **a tearing-down element can report a position of zero**, and guards `positionMs` with a forward-only rule through `lastObservedPositionMs` (`:1873-1876`). **That guard covers the position only, and only while a failover is in flight.** `forwardBufferMs` rides through untouched in the spread at `:1885`. So a player that zeroes its buffer on the way down writes `forwardBufferMs: 0` straight into the snapshot, `elementRunwayMs()` returns 0, and the decision goes to `no-cover` — spending precisely the buffer the deferral was protecting. **The unprotected field is the one a refresh would hand core.**

**The fix was core's alone and was not pushed onto hosts — this is what was built.** Emitting once more removes one term of three; the adapter's walk and core's own await remain whatever a host does. Core closes all three by re-reading the runway at the decision point rather than trusting a snapshot taken before two round trips — and needs the dying-witness guard on the buffer before that re-read is safe. A sentence in `docs/writing-a-player.md` would ask four hosts to each do something partial, only correct after core changes anyway, to fix what core fixes once. **That is Tom's rule failing in the direction that matters:** it is not required of nearly every conceivable client, it is required of core.

**Cross-checked rather than asserted.** The Android TV client read the same functions in its installed copy and reported the line numbers back before either of us acted; it has recorded that it will not emit, and why. Its own case is the same fault on a shorter path — a client reading a runway to bound a probe — and it has fixed its half with a test that fails without the subtraction.

### ~~Background discovery records real routing evidence~~ — BUILT on `develop` 2026-09-20, unreleased

**Waiting on:** a release. Nothing for a client to do: no signature moved and no host emits anything new.

**What landed.** `ClusterEndpointRouter.request` takes the `advisory` option `find` already had, and `ClusterStatusRouter`'s read path passes it. So the ten-second discovery call — and any status read a client makes for a diagnostics screen — records health through `recordProbeSuccess`/`recordProbeFailure` and leaves authority alone. A status timeout no longer un-sticks the endpoint the viewer's media is flowing through, and a status success on another node no longer steals preference from it. `mutation` (`checkConnectivity`) is untouched: it is a deliberate action on one node.

**Stronger than `find`'s advisory, and the asymmetry is deliberate.** There, an advisory *hit* records probe success but a failure still records a failure, because artwork is a real request a viewer is waiting on and a node that cannot serve it has failed real work. Nothing routed through the status path is waited on by anyone, so both directions use the probe variants. Said in the code, so the next reader does not converge them.

**Two tests, both seen red against the unfixed recording.** They are built so the cooldown and the preference are separable: the advisory walk fails on the authoritative node and succeeds elsewhere, the first assertion checks the failover happened *and* cost the node a cooldown — so the advisory path is not a no-op — and then the clock advances past that cooldown, at which point sticky is the only absolute axis left that can explain the order. With the probe variants swapped back for the real ones, both fail on exactly that last assertion. 903 tests, typecheck and `lint:platform` clean.

### ~~`close()` resolves while a failover `POST` is still in flight~~ — BUILT on `develop` 2026-09-20, unreleased

**Waiting on:** a release. Nothing for a client to do; no signature moved.

**The item as written overstated the fault, and reading both recovery bodies is what showed it.** It said the replacement session is created after close with nothing left to own it, holding the node's transcode entitlement for `session_idle`. It is not orphaned: both `recoverFromSourceFailure` and `recoverFromMissingSession` re-check `disposed` after the resolver call and stop what they built. The entry in the low register had been promoted on the strength of `close()` not awaiting `failoverPromise`, which is true, without opening the thing it fails to await — **exactly the inference this file records as fault 1**, made by me, on my own code.

**What was actually wrong, and is now fixed.**

1. **`close()` resolved while that release was still outstanding.** It awaited `startPromise`, `mutationLoop` and every `alternatePreparation`, and neither recovery promise. A host that tears down auth on the strength of `close()` resolving races its own `DELETE` — and a `DELETE` sent with a revoked token is the leak the item described, reached by a longer route. `close()` now awaits `failoverPromise` and `regenerationPromise` first. Nothing can start a new recovery from inside close: the failure channel is unsubscribed before the awaits and every entry point re-checks `disposed`, so those two promises are all there is.
2. **Those releases dropped the close options, `keepalive` among them.** `PlaybackRuntime`'s unload path sets `keepalive: true` because a `DELETE` issued as the document goes away is cancelled otherwise — and a session negotiated *during* the unload is the likeliest of all to be cancelled. The three disposal stops went through a bare `resolver.stop(id)`; they now share `stopOnDisposal`, which carries `this.closeOptions` and logs a failure as `recovered-session-close-failed` rather than swallowing it. That silent `.catch(() => undefined)` was the real thirty-minute leak in the item, and only on the unload path.

Also collapsed a duplicated `disposed` check in `recoverFromMissingSession`: two identical guards with nothing but a synchronous log between them, so the second could never fire.

**One test, both halves seen red separately.** It holds a failover open on a deferred, calls `close({ keepalive: true })`, spins fifty microtask turns — well past what the close path itself needs, so the assertion is about the await and not about scheduling — and checks `close()` has not resolved; then releases the failover and checks both sessions were stopped with `{ keepalive: true }`. Dropping the two awaits fails the first assertion; dropping `closeOptions` from `stopOnDisposal` fails the second. 904 tests, typecheck and `lint:platform` clean.

**`degrade()` not checking `failoverPromise` stays in the low register** and is still the bounded cousin: a redundant standby, churn rather than a leak.

### ~~Session manager: three mint/re-mint gaps `0.10.0` did not touch~~ — BUILT on `develop` 2026-09-20, unreleased

**Waiting on:** a release. Nothing for a client to do; no signature moved and no behaviour a host has to adopt. Item 4's remainder is still open and is the entry below.

**Taken together, as the item said to.** They are all the mint and re-mint paths, and two of the three had the same root: **a boolean cannot say which lifecycle a promise belongs to.** `stop()` sets `cancelled`, `start()` clears it, so work cancelled by the `stop()` *inside* `start()` sees the flag false again by the time it lands. There is now a `generation` counter that only ever moves forward, moved by every `stop()`, and `abandoned(generation)` replaces the bare `cancelled` checks in `adopt`, `mintNow`, `bootstrap` and `scheduleRefresh`.

1. **`authorization()` no longer hands out a rejected token.** `fetch` drops the token before asking for a replacement, rather than leaving it to be overwritten when the mint lands — `authorization()` answers from `this.token` and only waits when it is undefined, so the old shape handed a native player the one token a node had just refused, for the whole length of the re-mint. The doc on `authorization()` now states the guarantee it keeps.
2. **A restart mid-bootstrap contacts the new registry.** `bootstrap` and `mint` coalesce only within a generation, so an in-flight run against the registry just replaced is no longer returned as this start's own answer; and the abandoned run cannot adopt its session or clear its successor's `inFlight` handle when it finally lands.
3. **Timers are replaced, not overwritten.** Both sites now go through `armTimer`, which clears whatever was pending. A retry timer armed over a refresh timer used to leave the refresh running with nothing able to cancel it, since `stop()` clears only the handle it can still see.

**Three tests, each seen red against its own defect and only its own.** Neutering the token drop fails the first with `'Bearer token-a'` where the test wants a pending promise; restoring the generation-blind coalescing fails the second with one mint where two are owed; removing the `clearTimeout` from `armTimer` fails the third with two pending timers where one is owed. 907 tests, typecheck and `lint:platform` clean.

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

### ~~A storage write error kills the health loop silently~~ — BUILT on `develop` 2026-09-20, unreleased

**Waiting on:** a release. Nothing for a client to do.

**Both halves, as the item said to pair them.** `runCycle` wraps `persistConfirmedEndpoints` in its own `try`/`catch` and logs `discovered-endpoints-not-persisted`, and the reschedule has moved into a `finally` that arms unless the controller was aborted — so the loop surviving no longer depends on the body having succeeded. `EndpointRegistry.notify()` isolates each listener and logs `endpoint-listener-failed`, the posture `publishConnectionState` has always taken; it also copies the set before iterating, since a listener may unsubscribe itself on delivery.

**Two tests, and the first needed both guards removed before it went red — which is the point.** With only the inner `catch` removed it still passed, because the reschedule was inside the `try` and nothing threw past it; with only the `finally` removed it still passed, because the `catch` swallowed the throw. Restoring the original shape — no inner catch, reschedule in the body — fails it at `expected 2 to be greater than 2`: the loop stopped probing. The listener test rejects with the host's own error when `notify` is left unguarded. 909 tests, typecheck and `lint:platform` clean.

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

### ~~`GET /api/v1/users` envelope — core is already right, the comment will not be~~ — BUILT on `develop` 2026-09-20, unreleased

Comment rewritten: `items` is the envelope, `users` is legacy and kept **because a node may be stranded on an older build** — the reason is in the comment, so the branch is not deleted as dead later. The lookup order follows, current envelope first. No behaviour change; `userList` already accepted all three shapes and still throws `invalid_user_list` on anything else.

**Loose end, unchanged:** the operator reported an accept-either shim in a client. The web client checked and it is not there. It is sitting unremarked in one of the other three trees, and a client that hand-handles a wire format will not notice the next change either.

### ~~Playback must be stopped before sign-in and sign-out, and nothing says so~~ — BUILT on `develop` 2026-09-20, unreleased

`signIn`'s doc comment now carries the obligation `signOut`'s already did, with the cost stated: a session created under the old identity cannot be closed once the token changes, so the node holds its transcode entitlement until `session_idle`, thirty minutes, and on a one-slot node the next viewer gets `429 resource_limit` with nothing pointing at the client that caused it. Invisible from the client that causes it, which is why it is said here.

### Smaller correctness items
**Waiting on:** core. **Three of five built on `develop` 2026-09-20, unreleased.**

- ~~**README seeding snippet defeats discovered-endpoint persistence.**~~ **BUILT.** The snippet seeds the two sets under their own sources — `bootstrapEndpoints(configuration.discoveredEndpoints(), 'discovered')` — so `persistConfirmedEndpoints` has something it is allowed to persist. The round-trip test the entry asked for is in `EndpointHealthMonitor.test.ts` and fails against the old snippet with `expected [] to deeply equal ['http://10.44.1.51:7438']`.
- ~~**An emptied bootstrap set is persisted and treated as configured.**~~ **BUILT.** `setBootstrapEndpoints([])` removes the key, as `setDiscoveredEndpoints` always has, *and* `bootstrapEndpoints()` reads a stored empty list as absent — written as absent is not enough on its own, because a client may already be carrying one from a build that wrote it. Two tests, both red against the old shape.
- ~~**`ClusterPlaybackFactsApi` records per-title faults as endpoint evidence.**~~ **BUILT.** `:63-67` now carries the `!isPerTitleFailure(error)` guard `ClusterPlaybackResolver.create` has, so one unreadable extent no longer demotes the node for every title on it.
- **`TorrentJob.catalogue` is declared required but version-gated.** `api/AcquisitionApi.ts:72`, "since 0.28.1", and the package supports mixed-version endpoint sets with no runtime check. Make it optional; absent stays absent. **Held deliberately:** widening a required field to optional is a compile break in every consumer that reads it, so it is not internal work and wants to go out with whatever else moves that type, announced rather than discovered.
- ~~**Success bodies are assumed to be the envelope.**~~ **BUILT on `develop` 2026-09-20, unreleased.** One shared `envelopeArray` in `httpCompat.ts` — the file where every family already reads a success body — checked at the three collection sites (`items`, `jobs`, `items`), plus a `SyntaxError` guard in each family's `request`. Both now throw that family's own typed error with `502` and `invalid_response`. **502 is deliberate and stays retryable:** in a mixed-version endpoint set the next node may answer a shape this build can read, which is what being generous about envelopes exists for, and `invalid_media_profile` has taken the same position since it was written. The old behaviour was worse in both directions — a raw `SyntaxError` carries no status, so an HTML 200 from a captive portal was non-retryable and "Unexpected token <" reached the viewer; a `TypeError` at `.map` was read as a *transport* failure, so a schema mismatch cooled the node down as though it had been unreachable. Four tests, one of them asserting the classification through `retryableEndpointFailure` rather than assuming it.

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

### ~~`find` cannot distinguish absence from partial failure~~ — BUILT on `develop` 2026-09-20, unreleased

`find` takes an optional `onAbsence` callback, called only on the way to answering `undefined`, carrying `attempted`, `absent`, `failed` and `unanimous`. The return is unchanged, so every caller that does not care is untouched — the deliberate behaviour the entry defends (optional metadata must not be blocked by an unrelated node failure) stays exactly as it was.

The caller that cares is the media profile: an absent one makes the chooser transcode everything, silently, so `readMediaProfile` now logs `media-profile-absent` at `debug` when every node answered absence, and `media-profile-absent-after-failure` at **`warn`** when it did not — with which nodes were absent and which failed. The decision is the same; what changed is that a capture can say whether it was made on a complete answer. One test, both halves, red when `unanimous` is stubbed true.

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

**~~What is blocking that work: there are three `FakePlayer` implementations.~~ MERGED on `develop` 2026-09-20, unreleased.** There is now one, `src/testing/FakePlayer.ts`, and both local copies are gone. The header records what the split cost — a round of "prove the test fails against the broken code" that ran green every time because the code it was meant to break was never the code under test, and a good test deleted on the strength of it.

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

### The adapter stops tearing down — IN SCOPE, built on both sides, one publish

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

- **Re-verify the stall is gone.** Neither run reached a swap, so the 5.16 s is still only known to be fixed in a fake.
- The look-ahead question — whether a generation held for a minute is still being produced — remains unanswered for the same reason. Watch for `source-not-found-on-live-session` **after** `replacement-swapped-in`.
- Nothing has met a node in the *node-unreachable* case. The client has a repro that collapses the thirty-minute wait — pause through the UI, `DELETE /api/v1/playback/sessions/<id>` on the owning node, resume — and verifies through a **temporary `file:` link to this tree**, then unlinks. Core's `dist` is built and current, so the link sees all of it today.
- The web client's half is **written and proven live**, and its tree deliberately does not typecheck — four errors, all `SEGMENT_NOT_READY_STATUS` / `SOURCE_NOT_FOUND_STATUS` / `'not-found'` not existing in the registry copy of core. That is the honest state and it was waiting on a real version number, not on more work; `0.13.0` and `0.14.0` have both shipped since, so this is closed unless that tree says otherwise.
- **A trap for whoever links next, which cost the client a cycle.** Vite pre-bundles dependencies into `node_modules/.vite/deps` and swapping the symlink underneath does **not** invalidate it: the browser threw `does not provide an export named 'SEGMENT_NOT_READY_STATUS'` against a cache built from the registry copy while `node -e` in the same directory resolved the linked tree correctly. `rm -rf node_modules/.vite` and `vite --force`. This is the "a swap can silently not happen" failure one layer below the one already on record.
- The resume-time probe after a long pause. Optional, and correctness does not rest on it.
- ~~`HISTORY.md`'s release table gets a row when this actually ships.~~ **Done** — `HISTORY.md:135` carries the `0.13.0` row. It is `0.13.1` and `0.14.0` that have none, and they should.

**Method note worth keeping.** Every test here was seen red against the unfixed code before being kept, including the ones that assert an *absence* — those failed at `HEAD` because the probe they wait for never happens, rather than passing vacuously. That check was worth running: it is the trap `FakePlayer`'s comment was written about.

---

## Low — the register

Verified, each real, none urgent. Grouped by area so a session cleaning one area can take the set.

**Line numbers here were re-anchored against `develop` on 2026-09-19 and will rot again.** `PlaybackCoordinator.ts` grew from roughly 1,400 lines to 2,643 across `0.13.0` and `0.14.0`, and every citation into it moved by hundreds of lines while the defects themselves stayed exactly where they were. The ones below were re-read; a handful of the shorter files were not, and are marked where that is true. **Treat a line number as a hint and the symbol name as the address** — if they disagree, the symbol is right.

**Coordinator and playback**
- ~~`PlaybackCoordinator.ts:1688` (and the silent direct promotion above it) — both promotion paths record the endpoint failure and then call `resolver.stop()` on the same node~~ **FIXED on `develop` 2026-09-20.** `PlaybackStopOptions.endpointAlreadyCharged` is the seam the entry said was missing: `ClusterPlaybackResolver.stop` neither records a failure nor keeps the provenance entry when it is set, so one observation charges the node once and a throwing DELETE cannot walk the cooldown ladder on its own. Both promotion paths pass it; three existing assertions moved to the new call shape.
- `PlaybackCoordinator.ts:1542-1582` — `degrade()` does not check `failoverPromise`, so a degradation during failover POSTs a redundant standby on a third node. Churn, not a leak.
- `failNow`'s `failoverPromise` branch is **shadowed**, found 2026-09-20 while covering it. `beginSourceFailover` independently refuses to start a second failover, and the whole 935-test suite passes with the `failNow` branch removed — its only unique effect on current code is its `debug` line, and a corner where `snapshot.session` and `serverSession` are both absent mid-failover, which nothing produces. **Keep both**: they are different intents that happen to coincide, and the `failNow` comment records a measured 82-second viewer loss. This entry exists so nobody removes `beginSourceFailover`'s guard believing `failNow` still covers it — it does, today, and only today. Its twin on the degradation channel is the entry above.
- `testing/FakePlayer.ts` — `setVolume()` is declared with **no parameters** and discards the level, so no test anywhere can assert what was applied. The `setVolume` docblock records two occasions when applying a level was confused with persisting one, which makes an unobservable level the wrong gap to leave in the one shared double. **Not widened yet because `FakePlayer` ships on the `./testing` export**: adding a parameter turns `() => void` into `(volume: number) => void`, and a client calling `player.setVolume()` bare would stop typechecking. Do it with a release that carries a note, alongside `detach()` now stopping.
- `PlaybackCoordinator.ts` — **`snapshot.instruction` goes stale on a viewer mode change.** Found 2026-09-20 while building the substitution detector, which had to route around it. `instructedPreferences` patches the report from `startInternal` and from `queueChosenInstruction` (the Auto path), and `applyDegradedInstruction` patches it on a step down — but a plain `update({ preferences: { mode } })` patches nothing. So after a viewer switches from transcode to remux the report still says `transcode`, with `chosenByViewer: false`. A host rendering the instruction notes shows the wrong mode and attributes it to the chooser. Small, real, and the reason `modeHonoured` compares against the node's echo rather than against this.
- `PlaybackCoordinator.ts:1765` — the transcode standby window is keyed on `alternate.mode === 'transcode'`; if the entitlement is video-only, `transform.video === 'transcode'` is the precise test. The 8 s comment records the slot cost but not the quantity it must exceed.
- `PlaybackCoordinator.ts:1712-1756` — there is a disposed/revision re-check after the awaited `prepare` (`:1726`) but none after the preflight that follows it.
- ~~`PlaybackStatus.ts:12` — header says "only ever from `output.container`" while the code falls back to `output.format`.~~ **FIXED on `develop` 2026-09-20.** The header now says what the body does — the server's own account of what it produced, container or format, never the request.
- `MachaPlaybackResolver.ts:332`, called at `:407` — `reconcileQualityCaps` runs on `resolve()` but not `update()` (`:430`, verified: one call site), against its own doc. The "skips remux" half is not obviously true of the body at `:335-340` and was not re-verified; check before acting on it.
- `MediaTechnicalProfile.ts:21-23` — ~~dead ternary with identical branches~~ **FIXED on `develop` 2026-09-20**: both shapes spell `level` the same way, so the ternary chose between an expression and itself. Still open: `MachaPlaybackFactsApi.ts:45` passes `dolby_vision_profile: 0` through where the other normaliser treats 0 as "not probed".

**Cluster and routing**
- `EndpointRegistry.ts:185` (`ABSOLUTE_AXES`, and the doc at `:174-177`) — sticky is checked before the both-cooling order, so a sticky node on a 30 s cooldown is walked before a non-sticky one on 0.5 s.
- `EndpointRegistry.ts:49,72` — capacity never expires; `observedAt` is declared on both records, written, and read by nothing (verified 2026-09-20: the only two occurrences are the type fields).
- `EndpointHealthMonitor.ts:136` + `EndpointRegistry.ts:495` — capacity keyed by `api_endpoint` string, so a typed IP versus an advertised hostname yields the same node twice and the in-use bootstrap entry never gets capacity.
- ~~`EndpointRegistry.ts:713-715` — `notify()` does not isolate listeners~~ — **moved into the P1 health-loop item**, where it belongs with its twin.
- ~~`EndpointHealthMonitor.ts:186-226` — no abort check after `stop()`~~ **FIXED on `develop` 2026-09-20.** `discoverClusterEndpoints` takes the signal and checks it after the status call, the same rule the cycle applies either side of the probe walk. Test red without it.
- ~~`EndpointBandwidth.ts:17-20,124-126` vs `EndpointRegistry.ts:101,563` — restore re-enters at one sample, threshold is two~~ — **folded into *The throughput axis may never have ranked anything* in P1**, which is where it stops looking harmless. `EndpointRegistry.test.ts:266-269` pins the current behaviour.
- `EndpointHealthMonitor.ts:69,164,235` vs `serverConnection.ts:41-44` — a proxy's bodiless 502/503/504 counts as reachable and clears the outage state forever.
- `EndpointRegistry.ts:85` vs `EndpointHealthMonitor.ts:10` — the cooldown ladder (500 ms, 2 s) is uncalibrated against the 10 s probe interval; a probe-failed sticky node is "ready" 0.5 s later. Neither constant records the relation. *This is the same class `hlsWalk` and the stall budget were fixed for: assert the inequality, not the number.*

**API layer**
- `ClusterCatalogueApi.ts:27` — `ARTWORK_ENDPOINT_TIMEOUT_MS = 8_000` exactly equals the inner `DEFAULT_REQUEST_TIMEOUT_MS`, so which error the caller sees depends on timer ordering.
- `ClusterCatalogueApi.ts:51-63` — a not-ready catalogue synthesises a 503 that cools down a node that answered.
- `AcquisitionApi.ts:91-104`, `ManageApi.ts:114-128` — no `AbortSignal` on these families, so a polling screen that unmounts still walks every candidate. `MachaAcquisitionApi.request:107-108` also lacks the 204 handling Manage has.
- `src/connection/connectionConfiguration.ts`, `MachaManageApi.ts:32,71` — `cache: 'no-store'` relied on alone, against `platform-neutral.d.ts:108-125`. *Candidate cause for a client reporting stale node versions — candidate, not cause; nobody has verified it.*

**State, runtime and docs**
- ~~`state/continueWatching.ts:163` — the one store that validates only `Array.isArray`~~ **FIXED on `develop` 2026-09-20.** Entries are validated too, and a bad one is dropped rather than the list discarded: the rest of the history is still true, and refusing all of it costs the viewer more than the entry that is wrong.
- `state/musicPlaylist.ts:26` — `MusicPlaylistStore` still exported after being superseded by `PlaylistStore`, which adopts its key on first read. Against the hard-cuts rule. **Delete it** — and note `0.11.0` proved the sequence for this: clients take a copy first if they have one, then core removes.
- ~~`runtime/configuration.ts:165-183` — the self-healing write sits inside the read's `try`~~ **FIXED on `develop` 2026-09-20.** The tidy-up goes through `healEndpointValue`, which swallows its own failure: a full store refusing the rewrite no longer deletes endpoints the read had just parsed. Test red without it.
- `runtime/configuration.ts:224` and `api/httpCompat.ts:103` — `normalizeUrl` and `normalizeBaseUrl` are the same four lines under two names. **Duplication to delete before it drifts, not a correctness bug** — verified across nine input shapes.
- ~~`docs/examples/headless.mjs:63-68` passes `serverApi` to `EndpointHealthMonitor`, which has no such option.~~ **FIXED on `develop` 2026-09-20.** It passes `auth` instead, with a line saying why there is no `configuration` in a host that persists nothing.
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
