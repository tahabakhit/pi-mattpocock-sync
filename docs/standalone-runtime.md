# Standalone Pi runtime fix

## Failure and fix

The original M4 CLI checks launched the npm Pi CLI under Node. The official Pi 1.3.0 standalone executable instead embeds Bun 1.3.14; loading the extension failed because that runtime has no `node:sqlite` module.

The revision store now loads only the host's native SQLite driver: `node:sqlite` under Node and `bun:sqlite` under Bun. Both use the existing schema, DELETE journal, FULL synchronization, zero native busy timeout, budgeted asynchronous retries, and explicit transactions. Bun's numeric `errno` is recognized alongside Node's `errcode`. Bun cached statements are finalized on close. No state migration, replacement runtime, new dependency, or launcher is required.

## Verification

Verified on Linux on 2026-10-19:

- Node 24.21.0: all 132 existing tests, type checking, and whitespace validation pass. All five actual-tarball/package/CLI/RPC checks pass after the driver fix.
- Actual standalone Pi 1.3.0 / Bun 1.3.14: Node-created state is readable; settings persist; competing writes respect timeout and retry; a pre-commit injected failure rolls back; Node reads Bun-committed state.
- A real public-source check with the standalone executable and the owner's existing Pi configuration synchronized upstream version 1.3.1 at commit `5beb35b040e3de97e54fa9e386d7e42d15c295c2`. Status reported 27/27 manifest-selected paths registered. A second fresh standalone Pi process independently loaded 27/27 from the validated cache. No provider prompt/model call was needed.
- After owner authorization and successful real loading, the local development package was installed into the owner's Pi settings. The already-running chat must use `/reload` to activate it; fresh-process discovery is not proof that an existing chat has reloaded.

Reproduce the isolated driver and standalone loader check:

```sh
node test/standalone-run.mjs /absolute/path/to/standalone/pi
```

The harness uses a temporary home and store, never personal credentials or settings. Driver checks use `BUN_BE_BUN=1` to run the store fixture inside the exact executable's embedded runtime; the loader check runs the ordinary Pi RPC entrypoint, with automatic acquisition disabled. It asserts command registration and a real `/mattpocock status` response, not merely a zero process exit.

This fixes the observed Linux standalone runtime blocker. It does not claim macOS qualification, visual-terminal review, complete upstream workflow equivalence, or npm publication.
