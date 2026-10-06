/**
 * How often `EndpointHealthMonitor` probes every known endpoint. Kept apart
 * from the monitor so the registry can derive from it without importing the
 * monitor, which imports the registry.
 */
export const ENDPOINT_HEALTH_INTERVAL_MS = 10_000;

/**
 * How long an endpoint keeps failing, with no success between, before it
 * ranks behind every endpoint in good standing: three health cycles. The
 * span runs from its first failure to its latest, so a single failure
 * followed by quiet never lapses.
 *
 * A node that is up answers its probe every cycle, so its failures never span
 * this long however slow its real work is. One cycle would demote a
 * node for a single dropped probe; three is a node that has stopped
 * answering. A host that lengthens the monitor's interval past a third of
 * this lets a live node lapse between its own probes.
 */
export const ENDPOINT_LAPSED_AFTER_MS = 3 * ENDPOINT_HEALTH_INTERVAL_MS;
