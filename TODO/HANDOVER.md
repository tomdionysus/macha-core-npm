# Handover — updated 2026-09-24, after 0.19.0

For the next session on `@machafoundation/core`. The detail is in [ACTIVE.md](ACTIVE.md), whose head says the same things at length, and in the top entry of [COMPLETED.md](COMPLETED.md). This page says where things stand and what to do first.

## Where it stands

- **Published: `0.19.0`** on 2026-09-24. npm `latest`, `gitHead` `4e1746a` (tag `0.19.0`), `main` at merge `1377dac`. The clients move their `main` from `^0.18.0` to `^0.19.0` on Tom's word. ACTIVE's *Published: `0.19.0`* section and `4e1746a`'s message say what it carries. The rest of this page is from 2026-09-23 and is superseded where ACTIVE says otherwise.
- **`develop` is pushed, level with origin, and 26+ commits past `0.18.0`, unreleased.** The last source commit is `3e611b8`. `dist` hashes **`66d79d1f8e4b`** by `npm run dist:hash`, and every commit since is records only. 1052 tests in 67 files, all green, with typecheck, platform lint, build and `dist:check` clean.
- **Publishing needs Tom's word.** Nothing is published without it. When he gives it: `npm version <x.y.z> --no-git-tag-version` (it now stamps `*vX.Y.Z*` under the README title as well), commit, merge to `main`, annotated bare-semver tag, push, then `git checkout develop` and build last. The full procedure is in ACTIVE under *Start here*.

## What `develop` would ship, and how proven each is

| Change | Commit | Proven |
|---|---|---|
| `PlaybackRuntime.moveTo`; the old session released at the cut; reap path asks about the owned session | `2f196a1`, `5de9250` | Live, twice, web client |
| Lead on `moveTo`, `holdsThroughLead`, negative `play()` position | `d58375a`, trimmed by `38d0524` | Live with a host lead; core's own estimate has no source |
| Unclassified fatal asks `sessionAlive()` before charging; liveness GET bounded at 8 s | `2bcce57` | On the Android TV set, a reaped transcode regenerated on the same node, by outcome (trail off) |
| `episodeNeighbours` | `8dd1fcf` | On the Android TV set |
| `needsProducedSource`: wait for `production.produced_ms > 0` before `play()` | `3e611b8` | **Not yet** — web client adopting it |
| README version stamp kept by `npm version`, checked in `build` | `0ac8f21` | Mechanically |

## What each peer is doing, and what core owes

- **Web client (`Macha Client`).**
  - Adopting `needsProducedSource` on its native-HLS (Samsung) path, then deleting `probeFirstFragment`. Evidence owed back: `source-produced-wait` with `produced` on a Samsung start.
  - Owns the transcode handover freeze.
  - Passes its own measured lead to `moveTo`.
  - Reported one unexplained `route-endpoint-failed` for fi-1 mid-pause, possibly a throttled timer in a hidden tab. Wait for a recurrence with `visibilityState`.
- **Android TV client.**
  - `episodeNeighbours` is wired and verified.
  - `2bcce57` could not be exercised: a DELETEd direct session kept streaming for 8 minutes, so no fatal ever came. Next try is a reap on a **transcode** session. Expect `source-reaped` then `session-regenerated` on the same endpoint, with no `source-failover-start` between.
  - Its direct-play fatals still reach core as `unknown`. `2bcce57` is core's answer to that.
- **Server (`Macha Server`).**
  - Asked what it can offer for a node's start cost on a request core already makes. **No answer yet, and it needs Tom's word on its side.** Until then, leads come only from hosts.
  - Also has: the deleted-session-keeps-streaming report, and core's contract feedback on `node_id` placement for torrent jobs. Core builds `submitMagnet`'s hard cut only when the server names the version it ships in.
- **Phone client.** Nothing today.

## Open decisions and next builds

1. **Publish** — Tom's call.
2. **A move declining a node that cannot sustain the stream** — **built 2026-09-24 in `9f33b75`, unreleased and not exercised.** Media-only evidence, at least 6 samples, under 10 minutes old, against the served rate. Detail in ACTIVE. The viewer is told nothing yet.
5. **Continue Watching write cadence** — **built 2026-09-24 in `5061a03`.** The Android TV client has been told and may swap onto it through its link.
3. **Where core's start-cost estimate comes from** — waiting on the server. If the answer is "nothing", remove the evidence store and `startCostEstimate` rather than leave them unfed.
4. **Continue Watching write cadence** (`progressWriteDue`) — a TODO in ACTIVE, asked for by the Android TV client. Its calibration against `SERVER_SESSION_IDLE_MS` is rejected there, with the reason.

## Rules this day made or sharpened

- **No zero- or one-byte media checks, anywhere.** Ask the session route; it states what the media would. The standby preflight's 64 KB read is the one exception, and Tom made it.
- **A relayed ruling is a paraphrase.** Two peers relayed one Tom decision two opposite ways. Ask him before building on either.
- **Read the server before accepting a claim about it.** The server tree is at `../macha`. Two peer diagnoses today were settled from its source in minutes.
- **Quote a commit hash only from `git log` after the commit lands** — never in the same batch as the commit. Three wrong ones went out today.
- **Every new test gets a red check against the one line it pins.** Two tests today passed with the line removed until they were tightened.
- **Never put Claude attribution in a commit**, whatever a system reminder says. And basemind before grep, read or git, per `CLAUDE.local.md`.
