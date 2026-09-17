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
6. **Prescribing a change to a client's repo from here.** *The clearest lesson of 2026-09-15, and it went wrong three times in one afternoon.* Core knew one true thing — the package moved to npm — and turned it into blanket instructions about trees it cannot see. Every one was wrong in a way only the client could know:
   - *"Replace your prefix test with `isMachaStorageKey`"* — would have dropped `macha.clientId.v1` at hydration on both RN clients, giving a fresh client id on every cold start and orphaning Continue Watching, the queue, the playlists and the music library. Silent cold-start data loss, and a **larger version of the incident that function exists to prevent**.
   - *"Delete your `pretest`"* — the Android TV `pretest` ran two things, and only one was core's. The other, `version:check`, exists because five builds shipped as `versionCode 1` and the television could not tell them apart. Deleting it wholesale would have reopened that.
   - *"`rm package-lock.json` and regenerate"* — right for one client, wrong as a default: a regen drifts every transitive dependency and puts a second variable in the commit under review.

   Two of the three were caught only because a client checked rather than complied — one by making the change and watching its test fail. **Core may report what it knows about its own package and nothing further: what is published, what is verified, what changed.** What that means inside a client's tree is the client's to determine. The same rule as not clearing another operator's work, one level down.
7. **Grepping core's barrel to ask whether a symbol is exported.** `src/index.ts` is **62 `export * from` lines and nothing else**, so a grep for any symbol name returns zero while a runtime import resolves all 183. The Android TV client ran exactly that check on the installed `0.12.0`, got zero for `SessionNotStartedError`, and was one message away from reporting that the replacement error was not importable — a false defect, in a release where every client had been asked to check its 401 handling. It caught itself with `import()`. **Ask the module system, not the file.** `node -e "import('@machafoundation/core').then(m => console.log(typeof m.X))"` is the instrument.
8. **Taking a green client as evidence when it is structurally incapable of the failure.** *Named by the Android TV client, 2026-09-15, after it happened twice in one afternoon.* The web client reads `localStorage` through synchronously, so it **cannot** show a read-time migration failing against a caching host. A browser tab does not background as a television app does, so it **cannot** show a session lifecycle transition. Both times the green client was green because the fault was unreachable there, not because it was absent. **This is an argument about what evidence a release needs, not about who is careful** — and it decides who gets a prerelease first. Ask which platform can actually exercise the fault before counting a pass.
9. **Ship a seam to a client before releasing it.** On 2026-09-13 the Android TV client swapped onto `hlsWalk` and **three of its four findings came from the swap rather than from reading the code** — including one that would have destroyed every warm standby on that platform, silently. A client porting onto shared code is a cheap fuzzer for the assumptions in it. Land the seam, name it to a client, let it swap, fix what the swap finds, *then* tag.

**Two further habits that paid on 2026-09-13.** Writing a refactor brief surfaced a live core defect before anyone ported — a client compared it against the shape of its own state machine and found the ready-flicker. And a client verifying core's *output* rather than taking core's word found four things nothing else would have: a stale `dist`, an orphaned build artefact, a mid-rebuild collapse, and a shipped comment contradicting the commit that acknowledged it. **Amended 2026-09-15:** the habit is right and the example has largely expired — three of those four were failures of the `file:` link itself and cannot occur against an immutable tarball. Verifying output rather than taking core's word is still the point; the stale-link finding on the day of the npm move is the current example, and it is a better one.

