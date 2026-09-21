# `@machafoundation/core` documentation

The [package README](../README.md) covers what the core is, how to install it and how to bring it up. These guides cover the work of using it against a real cluster and bringing it to a new host.

| Guide | Read it when |
| --- | --- |
| [Choosing how to play something](choosing-playback.md) | Always, if you touch playback. The server performs what it is told and chooses nothing, so this is the decision every client depends on and the package makes once. |
| [Writing a player](writing-a-player.md) | You are bringing the core to a new platform. This is the one interface a host must implement, and the contracts its type signature does not show. |
| [Driving the resolver directly](resolver-direct.md) | You are using `ClusterPlaybackResolver` without a `PlaybackCoordinator`. Several rules in these guides assume the coordinator is there, and this says which stop being true when it is not. |
| [A headless Macha client](headless-client.md) | You want to see the whole core working — session, cluster, catalogue, playback negotiation — before writing any UI, or you are debugging a server with no browser in the way. |
| [Async storage on a synchronous interface](async-storage.md) | Your platform's storage is asynchronous and the core wants a synchronous `StorageLike`. |
| [Principles and laws](principles-and-laws.md) | You are changing scheduling, priority or resource ownership. Shared with the server; these are constraints on design, not aspirations. |

[History](../HISTORY.md) records why the package is shaped the way it is, and is worth reading before changing something that looks arbitrary.
