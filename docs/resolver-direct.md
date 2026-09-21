# Driving the resolver directly

`ClusterPlaybackResolver` is a supported entry point. `PlaybackCoordinator` is
built on it, and a host may use either — but almost every other document here
is written as though the coordinator is there, and several of its rules stop
being true when it is not. This says which.

Reach for the resolver directly when the host already owns playback state and
wants sessions rather than a runtime: a client with its own player lifecycle,
its own position tracking and its own idea of when to recover. Reach for the
coordinator otherwise. Neither is the fallback.

## What the coordinator was doing for you

Each of these is the coordinator's work, not the resolver's. A resolver-direct
host does it or goes without it.

**Converting between the title's timeline and the generation's.** A transformed
generation rarely begins at zero: the session states `seekMs`, and the player is
handed media that starts there. A title-absolute position is therefore
`seekMs + positionWithinGeneration`, and nothing in the resolver adds that term
for you.

This one has been got wrong in the field rather than in theory. A client
scrubbed to 1:44:35, the node built a generation at `seek_ms 6275725`, and its
progress bar read 0:13 — the honest generation-local position of a generation
that starts at 1:44:22. Direct play hid it, because a direct source starts at
zero and the two timelines coincide.

Note what the fix is *not*. `seekOffsetMs` is zero for transcode and direct, and
on a remux it is already inside `seekRequestedMs`; adding it corrects nothing on
the case that was broken and is wrong on the case that was not. What is missing
is the generation's origin.

**Closing sessions.** The coordinator closes on teardown and after a move. A
resolver-direct host owns the whole lifecycle: every session it creates, every
replacement it promotes, and every session left behind by a process that died.
An abandoned session holds its node's transcode entitlement and counts against
the per-account cap on that node until the node reaps it.

`stop()` will act on a session id even when this resolver has no record of it —
core mints `${endpoint.id}::${nodeSessionId}` and recovers the node from the id
— so a host that persists the ids it was handed can close them after a restart.
`sessionAlive()` recovers the same way, so an orphan can be asked about before
it is closed. An untracked close never throws and never charges a node, because
it cannot tell a session abandoned deliberately from one left by a crash.

**Deciding what a failure means.** The resolver reports; it does not recover.
`failover`, `regenerate` and `prepareAlternate` exist, but choosing between them
is the coordinator's logic, and choosing badly has a measured cost: a node that
reaps a paused session answers `404`, and a host that treats that as the node
failing charges a healthy node and walks away from it.

Classify with the exported accessors rather than by hand; the package README's
*Telling a viewer what went wrong* covers them, and none of it is special to
this entry point.

**Standbys and promotion.** `prepareAlternate` builds one and
`alternateRecoveryWindowMs` says how long it is worth holding. Promoting it —
and releasing what it replaces — is the host's.

## Rules that assume the coordinator

[Choosing how to play something](choosing-playback.md) says of `seekMs`,
`seekOffsetMs` and `seekRequestedMs`: *the core consumes these; a host must
not*. That is true **when the coordinator is doing the converting**. Correcting
by the offset on top of it double-corrects, and the result is self-consistent
and wrong.

Without a coordinator nobody is converting, so the warning inverts: a
resolver-direct host must add `seekMs` itself, and should say in its own source
that it is standing in for the coordinator, or the next reader will remove the
correction as a double-correct.

`checkSeekInvariant` runs inside `mapSession` either way, so the three fields
are still checked for every client and a violation still reaches the trail as
`seek-invariant-violated`. It reports and never acts.

## What the resolver still does for you

Node selection and the walk, the attempt budget derived from each node's stated
deadlines, endpoint health and cooldown, the close ladder for a session a node
would not acknowledge, `withServedSegmentContainer` restating the container a
replacement must keep, and the session-id provenance above. None of that moves
to the host.