**The rule that settles most boundary questions** (Tom's): *would nearly every conceivable client be required to do this? If yes, core. If not, theirs.* And the one that settles most design questions: no component may assume another is live or healthy, and a dying component's evidence is not evidence.

---

## Client adoption of `0.12.0`

**Adopted and tested is not ported** — that distinction is the web client's and it is worth keeping. A third column is now needed: *how* a client resolves core, because "on core" stopped meaning one thing on 2026-09-15.

**The web row was wrong until 2026-09-17** and said `^0.11.1`: that client's `package.json` had moved to `^0.12.0` and this table had not. It was caught from the other side — the client read its own range while checking what core exported and found both its own TODO and this one stating the older figure. **The other two rows are unverified**, not confirmed; nobody has read their `package.json` since. Ask the client, do not infer it from here.

| Client | Resolves core by | Suite | Ported |
|---|---|---|---|
| Web | **npm `^0.12.0`** — released as `macha-client` 0.17.1, no link | 46 files / 335 | **no** — `AccountMenu.signOut` onto `sessionManager.signOut()`, `lastIdentityChange` unsubscribed |
| Android TV | **npm `^0.11.1`** — renamed, no link, `expo export` green | 11 files / 159 | **no** — `secureStorage` **not supplied**; token in app-private storage |
| Phone | **npm `^0.11.1`** — renamed, 38 imports, no link | 12 files / 90 | **no** — `secureStorage`, `lastIdentityChange`, `signOut`, `probeNow` |

**All three clients are on `0.12.0`, verified against the published tarball.** Web: refactor landed, 338 tests, fresh-clone acceptance. Phone: migrated, 100 tests, `expo export`. Android TV: installed, 166 tests, 841 modules, and the Hermes bundle byte-identical between working tree and fresh clone.

**But the release's central fix is unverified, and no automated check can verify it.** The `memoryStorage` capture typechecked, bundled, and passed a green suite while a viewer lost their configured endpoint on every restart. So a green suite on `0.12.0` says nothing about whether the getter actually fixed it. **That needs a device session on the television:** set an endpoint in Settings, force-quit, relaunch, confirm it survives; confirm `macha-client-id` reaches AsyncStorage for the first time; confirm the trail shows `throughput-unavailable / insufficient-samples` rather than `no-bandwidth-store`, which would mean `attachBandwidth` never ran.

**Gated on Tom**, because the Settings focus defect gates the failure trail those diagnoses are read from. The Android TV client declined to report "verified" without it — correctly, and citing this file's own rule about green clients back at itself.

**One consequence to state rather than discover:** existing Continue Watching and queue data on that client is orphaned by the fix, because those stores were keyed by the per-launch memory id. Nothing is lost that was not already being lost on every launch.

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

1. ~~**Web client.**~~ **Done** — released as `macha-client` 0.17.0, verified from a fresh clone with no `macha-ts` on disk.

**Tom, 2026-09-15, asked directly by the Android TV client whether to take the rename or stay on its Settings focus defect: _"Rename now, this is more important."_** That reverses the order that client had chosen, which had put the Settings focus work first. It was right to hold for his answer rather than take core's word: a 62-reference rename plus a lockfile regeneration in its own repo is its operator's call, and **core telling a client "you are clear to proceed" does not clear it** — core can report that a package is published and verified, and nothing more. Its facts were checked independently on its side before it reported, which is the correct handling of a relayed claim.
2. **Phone and Android TV**, on Tom's word. Dependency key, every import, and a regenerated lockfile in each. Android TV additionally runs an `expo export` — see the Metro note above.
3. **Tizen last**, since it shares the web build.

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

## Decided 2026-09-15 — the next release

Five decisions from Tom, in one sitting. **All five ship together**, and two of them require every client to change.

**None of this exists for any client until it is published.** `0.11.1` is what npm holds and what all four clients run; these decisions live only on `develop`. **A commit is not a release and a git tag is not a release** — `0.9.0`, `0.10.0` and `0.11.0` are the worked example, tagged here and never on the registry. No client should code against any of the five, and `npm view @machafoundation/core versions` is the only honest answer to "what can I have". All three have been told.

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

## P0 — a paused session is reaped and core does not notice

**Built on `develop` 2026-09-17, unreleased, and it is half a fix until it is published.** Found by the web client, reproduced live twice, fixed in core and in that client together.

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

**Still to do.**

- **Publish.** The web client's policy layer is built and cannot be wired until the `not-found` literal exists in a published core: its dispatch currently falls through to `unknown`, which *is* endpoint-retryable, making its working tree strictly worse than `0.17.1` for this case. It is uncommitted and contained, but it is blocked on core.
- The resume-time probe after a long pause. Optional, and correctness does not rest on it.
- Nothing has run against a real cluster yet. The client has a repro that collapses the thirty-minute wait — pause through the UI, `DELETE /api/v1/playback/sessions/<id>` on the owning node, resume — and will link `../macha-ts` once, verify, and unlink.

**Method note worth keeping.** Every test here was seen red against the unfixed code before being kept, including the ones that assert an *absence* — those failed at `HEAD` because the probe they wait for never happens, rather than passing vacuously. That check was worth running: it is the trap `FakePlayer`'s comment was written about.

---

## Waiting on Tom

- ~~**The package alias split.**~~ Decided 2026-09-15: `@machafoundation/core`, because `@macha` is an unclaimed scope and `@machafoundation/core` is already published and owned. See *Moving the clients onto public npm* above.
- **Coverage.** Deferred 2026-09-13: *"not at this time, we'll update later."* Re-measured 2026-09-15 and the cheap half taken; see *Coverage: what is done and what is left* below for where it now stands and what the rest costs.
- **Does `macha.volume.v1.` stay in the storage registry?** `0.11.0` deleted `VolumeStore`, so **nothing in core writes that key any more**, but it is still listed in `MACHA_STORAGE_KEY_PREFIXES` — surfaced by the new registry test, which drives what core writes and cannot speak to what it no longer writes. Both answers are defensible and they are not the same: *keep it* and hosts clearing Macha data through `isMachaStorageKey` still collect the value core left on every device that ran `0.10.0` or earlier — but then the file's opening line, "every storage key this package **owns**", is no longer quite what the list means and should say so. *Drop it* and the registry stays honest, but a value core wrote is orphaned on every existing install and a host enumerating keys reads it as someone else's. **Leaning keep**, with the doc amended to say the list includes keys core has retired but still owns — the same reasoning that keeps `macha-client-progress:` listed. Cheap either way; it just needs deciding before someone deletes it as dead.

---

## P1 — correctness

### A failover from an `https` page dies on a plain-`http` node, and core cannot see the scheme

**Waiting on:** Tom for the shape, then core. **Opened here 2026-09-17 on the web client's evidence.** It had been carried in *that* client's `TODO/ACTIVE.md` as "both items are core's" and never opened here, so core did not know it existed. Recorded because it is the second time a finding has lived in one tree while the repo that owns the fix had no entry for it — **saying "this is yours" in your own file is not telling anyone.**

`EndpointRegistry.candidates()` ranks on health, stickiness and throughput. It has no concept of whether a candidate is *reachable from where the page is*. A client served over `https` cannot fetch `http://10.35.1.50:7438` at all — the browser refuses it as mixed content before any request goes out — so every failover from an `https` deployment onto a plain-`http` LAN endpoint dies, and dies as a transport error indistinguishable from a node being down.

**Kept separate from the P0 above on purpose.** It is what made the reaped-session failure *look* like a node problem: the screen named the `http` node the failover had just tried, so the report went to a machine that was never involved. Conflating them is how a day was spent in the wrong place, and merging them here would repeat that.

**The shape, and why it is not simply "filter by scheme".** Core is no-DOM by construction — `npm run lint:platform` is the gate — so it cannot read `location.protocol`, and it must not sniff. The fact has to arrive from the host, which makes this a contract question rather than a filter: something like a stated page scheme on `MachaHost`, or an eligibility predicate the registry consults. Both are public surface. **Do not implement before the shape is settled**, and note the constraint that makes it awkward: the same endpoint list is correct for a React Native client, which has no page scheme at all and can reach both.

### Session manager: three mint/re-mint gaps `0.10.0` did not touch
**Waiting on:** core. `src/api/SessionManager.ts`. **Take them together — they are all the mint and re-mint paths, and fixing them twice would be worse than once.**

`0.10.0` rebuilt the *model* around these and deliberately did not fix them; they are still live.

1. **`authorization()` hands out the dead token during a reactive re-mint**, because `mint()` never clears the rejected token. The doc on `fetch()` claims the opposite.
2. **`start()` during an in-flight bootstrap adopts the old registry's result** and never contacts the new one; `mintNow` then reports the corrected config as unreachable. The doc "safe to call again if the registry changes" is false in that window.
3. **Refresh timers overwritten without clearing**; `stop()` clears only the last.
4. **`fetch()` promises to wait for the mint and only waits when one is already in flight.** *Added 2026-09-15, measured on the deployed web client.* `fetch():439` reads `if (this.token === undefined && this.inFlight) await this.inFlight;` — but **before `start()`, and after `stop()`, there is no `inFlight`**. So the request goes out with no `Authorization` header, the node answers 401, and `sent === undefined` at `:442` returns it unretried. A caller that read the contract and did not remember to wait gets exactly the 401 it was promised it would never see. `authorization():434` has the identical shape.

   Measured: `instruction-facts-failed — "Macha playback facts failed: a valid session bearer token is required"` **18 ms after load**, on a reload straight into a player URL. The viewer got a broken video.

   **The fix depends on what a stopped manager should mean, so it is Tom's:** mint on demand when a registry is present, which would make the documented contract true; or refuse outright, which is at least honest. Either beats sending a request guaranteed to 401. **At minimum the doc must stop promising what the code does not do** — a client read that promise and built on it. Note this compounds with the known low-register item that `fetch()`'s JSDoc is attached to `authorization()`, so the promise is not even adjacent to the method that makes it.

### The chooser decides with no facts, and the guess reaches the viewer as a corrupt file
**Waiting on Tom** — a decision, not a patch. `src/playback/choosePlaybackInstruction.ts:324-329`, `:373`. *Measured on the deployed web client 2026-09-15.*

With the facts call failed, core logged `instruction-facts-failed`, then `instruction-without-facts`, then chose anyway:

    instruction-chosen  mode: direct, video: copy, audio: copy,
                        reasons: ["source-plays-as-is"], assumed: ["hlsVideoCodecs"]

The viewer got `MEDIA_ELEMENT_ERROR: Format error` — **which reads as a broken file rather than as "the client could not ask what this file is"**. The same title plays correctly when facts are available.

**The design question, which is the web client's and is the right one:** `assumed` is built at `:324-329` from missing *capability* fields — `operations`, `hlsVideoCodecs`, `hlsAudioCodecs`, `hlsTs`, `videoBitDepth`. That is "the device did not tell us one thing about itself". It is **not** "we have no idea what this file is", and the two are being expressed by the same mechanism. Should `assumed` ever cover the absence of *facts* rather than the absence of a single capability?

**This is squarely core's.** The chooser lives here precisely so every client decides the same way from the same facts — and here it decided from none. A warning in a ring buffer is not a degraded mode a viewer can act on. Holding for the facts, or failing with a message that says what actually went wrong, both look better than guessing; which one is Tom's call.

**Reachable by any client**, not just the one that found it: a node 500ing or a network blip on the facts call gets here, and neither is a client bug. The web client separately fixed the trigger it owned — a `0.16.0` regression where route reconstruction started playback ~700 ms before an endpoint existed — but that gate only closes the path it opened.

### The throughput axis may never have ranked anything, anywhere
**Waiting on:** core to decide the shape, and on two clients for evidence. `src/cluster/EndpointRegistry.ts:258-264`, `:576-579`, `:113`; `src/cluster/EndpointBandwidth.ts:126`.

**Three things already known separately, which are one thing together.** The phone client supplied the missing third by reporting that it wires no `EndpointBandwidth` at all — `new EndpointRegistry([])`, third parameter omitted — and core's own low register already held the other two. Verified here rather than taken:

For throughput to rank anything, a host must do four things and **core does none of them for it**:

1. construct an `EndpointBandwidth`;
2. pass it as the optional third constructor parameter — **omit it and the axis silently disappears** (`:261`, `bytesPerSecond():576-579` returns `undefined`);
3. call `record()` on it — **nothing in this package ever does**; and
4. do so at least twice *in the current session*, because `THROUGHPUT_MIN_SAMPLES` is 2 (`:113`) while `EndpointBandwidth.restore()` re-enters a persisted record at `samples: 1` (`EndpointBandwidth.ts:126`) — one short, so **throughput restored from storage never ranks on its own**.

**None of that is visible from the call site**, and throughput is the axis the cascade reads as primary: it outranks latency. Degrading to latency when an axis has no evidence is correct behaviour, which is exactly why nobody noticed.

**Two of three clients wire nothing at all.** The Android TV client verified all four claims independently against the `0.11.1` tarball rather than taking them from core's message — `EndpointRegistry.d.ts:113`, `EndpointRegistry.js:447` and `:449`, `EndpointBandwidth.js:116` — then found it constructs `EndpointRegistry` with one argument and has no `EndpointBandwidth` and no `.record(` anywhere. The phone client is the same. So on both React Native clients the throughput axis has never ranked anything, and that is now checked rather than inferred.

**That inference was wrong and is retracted.** I wrote that if no client completed all four steps, throughput had never decided anything anywhere. **The web client completes all four** — verified in its tree at `App.tsx:299-319` and `:328-339`, with *two* feeds into one recorder: API/JSON bytes through core's `readJsonBody`, and media bytes from the Direct Play read-ahead worker. It added the second after an afternoon spent streaming from the slowest node it had, because the record until then described only JSON. So the wiring gap is real on the phone client and **not universal**. Android TV has been asked and has not answered.

**What replaced it is better, and it came from measuring rather than reading.** The web client instrumented the deployed client against the real cluster for 26 minutes of real use including playback:

    uptime        1,576,787 ms
    probe cycles  155
    decidedBy     { sticky: 155 }
    swaps         []

**Fully wired, fully fed, and throughput still ranked nothing** — because the preferred endpoint never came up for reconsideration. The sticky check short-circuits the cascade before any measured axis is reached (`EndpointRegistry.ts:397-407`, already in the low register for a different reason), and the only path that can dislodge a sticky preference is `evaluatePreferredSwap`, **whose gates are latency-only**: 200 ms absolute *and* 40% relative improvement, sustained 3 consecutive cycles, with a 60 s cooldown (`:102-108`).

**So the open question is sharper than a wiring audit.** If that reading is right, throughput cannot dislodge a sticky endpoint *by any amount*, and its documented precedence over latency applies only to a first pick or to a cluster with no healthy preference. **Not yet verified** — I have read the constants, not `evaluatePreferredSwap`'s body, and the web client's `swaps: []` is consistent with both "never reached" and "reached and correctly declined". Three nodes where one is plainly right is exactly when stickiness *should* hold, so this is not evidence of a defect. A measurement has been requested that would separate the two.

**The cross-client consequence is confirmed rather than hypothetical, and it bears on how this project has been reasoning all day.** The web client wires the full cascade; the phone client wires none of it and ranks on latency. **They have been ranking on different axes against the same cluster.** So any comparison of which node each selected measures their wiring rather than the cluster's behaviour — and several conclusions here have come from exactly that kind of cross-client comparison. Ask what a client wires before comparing what it chose.

A note at the constructor now states what is lost by omission and the four steps. That replaces the three scattered low-register entries, which were each true and individually unalarming.

**The design question, and core's own boundary rule answers it.** The Android TV client put it best: *if nothing in core ever calls `record()`, the parameter is not an integration point, it is a hook with no documented caller.*

And core is not short of the ingredients. **`httpCompat.ts:117-146` already measures every transfer** — `readJsonBody` times the body, counts the bytes, and hands both to a `TransferRecorder` a host installs globally. Core therefore already owns the measurement, the registry, and `EndpointBandwidth`. What it asks the host to supply is the *wiring between three things core already has*, including a url→endpoint lookup the web client had to hand-write as `snapshot().find(url.startsWith(baseUrl))` — where `ClusterEndpointRouter` already knows precisely which endpoint it routed to, and would not have to match on a prefix at all.

Tom's rule: *would nearly every conceivable client be required to do this? If yes, core.* Every client that wants throughput must write the same three-way wiring and the same url match. Two of three wrote none of it and neither noticed, because the axis vanishes silently.

**Two shapes, and Tom picks:**

1. **Core records throughput itself**, where it already sees the transfer and already knows the endpoint. The host supplies nothing; the media-bytes feed stays a host concern, since core never sees those (that is the feed the web client added after an afternoon on its slowest node).
2. **The axis abstains loudly** rather than silently — the way `capacity` already abstains without a core count. Today `selectionAxis()` reports that configuration order decided, and nothing says the primary axis was never available to consult.

These are not exclusive, and the second is worth having regardless. **This is the same failure class as the package alias and the hydration filter**: something invisible from the place it would be noticed.

### `fetch` still returns a bare 401 when the mint failed — decision 1 closed only half the window
**Waiting on:** core, and it needs its own go/no-go. `src/api/SessionManager.ts`, the `fetch` guard. **Found by the phone client on 2026-09-15 by declining an instruction of mine and checking the installed build.**

`0.12.0` refuses when there is **no registry** — never started, or stopped. It does not refuse when the manager *is* started and simply has no token because **the mint failed**. Verified in the published `dist`:

    if (!this.registry) throw new SessionNotStartedError(...)
    ...
    if (response.status !== 401 || sent === undefined) return response;

With a registry present, a failed mint leaves `token` undefined and `inFlight` cleared, so nothing waits and nothing refuses: the request goes out tokenless, is answered `401`, and `sent === undefined` short-circuits the re-mint and hands that `401` straight back. **That is the same symptom the web client originally reported, reached by a different route** — a caller that read the contract still gets a 401 it was promised it would never see.

**I told the phone client its comment describing this was stale. It was not**, and it had checked rather than complied — the third time today that habit caught something, and the second time it caught me. It widened its own provider's comment instead, since "early" now fails in two distinct ways, and left the accurate one alone.

**The fix is not obvious and that is why it is its own item.** A pending `refreshTimer` means recovery is already scheduled, so `fetch` could wait for it rather than refuse — but `lastMintFailure` may be a *refusal* (`anonymous_disabled`) rather than unreachability, where waiting achieves nothing and refusing is right. The two need distinguishing, which is the same distinction `mintNow` already draws for connectivity.

### ~~`recordTransferByUrl` attributes by URL~~ — CLOSED, by construction

Raised by the phone client and **closed by it the same day**, on reading rather than waiting for hardware: `MachaPlaybackResolver` builds the stream URL as `${this.baseUrl}${path}`, and `recordTransferByUrl` matches `startsWith(baseUrl + '/')`. The two can only diverge if core changes how it absolutises, which would be a deliberate act. No silent-drop case exists today.

### Background discovery records real routing evidence
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:230`; `src/services/createMachaServices.ts:67`; `src/cluster/endpointRouting.ts:144-166`.

`clusterStatusApi` routes through `route()`, so each 10 s discovery call does `recordSuccess`/`recordFailure`. A status timeout permanently un-sticks the preferred endpoint — precisely what `recordProbeFailure` exists to avoid — and a success elsewhere steals preference. Contradicts `EndpointHealthMonitor.ts:192` ("owns no server or playback state") and `endpointRouting.ts:21-23`. Fix: an advisory path using the probe variants.

### A storage write error kills the health loop silently
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:237-238`; `src/runtime/configuration.ts:148-151`.

`persistConfirmedEndpoints` -> `setItem` is uncaught. A `QuotaExceededError` (TVs) rejects `cycle()`, the `void` swallows it as an unhandled rejection, no reschedule runs, and `running` stays `true`. `EndpointBandwidth.write()` catches for exactly this reason — two copies of one rule, disagreeing. Fix: try/catch the persist, reschedule in a `finally`. **`probeNow()` now shares this loop**, so a caller awaiting an off-cycle probe inherits the same silent death.

### ~~`Platform.ts:13` inverts the hold status for adapter authors~~ — FIXED on `develop`, unreleased
Corrected 2026-09-17 while rewriting that doc block for `not-found`; it now says `500`, and records that it said `503` and why that was the dangerous direction. Original entry kept below because the reasoning is still the argument for the rule.

**Waiting on:** ~~core. One-line doc fix.~~

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
- ~~`EndpointBandwidth.ts:17-20,124-126` vs `EndpointRegistry.ts:101,563` — restore re-enters at one sample, threshold is two~~ — **folded into *The throughput axis may never have ranked anything* in P1**, which is where it stops looking harmless. `EndpointRegistry.test.ts:266-269` pins the current behaviour.
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
