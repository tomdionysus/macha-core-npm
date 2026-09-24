# Macha principles and laws

These principles are shared with the Macha server. They define the conceptual
boundary of the product and the priority contract the client must preserve.
They are constraints on design and implementation, not performance aspirations.

## Conceptual principles

### Macha is a media system

Macha is a distributed media filesystem and media server, not a general-purpose
distributed POSIX filesystem or cloud entertainment platform. The client exists
to browse and play the owner's media. It does not add accounts, advertising,
recommendations, social activity, other-viewer activity or a global watchlist.

### Authority and presentation remain separate

The server owns catalogue authority, immutable media identity, durability,
placement and media transformation. The client owns presentation, navigation,
controls, platform capabilities and local playback intent.

**The server serves facts; the client negotiates.** The server states what a
title is, what its streams are and what operations it can perform. Choosing
between Direct Play, remux and transcode is the client's, made from its own
measured capabilities — and it is made in `@machafoundation/core` rather than in any one
client, so every client decides the same way from the same facts. The server
obeys the result; it does not pick on the client's behalf. Choosing among an
item's files is part of the same negotiation: the client matches each file's
facts to its own capabilities and names the file it will play.

The catalogue wire model mirrors the server contract. The client must not infer
cluster truth, invent a parallel server model, transcode media, or treat a local
cache as authority.

### Control, data and cache are distinct

Macha separates namespace/catalogue authority, immutable media DATA and optional
non-authoritative CACHE. The client should preserve this distinction in its own
behaviour:

- control and status operations remain responsive independently of bulk media;
- playback DATA is consumed through the source selected by the server;
- cached or persisted client state is an optimization or resumable history,
  never proof of server authority or a live playback lease.

### Playback resources have one owner

`PlaybackRuntime` is the application-scoped owner of the platform player and
active playback coordinator. The coordinator owns the server session lease and
source generations. React presents snapshots and binds surfaces; route and
presentation changes do not create, replace or destroy playback resources.

New user intent supersedes obsolete work. Play, pause and seeks supported by the
active generation are immediate local transport operations. Server preparation
for another generation must not serialize or disable those controls.

### Work is bounded and event-driven

Demand, resource availability, completion, queue transitions and pressure
thresholds wake work through events. Polling, artificial quiet periods and
unbounded hidden work are not substitutes for explicit ownership and bounded
state transitions.

Retries, buffering, recovery, queues and caches must be bounded. Failure and
degraded states must be visible and actionable rather than becoming indefinite
waiting.

### Compatibility is explicit

Platform-specific code is restricted to capabilities, playback, application
lifecycle and input integration. Compatibility fallbacks must be deliberate and
testable. They must not silently weaken playback ownership, viewer priority or
server authority.

Application modules are eagerly bundled. Ordinary catalogue artwork may be
viewport-lazy, while the logo and core UI assets required for startup are
preloaded or embedded.

## Scheduling laws

1. **Thou Shalt Not Make Control Wait.** Cluster membership, health, metadata
   coordination, cancellation, shutdown and the bounded control work needed to
   admit viewer operations must never queue behind or execute inline with bulk
   data work. Control has independently reserved admission and execution
   capacity which lower classes never occupy. Shared physical capacity may be
   used work-conservingly only while an independent control submission credit
   and a bounded completion path remain available.
2. **Thou Shalt Not Make The Viewer Wait.** Playback startup, reads, seeks, and
   the control work required to serve them have overwhelming priority. No ingest
   throughput improvement is acceptable if it introduces viewer-visible delay,
   buffering, starvation, or latency spikes.
3. **Thou Shalt Not Make The Ingester/Loader Wait, Unless It Would Make The
   Viewer Wait.** In the absence of viewer contention, ingest must use the
   available spool, storage, network, CPU, and publication capacity. It may be
   paced for hard capacity, durability, bounded-memory, fairness, or genuine
   downstream throughput limits, but not by an artificial quiet period or the
   mere existence of another open writer.

4. **Thou Shalt Not Shoot Thyself In The Foot.** No operation, code path or
   subsystem may leave the node — or the client — in a state it cannot recover
   from on its own. *Added by the server on 2026-09-20 and adopted here
   unchanged.* It is different in kind from the three above: laws 1-3 decide who
   goes first, this one decides what may not be done **at any priority**. It is
   a veto over all three and where it conflicts it wins, because a component
   that has destroyed itself serves no viewer. Its test, in the server's words:
   *if this goes wrong on the node furthest away, does it come back without me?*
   The client's version of the same question is a television in another room
   that nobody will relaunch.

   Five self-healing disciplines come with it, and four of them bite here:
   **re-derive, do not assert**; **every retried work item gets backoff, a
   failure budget, a parked state and an operator action**; **recover by
   resolving rather than refusing**; and **a bound smaller than one unit of its
   own work is not a bound**. (The fifth, keeping snapshot size a function of
   the live namespace, is the server's.)

These laws define priority, not polling. Viewer demand, resource availability,
durability completion, queue transitions and pressure thresholds must wake or
pace work through events.

They also define priority, not exclusion. The strict order is:

```text
control > viewer >> loader > speculative
```

Capacity is work-conserving where safe, but a lower class may have only a
bounded amount of non-pre-emptible work outstanding when a higher class arrives.
The non-zero loader share must still prove continued progress under sustained
viewing.

## Non-bypassable end-to-end invariant

Classification at the UI, API or playback boundary is necessary but
insufficient. Priority must accompany a request through every resource it can
wait for or occupy:

```text
user intent -> client state -> network request -> server admission
            -> executor -> lock -> buffer/byte credit -> CPU work
            -> physical I/O -> RPC -> source delivery -> media pipeline
```

No function called from bounded work may hide an unbounded subordinate
operation. A lower-priority operation may not hold a shared lock, executor slot,
buffer reservation, network allowance or media resource while waiting for slow
work if doing so can block control or viewer progress.

Priority inversion is a correctness failure, not merely a poor benchmark.
Client bookkeeping, artwork, diagnostics, ingest/status activity and speculative
read-ahead must not delay playback startup, transport controls or seeks.

These are software scheduling invariants, not a promise that failed hardware or
an unavailable server has zero latency. When a required resource is unavailable,
the higher class must complete from already-published state where its contract
permits or fail/degrade within an explicit boundary. It must never wait
indefinitely while lower-priority work continues against the same resource.

## Client review gates

Any material client change should be reviewed against these questions:

- Can control, cancellation, shutdown or error recovery become queued behind
  media, artwork, ingest, diagnostics or speculative work?
- Can playback startup, local transport or seek wait for unrelated bookkeeping,
  caching, read-ahead or presentation work?
- Can a route/render lifecycle accidentally acquire or destroy playback
  resources?
- Is any retry, queue, buffer, cache, recovery loop or in-flight generation
  unbounded?
- Is polling being introduced where an event or owned state transition exists?
- Is cached/local state being mistaken for server authority or a live resource?
- Does a compatibility path silently change the ownership or priority contract?
- Does the change preserve eager module loading and immediate core UI assets?

If any answer is uncertain, add characterization or regression coverage before
changing the mechanism.
