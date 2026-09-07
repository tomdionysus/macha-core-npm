# `@macha/core` documentation

The [package README](../README.md) covers what the core is, what it deliberately leaves to a host, and how to install and configure it. These guides cover the two things a new host actually has to do.

| Guide | Read it when |
| --- | --- |
| [Headless client](headless-client.md) | You want to see the whole core working — session, cluster, catalogue, playback negotiation — before writing any UI, or you are debugging a server against a client that has no browser in the way. |
| [Choosing how to play something](choosing-playback.md) | Always, if you touch playback. The server performs what it is told and chooses nothing, so this is the decision every client depends on and the package makes once. |
| [Async storage on a synchronous interface](async-storage.md) | Your platform's storage is asynchronous (React Native's `AsyncStorage`, or anything else that returns promises) and the core wants a synchronous `StorageLike`. |
| [Writing a player](writing-a-player.md) | You are bringing the core to a new platform. This is the one interface a host must implement, and the contracts that are not obvious from its type signature. |

Both guides assume the package is built (`npm install && npm run build`); a linked `file:` dependency does not build itself.
