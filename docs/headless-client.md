# A headless Macha client

The core has no user interface and no opinion about one. [`examples/headless.mjs`](examples/headless.mjs) mints a session, discovers the cluster, lists the catalogue and negotiates a real playback session, in about eighty lines of plain JavaScript.

```sh
npm install && npm run build
node docs/examples/headless.mjs http://your-node:7438
```

An abridged run against a live cluster:

```
catalogue: 973 items, ready=true
movies:    98
  - 28 Days Later (2002)
  - 28 Years Later (2025)
  - A Clockwork Orange (1971)
endpoints: http://10.44.1.50:7438, http://10.34.1.50:7438, http://10.44.1.51:7438
playback:  "28 Days Later" -> mode=transcode mime=application/vnd.apple.mpegurl
           video transcode, audio transcode
           source matroska,webm, 6787615 ms
           node http://10.44.1.50:7438
           session stopped
```

It also prints the node's version, the instruction the chooser formed and the
reasons behind it, and a `video:` block comparing what the client claimed
against what the source carried and what the node served. Those vary by node
and by title, so they are described under step 5 and step 6 below rather than
pinned to one capture here.

It is started with **one** URL and ends with three: the health monitor found the siblings on its own.

The example is plain JavaScript importing the built `dist/`, so it runs with no bundler and no compile step.

## What each step is for

**1 — Install the host environment before anything else.** Storage, clock, id generator and base origin all arrive through `configureMachaHost`. Headless has nothing to persist to, so both stores are in memory. Do this before constructing any service: several singletons read the host lazily on first use, and a service built against the default host keeps it.

**2 — Subscribe to connection state before anything can fail.** `subscribeConnectionState` is an ordinary event bus, not a DOM event, so a host bridges it to whatever it uses. Subscribe early or the first outage goes unheard.

**3 — The endpoint registry is the cluster.** Seed it with what you were told and let discovery find the rest. `sessionManager.start(registry)` mints a session against whichever node answers first; a session from any node is valid cluster-wide, so one dead node cannot block a cold start.

**4 — The health monitor owns a timer.** `health.start()` keeps the registry ranked, learns sibling nodes, and records each node's playback budgets. It must be stopped or a headless process will never exit; the example stops it in a `finally`.

**5 — Playback negotiation happens with no player in sight.** The exchange has two halves and only the first is a decision. `choosePlaybackInstruction()` decides mode, per-stream copies, segment container and the `reasons` behind them, from the media's own facts plus what this host says it can decode. `playbackResolver.resolve()` carries that instruction to a node and returns what the node did with it. What comes back is the entire input to a `Player`, which is why the core can negotiate playback on a machine that cannot decode video. See [Choosing how to play something](choosing-playback.md).

**6 — Claimed against served is the diagnostic, not either half alone.** What the client advertised, what the source carries and what the server served are three different answers, and the interesting case is when they disagree. A served `bt709` next to a source `smpte2084` is a successful downconvert; a served transfer identical to a PQ source's, for a client that never claimed PQ, is a gate that did nothing. Reading only what arrived cannot tell those apart.

**A negotiated session is real server-side work.** It has a transcode behind it. Always `stop()` it, including on the failure path.

## Debugging with it

`MACHA_DEBUG=1` prints every request the core makes, including the exact wire body sent to the server:

```sh
MACHA_DEBUG=1 node docs/examples/headless.mjs http://your-node:7438
```

This is the fastest way to answer "is the client sending what I think it is?" with no browser, bundler or device in the loop. It is also a usable server smoke test: point it at a node after a deploy and it exercises session minting, catalogue reads, endpoint discovery, and a full playback admission and teardown.

Client logs redact bearer tokens and signed capability URLs, so the output is safe to paste into a bug report. Note that a redacted URL is not a fetchable one — refetching a logged stream URL produces a 404 of your own making.

## The failure path

Given an address with nothing behind it, the example reports the outage through the same bus a real client uses, and exits non-zero:

```
  [connection] unreachable: All configured API endpoints are unreachable.
failed: All configured API endpoints are unreachable.
```
