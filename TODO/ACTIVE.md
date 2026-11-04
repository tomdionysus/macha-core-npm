# Active

Open work for `@machafoundation/core`, rationalised 2026-10-04. Read [HANDOVER.md](HANDOVER.md) first. Finished work goes to [COMPLETED.md](COMPLETED.md). The full record before this rewrite, with every investigation and measurement, is [archive/ACTIVE-to-2026-10-04.md](archive/ACTIVE-to-2026-10-04.md). An entry below marked *(archive)* is carried from it as last recorded. Read its archive entry and check the code before building on it, because some may have been overtaken.

Each item says who it waits on. "Tom" means a decision, "core" means core builds it, and a client or the server means evidence or a contract has to come from there first.

---

## Where things stand

- **Branch: `develop`.** The object-ledger experiment was merged into it on 2026-10-06 (`5860da4`) and its branch deleted. `main` moves only by the release procedure, on Tom's word.
- **Published: `0.22.0`** (2026-10-06). npm `latest`, `gitHead` `6e78168` (`main`'s merge), tag `0.22.0` on `9fdbda4`. `develop` is fast-forwarded to `main`. Clients move to `^0.22.0` from the registry, each on Tom's word in its own session.
- **On `develop` since, unreleased: node-targeted ingest (server 0.91.1), 2026-11-01.**
  - `submitPath(path, { nodeId })` answers `IngestAddResult { id, nodeId, placementIgnored? }`, where it answered a bare id. `placementIgnored` means a receiving node before 0.91.1 ran the job itself.
  - `ingestJob(id)` answers `IngestJobDetail`, with `files` and `catalogue.items`.
  - `IngestJob` gains `node_id`, `source_owned`, `delete_source_on_clear` and `catalogue`. It loses `remove_source_on_complete`, which the server no longer sends.
  - `ingestNodes(status)` derives the selector from cluster status (online, and version at least 0.91.1), since the server has no ingest-nodes route.
  - A `503 node_unreachable` the answering node relays about another node is not charged to it.
  - Asked for by the web client, on Tom's "Good shape" for the server's API.
  - Server 0.91.2 (live on macnessa): `pauseIngestFile`, `resumeIngestFile` and `cancelIngestFile(jobId, index)`, each answering the job. `IngestJobFile` gains `index` and `state` (open set). Tom asked the server for per-file control of a file import.
  - `submitPath` no longer sends `remove_source: false`. Tom, 2026-11-01: "The server should default to leaving the source", and it does (`delete_external_source_on_clear{false}`, server `config.hpp:350`). So clearing a job follows the operator's setting, not a core override.
- **Clients on 0.21.0 from npm:** web 0.20.0 (`main` `1fa0bc4`), Android TV 0.9.0 (`main` `263e308`), phone 0.12.0 (`main` `6c293ad`). The phone reports a later 0.13.0 at `8f95141`, not checked here.
- **The experiment branch, past `develop`:** HEAD `83c53e9`, 1340 tests in 77 files, dist hash `cf700f02b7db`. It carries:
  - `6f4c396`, `c211268`: two server asks deferred until the experiment ends (below).
  - `f794364`: slow management reads hold at their node (`MANAGE_WORK_TIMEOUT_MS`, `holdOnTimeout`, `MachaClusterRouteError.slow`). A node failing for three health cycles, or reported offline by the cluster, is `lapsed` and ranks last. Adds `MachaRequestTimeoutError`.
  - `495353a`, `1251cb2`, `22e0620`: availability. `Availability`, `AvailabilityMembers` and `ExtentAvailability` are on catalogue items, `MediaSummary` and playback facts. `availableToPlay` is the play rule. No store keeps availability (`withoutAvailability`), and `currentAvailability` gives saved titles fresh codes. Server 0.82.0 to 0.84.0.
  - `83c53e9`: a walk charges a node only for a failure that is the node's. `catalogue_unavailable` is walked past and charged to no one.
- **Clients on the experiment branch**, all linked to core, none pushed: web `7d0dace`, Android TV `5126fe0` (with `8e044b8`), phone `55b7552` (with `9decb76`). Each carries the availability markers per Tom's ruling.
- **Servers:** fi-1 (10.35.1.50, "Corvus FI-1") and gbni-1 / macnessa (10.44.1.50, "Corvus GBNI-1"). Server 0.84.0 was due "in the next few hours" on 2026-10-04. es-1 (10.34.1.50) has been down since 2026-09-24.

## Standing rulings (Tom)

- **Core writes no viewer text.** It supplies data, codes and kinds; every sentence is the client's. Technical facts are structured (`technicalSummary`). Never add a label, subtitle, notice sentence or default name to core.
- **The server chooses nothing.** Core decides how to play, once, for every client. A quality the viewer picks is never capped. Automatic play caps at the display or the setting, and mobile data defaults to 720p and is configurable. `offerAll` lifts the device limit.
- **A quality no node can play at real speed** stops with a stated reason (`TOO_SLOW_TO_PLAY_CODE`), and the client offers Try again.
- **Availability, for every client alike:**
  - partial: a yellow outline warning triangle at the top left of every title in every context;
  - unavailable: a red outline crossed circle, with the card greyed out and not selectable;
  - unknown: a yellow question mark;
  - complete: no marker.
  - Only unavailable cannot be played (`availableToPlay`). The web adds tooltips.
  - On TV, an unavailable Continue Watching card may take focus, to reach its remove button; OK still does not play it.
  - A title downloaded to the phone is available: no marker, fully playable.
- **Continue Watching** stores the item id, the file and the resume state, and resumes as if the viewer never left.
- **Show the node names the server sends.**
- **Ebooks and deploying are the server's.** Core does neither, now or later.
- **Hard cuts while private**: no deprecation shims. Rebuild the three clients instead.

## Release procedure

Core, on Tom's word only:
1. Run the gated checks.
2. `npm version x.y.z --no-git-tag-version`, which also stamps the README.
3. Commit `x.y.z`, with the release notes in the message.
4. Annotated tag `x.y.z` (bare semver) carrying the same notes.
5. `git checkout main`, `pull --ff-only`, `merge --no-ff develop -m "x.y.z"`.
6. Push `main`, `develop` and the tag. Stay on `main` and build last.
7. Tom publishes.
8. Check `npm view` before saying anything is released.
9. Return to `develop` (ff-merge `main`), and record the release here.

Then tell the clients. Each merges `develop` into `main`, sets `^x.y.z` from the registry, runs its checks, commits, pushes on Tom's word, and returns to `develop` on the `file:../macha-ts` link.

Gated checks, each status checked before committing: `npm run typecheck`, `npm run lint:platform`, then `out=$(npx vitest run | grep "Tests "); echo "$out" | grep -q failed && exit 1`, then `npm run build`, `dist:check` and `dist:hash`. Red-check every new test by undoing the line it pins. Quote a hash only after reading it from `git log`, in a separate step from the commit. Never put Claude attribution in a commit.

---

## Waiting on Tom

- Nothing open from 2026-10-06.

## Merged down, 2026-10-06

- **The experiment is closed.** Tom, in this session: "merge everything down into develop please and remove the experiment branches". Merged `--no-ff` as `5860da4` and pushed; `experiment/object-ledger` deleted locally and on origin. `main` is untouched and moves only by the release procedure below.

## Built 2026-10-06 on Tom's word ("Yes do all")

- **Title files** (`30c2ec8`): `unmatchFile`, `deleteFilePath`, `deleteFileContent` on `ManageApi` (server 0.90.15).
- **Facts retry in the lookup** (`cf4343a`): `ClusterPlaybackFactsApi` retries at 250 ms and 1 s for every caller; the coordinator asks once.
- **Paused start** (`852514e`): `PlaybackRuntimeRequest.paused`, `initialPaused`.
- **The flaky close test** (`5a354e7`): an earlier test's real-timer ladder landed in its fetch; now run out on fake timers.
- **`secureContext`** (`2f247c0`): set from `location.protocol === 'https:'`, not `isSecureContext`.
- Pushed `experiment/object-ledger` to `852514e`.

## Built 2026-10-05 on Tom's word ("Build everything")

- **Read back through the writer** (`19492f2`): `READ_YOUR_WRITES_MS`, 5 s after a write, in the shared router.
- **Artwork hedge in core** (`3a8a5fe`): `ARTWORK_HEDGE_DELAY_MS`, `ARTWORK_HEDGE_MAX_IN_FLIGHT`, `nextArtworkSource`.
- **Mixed content** (`573435a`): `MachaHost.secureContext`, `blockedByHost`, `MachaNoReachableEndpointError`.
- **Storage keys** (`a237296`): everything under `macha.core.`, per-client `macha.core.client.<id>.<store>`, no version in a key, adoption on read. The phone's `orphanedClientId` must move to `machaStorageKeyClientId` (told).
- Also today: management writes on 30 s and a timed-out write uncharged (`340b8ae`), `metadata_unavailable` walked uncharged (`a984240`), `media_engine_unavailable` uncharged (`728230a`).

## Ruled 2026-10-04 (Tom)

- **Saved playlists: slim entries now**, "it needs to just work". Built (`347afd2`).
- **Stale `unavailable`: "No. Trust the last info and keep it as it is."** No age on a card, no trying it anyway. The TV client has it.
- **Push the clients' experiment commits: "Yes, push."** Relayed. The phone and the TV push only on Tom's word in their own sessions.
- **Folding the experiment back onto `develop`: "We will, not yet."**
- **Leading articles only.** "the", "an" and "a" are dropped only at the start of a search. Built (`77ca994`).
- **TV card links are UX, not core's.** The TV client builds them.
- **The session check on a timer is an exception** to "never on a timer", if it cancels and cleans up. Built (`fec3a7a`).
- **No facts: retry, bounded, then decide without them.** Built (`0b9b108`).
- **The release tracks route and repair pace**, decided by Tom with the server (0.86.0, deploying with 0.87.0). Wrapped: `providerReleaseTracks` (`74bb006`); `diagnostics.repair` and `statusOf(nodeId)` (`e864856`). The web has the shapes.
- **Seen while gating `fec3a7a`:** `ClusterPlaybackResolver.test.ts` "retries the close when that node next answers" failed in 2 of about 13 full runs, never alone (0 of 12) and not on the previous HEAD (0 of 4). Its file changed only to pass an optional signal through. Not resolved. Watch for it.

## Deferred until the server's experiment ends

Tom held server API changes during the experiment. Raise these when it ends.
- **Provider artwork by catalogue item.** `GET /api/v1/manage/providers/artwork?item_id=&role=`, resolving the item's own reference as `choose` does. An explicit `ref` still overrides, and an item with none gets a named code such as `no_provider_ref`. Without it, every client parses the server's id forms; an episode's show id is only in its parent season's id. The web has left its artwork picker unbuilt.
- **MusicBrainz release results cannot be told apart.** `providerSearch` gives only ref, title, year and artist. The web saw one album listed eight times. Core asks for country, format, track count and label, as optional data.
- **A scope on `catalogue_unavailable`.** The server raises it for any catalogue exception, unscoped, so core now walks past it without charging (`83c53e9`). With a scope, core could stop walking when the condition is cluster-wide.
- **Identity resets become a resource**: `POST /api/v1/manage/identity-resets`, answering 202 and an id, and `GET .../{id}` for the state. This is the server's decided plan; it is not built yet. When it lands, core replaces `resetIdentityAssociation` and `resetNodeIdentityAssociation`. The web's Status node card is the only caller.

## Ebooks, server 0.92.0 (contract announced 2026-11-04, not live)

The server sent the contract on 2026-11-04. It is on its `feature/ebooks` branch, is not deployed, and the server will message on any change. Later that day the server reported 0.92.0 built on that branch, with the laptop suites green; it is still not deployed. The docs on that branch: the new "Books" section of `docs/catalogue.md`, `docs/management.md` and `docs/files.md`. Two details since the contract:
- the `books` scan provider is off by default, and the operator enables it per node, so books may appear well after the deploy;
- `series[].index` is a JSON number, `8` or `8.5`, or null; PUT and PATCH accept either form.
The content route also answers HEAD. Tom asked the server for a Books tab on the web and on the phone. Tom said on 2026-11-04 to deploy and have the clients start. Core's part is built on develop and is unreleased: kinds and fields; list and search filters; `content` and `contentUrls`; `books`, `authors`, `bookSeries` and `bookContext`; author and series pages; `orderBooksInSeries`; the playback refusal (`not_playable_kind`); book manage types; `ReadingPositionStore`; book routes; the `books` search category, opt-in. Open Library is configurable per node in the server's config (Tom asked; the server confirmed). The server has 0.92.0 packaged on both nodes, but its install was refused by that session's permission check, so the install waits on Tom. What the contract said:
- **Kinds.** `book`, `author` and `series` join `CatalogueKind`. Each has `parent_id` null. On every item: `author_ids`, `series` (`{series_id, index|null}`, where index may be fractional), `language`, `publisher`, `published`, plus the external ids `isbn13` and `openlibrary_*`. PUT/PATCH return `400 reference_not_found` and `bad_reference_kind`. Core already skips unknown kinds: lists go by named kind, search keeps only its categories' kinds, and `pathForMedia` falls back to `routes.item`.
- **Listing and search.** Lists filter by `author=` and `series=`, as they do by `parent`. Search adds the `kind=book|author|series` filter and the same reference filters. Order within a series comes from `index`, and core sorts it.
- **Bytes.** `GET /api/v1/catalogue/media/{id}/content` with the bearer token. It honours one range and returns `?download=1` as an attachment. Errors: `400 bad_media_id`, `404 not_found` (this node cannot read the file, so walk by availability), `416 bad_range`. It works for any media id, not only books.
- **No playback.** A profile request answers `422 profile_not_applicable` with `kind: "book"`. Never open a session for a book; the reader is the client's.
- **Manage.** The probe gains `kind: "book"` (authors, series_name, series_index, isbn, language). Provider search takes `kind=book`, with refs `openlibrary:edition|work:<OLID>`. Manual metadata takes `{kind: "book", title, authors, series?, series_index?, year?, author_id?, series_id?}`. A book's only artwork role is `cover`.
- **Reading position.** Local storage only, until the server's per-user media state (`/api/v1/users/me/media/{id}`) lands.
- **Phone.** No phone client session was running on 2026-11-04, so the contract still has to reach it.
- **Server 0.92.2** (live on macnessa and inverbeg per the server, branch `feature/ebooks` at c4e0d45, read there). `.azw` and `.prc` are catalogued as books, served as `application/x-mobipocket-ebook`; `author_ids` may be empty; `published` can be free text, so core sorts by a leading ISO date or a year in the text and never parses it; book and author ids change on the scanner's next pass over `/Books`, and core treats them as opaque.
- **Conversion, server 0.92.1** (relayed by the web on 2026-11-04, read against `docs/catalogue.md` "Conversion" on the server's `feature/ebooks` at 95d2453; not deployed). Tom asked for conversion between formats. Tom then had the server drop Calibre for libmobi's `mobitool` (read from the server's uncommitted working tree on 2026-11-04): EPUB is the only target, and only `.mobi`, `.azw3`, `.azw` and `.prc` sources convert. An EPUB answers `400 same_format`; PDF, FB2 and CBZ fail at once with `unsupported_source`; a DRM book fails `encrypted`. Conversions stay on the node that made them. Core has `convert`, `conversion`, `conversionContent`, `conversionContentUrls` and `dropConversion` on `CatalogueApi`, with `awaitConversion`, `CONVERSION_FORMATS`, `CONVERSION_SOURCE_EXTENSIONS`, `isConvertibleSource`, `CONVERSION_FAILURE_CODES` and the refusal codes in `api/books.ts`. The cluster walks `convert` past `503 conversion_unavailable` and `404`, names the node in `endpointId`, and pins every later call to it; a ref without a node walks to the node holding one. 0.92.1 also replaces 49 wrongly catalogued books, so their item ids change (for example to `book:isbn:<isbn13>`): a `ReadingPosition.itemId` kept from before may name an item that is gone. Media ids do not change (the server, 2026-11-04).

## Core to build or settle

- **Continue Watching is not per account.** The Android TV client measured that `signOut` clears only the session key, so the next account sees the last one's history. The fix is in core's storage. Not yet looked at here.
- **A representation change lands the viewer where they clicked**, not where they are when the new generation arrives (measured: 11.5 s of negotiation meant an 11.4 s jump back). Arrival-point placement is the general fix. *(archive)*
- **The replacement is built at the viewer's position, not the arrival point**, and `REPLACEMENT_LEAD_TIME_MS`'s docblock says the opposite. *(archive)*
- **The 5.2 s stall at `source-activate`**: activation hands the player a new source and empties a buffer that still held about a minute. *(archive)*
- **A node substitutes a remux for a transcode and says so in the payload**, and core never reads it. *(archive)*
- **`fetch` returns a bare 401 when the mint failed.** Core refuses only when there is no registry. *(archive)*
- **The standby windows are literals** (`ALTERNATE_RECOVERY_WINDOW_MS` 30 s, the transcode one 8 s) where the node reports `pipeline_idle_ms`. Core's half can be done now. *(archive)*
- **A 5 s preflight budget discards healthy standbys**: the web owns the budget, core the window. *(archive)*
- **The encoder speed on the wire since server 0.47.0 is unread.** Check whether `transcode_rates` (0.70.0) has overtaken it before building. *(archive)*
- **`look_ahead_ms` can describe a gate the running generation will not honour.** One narrow fix is core's; the rest is the server's. *(archive)*
- **Where core's start-cost estimate comes from.** Asked of the server 2026-09-23. If the answer is nothing, remove the evidence store and `startCostEstimate`; start progress (0.69.0) may have answered it. *(archive)*
- **Throughput:**
  - the axis may rarely rank, because two samples are needed and the health cycle produces none;
  - forgetting `recordTransferByUrl` is invisible, and core could say so in the abstention reason. *(archive)*
- **Probe a standby before promoting it**: `engine_running` and `segments_ready` are absent when the engine was reclaimed. *(archive)*
- **The `Platform`/`Player` contract** has three gaps, with RN consumers waiting. *(archive)*
- **Speaker layout** is not a concept core has; the Android TV client is to interpret its own measurement first. *(archive)*
- **Artwork**: two residues and a documented gap. *(archive)*
- **Music library state moves into core**: favourites, play counts and recently played, from the phone. Approved, not started. *(archive)*
- **An offline and cache policy seam**, shared by the phone's downloads and the web's read-ahead. Approved, not designed. *(archive)*
- **The low-priority register** and the coverage gaps, grouped by area. *(archive: "Low: the register", "Coverage")*

## With the server, or watching

- **AC-3 audio-copy remux stall.** The server's; `delay_moov` is disproved as the cause. *(archive)*
- **A deleted direct-play session keeps streaming** (8 minutes on the TV set). The server's. *(archive)*
- **The Android TV freeze: cause unconfirmed.** It is bounded at 48 s by `superviseRecovery`, so the next one leaves a `client_recovery_deadline` line. *(archive)*
- **Teardown has a ceiling no client can close**: process death sends nothing. The server's. *(archive)*
- **Error context**: the server is to state scope and alternative on every refusal; core already reads them where they come. *(archive)*
- **A backgrounded Android TV keeps polling**, and the platform probe has never run on a device. *(archive)*
