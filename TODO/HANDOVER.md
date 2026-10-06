# Handover — 2026-10-04

For the next session on `@machafoundation/core`. [ACTIVE.md](ACTIVE.md) has the open list. The previous handover and the full ACTIVE before its rewrite are in [archive/](archive/).

## First things

1. **Stay on `experiment/object-ledger`.** `main` and `develop` are closed until Tom says otherwise (2026-10-01). Check with `git rev-parse --abbrev-ref HEAD` before any commit.
2. **The tree is clean and pushed**, so clients linked to it compile against what is on origin. Keep it that way: never leave a half-made change in the working tree.
3. **Check the inbox.** Peers send work by cross-session message. Use `ListAgents` for current names; the phone session is now "Macha Phone Client".

## Peers

| Session | Repo | State on the experiment branch |
|---|---|---|
| Macha Client (web) | `../macha-client` | `7d0dace`, availability markers and tooltips, 707 tests |
| Macha Android TV RN Client | `../macha-client-rn-tv` | `5126fe0`, markers, remove-button focus, §1.9 closed, 391 tests |
| Macha Phone Client | `../macha-client-rn` | `55b7552`, markers and downloads-are-available, 410 tests |
| Macha Server | `../macha` | experiment step branches; 0.84.0 rolling out |

None of the clients' experiment commits is pushed. Pushing is on Tom's word.

## What was waiting when this was written

- **Tom: saved playlists.** Store slim entries now, or settle the stale-snapshot refresh first? See ACTIVE, *Waiting on Tom*.
- **The web: tooltip wording.** Asked to reword its `unknown` tooltip if it mentions restarts, since 0.84.0 makes `unknown` rare. No reply yet.
- **The server: 0.84.0 deploy.** Nothing in core depends on it; the doc comment is already updated (`22e0620`).

## Habits that cost the most when skipped

- **Read the other repo before accepting a claim about it.** This session, a peer said `route()` asked `failureBlamesEndpoint` (it did not). Another said core's queue keeps no availability (it does, in memory). Another twice quoted a commit that did not exist. All were settled by reading the source in a minute.
- **Gate each commit on its checks**, and read the hash back before quoting it.
- **Red-check each new test.** One test this session passed with its change removed, until it was tightened.
- **basemind first** for structure and history; use the shell when basemind is unavailable.
