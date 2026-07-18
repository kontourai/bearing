# @kontourai/bearing

Evidence-backed model capability intelligence. Bearing accepts provenance-bearing
model observations, compiles them into deterministic catalog snapshots, and
supports runtime-aware ranking without invoking models.

Bearing answers **what current evidence says a model can do**. It does not own
provider credentials, discover a caller's launchable models, or make model calls.
Datum combines Bearing snapshots with local configuration and runtime inventory;
Station and other runtimes consume that resolution.

## Status

The initial catalog contract is under development. See
[Bearing issue #1](https://github.com/kontourai/bearing/issues/1) for the product
delivery graph.

## Development

```sh
npm install
npm run verify
```

Node.js 22 or newer is required. Bearing has no runtime dependencies.

## License

Apache-2.0.
