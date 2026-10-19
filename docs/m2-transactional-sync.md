# M2: acquisition and transactional synchronization

Status: M2 verified on Linux with Node 26.11.1 and Node 22.19.0. The final clean-install run passed all 101 tests on both runtimes, type checking, and the controlled public-source smoke test. This is a sync core, not an installed automatic Pi updater. Tracking: [issue #1](https://github.com/tahabakhit/pi-mattpocock-sync/issues/1).

## Implemented boundary

- `src/acquisition.ts`: resolve the official default branch, pin one immutable commit, fetch that archive with bounded public requests, and validate entries before materialization.
- `src/snapshot.ts` and `src/local-snapshot-store.ts`: retain exact snapshot bytes/structure, selected resources, license notices, hashes and modes; validate cached provenance; publish complete immutable revision directories.
- `src/revision-store.ts`: SQLite-backed selected/previous references, automatic-update state, last committed check result, writer exclusion, rollback, and abandoned-stage recovery.
- `src/snapshot-policy.ts`: conservative MIT license-change policy and explicitly scoped Markdown-reference validation.
- `src/sync-operation.ts` and `src/durable-fs.ts`: cancellation/deadline helpers and file/directory durability operations.

The core accepts an explicit store directory. M3 still needs to bind it to the Pi agent directory and wire automatic lifecycle behavior, status/commands, and optional subagent compatibility. No installed package entrypoint is enabled.

## Transaction and activation model

A small SQLite record holds selected/previous commit-and-digest references, versions, automatic-update state, and the last committed check result. `BEGIN IMMEDIATE` serializes writers across acquisition and import; state/configuration is read under that lock. Readers use a short deferred transaction to see one schema/data generation, including during first initialization.

Only a complete, validated, flushed revision may be referenced by a committed selection record. Files and directory entries are flushed before publication; newly created directory ancestors are flushed too. Existing commit directories are revalidated and reused, never overwritten. Old snapshots remain available to running sessions. These operations do not reload Pi or mutate its currently loaded resource paths.

Rollback validates its target, selects it, and pauses automatic updates in the same transaction. An explicit update does not re-enable automatic updates. A queued automatic check re-reads that flag under the writer lock and skips acquisition when disabled. There is no timer, scheduler, service, or garbage collector.

SQLite owns lock release and interrupted-transaction recovery; no timestamp lease, stale-lock takeover, or PID-reuse protocol is used. Native busy timeout is zero, with cancellable asynchronous retries. Only a writer holding the lock removes abandoned `.acquire-*` and `.stage-*` trees. Published revisions and SQLite journals are never treated as disposable staging files.

Cached loads validate the recorded digest/version and generated provenance against actual snapshot content. Malformed state, unexpected schema objects (including triggers), symlinked state/content paths, or changed cached content fail closed. Rollback can recover from a corrupted selected revision if its previous target still validates; corrupt revisions are not automatically overwritten or deleted.

## Acquisition and input limits

Requests use only constructed GitHub API and codeload URLs, omit credentials, and refuse redirects. The manifest and all content come from the same resolved commit. Failure messages do not echo downloaded response bodies. No upstream package scripts, hooks, extension code, or other executable plugin resources run.

Initial limits:

| Resource | Bound |
| --- | --- |
| Metadata response / manifest | 1 MiB each |
| Compressed archive | 8 MiB |
| Decompressed tar | 64 MiB |
| File content | 32 MiB total |
| Entries | 10,000, including implicit parents |
| Path / link target | 1,024 UTF-8 bytes, 64 components, 255 bytes per component |
| Retained paths and link targets | 2 MiB total |
| Path resolution | 256 component steps; 64 symlink hops |
| Individual skill frontmatter | 64 KiB |
| Generated provenance | 8 MiB |

These bounds exceed the observed upstream footprint; they do not promise unlimited future content. The archive wrapper also counts toward archive pathname limits.

The maintained `tar-stream` parser collects a bounded archive before materializing entries. Paths, modes, parent structure, normalized/case collisions, duplicate entries, and symlink resolution are checked first. Files/directories are written before symlinks, so no later entry is extracted through a link. Special files, hardlinks, sparse representations, traversal, unsafe/cyclic links, and path expansion beyond the bounds are rejected. Tar-decoded names containing a replacement character are conservatively rejected rather than risk silently changing invalid UTF-8 path bytes.

The default operation budget is five seconds, configurable per call up to five minutes. It includes lock waits, transport, validation, and publication checks. Cancellation or expiration prevents a new selection commit; it does not delete prior revisions. Synchronous parsing, SQLite, and fsync calls cannot be preempted midway, so this is not a hard real-time guarantee on failing storage.

Ordinary acquisition/validation failures may record a failed check while retaining selection. A cancelled/expired transaction is rolled back completely: its caller receives the failure, but the persisted check record remains the last committed one. M3 must distinguish that record from a later failed in-memory attempt rather than present stale success as the latest attempt.

## License and supporting references

The current production policy requires a declared MIT license and the standard MIT grant/disclaimer text, allowing whitespace and copyright-attribution differences. Changed terms require review rather than automatic acceptance. Original notices and all file bytes remain unchanged. This is a conservative content policy, not a legal audit of every asset or a proof of author trust.

An isolated Marked parser validates relative Markdown link/image destinations in selected skill bodies, including reference-style links. Targets resolve against the captured tree with filesystem-order symlink/`..` semantics. Code examples, arbitrary prose paths, external URLs, fragments, HTML links, absolute paths, and `~`-prefixed environment paths are not claimed as validated. Complete snapshot preservation keeps shared supporting content in place without exposing unselected skills.

## Verification record

Final verification after review fixes:

- `npm ci --ignore-scripts`: passed; no dependency lifecycle scripts ran.
- Linux x64, Node 26.11.1, npm 11.20.0: 101 tests passed, zero failed/skipped/cancelled, about 9.1 seconds.
- Node 22.19.0: the same 101 tests passed, zero failed/skipped/cancelled, about 10.4 seconds. The official temporary Linux runtime was checksum-verified against its release SHASUMS and removed afterward; system Node was unchanged. SQLite's experimental warning was observed, not suppressed.
- `npm run typecheck` and `git diff --check`: passed.
- Tested dependencies: Pi/Pi AI 1.3.0, optional subagents 25.0.1, YAML 2.9.1, tar-stream 3.2.2, Marked 18.1.1; exact resolution is recorded in the lockfile.
- Controlled public-source smoke on Node 26.11.1: upstream `1.3.1`, commit `49dd158d1076134a641b33efb035946536778336`, 27 selected skills, 189 regular files, one symlink. Cached integrity and simulated offline failure recovery passed. The temporary store was removed and no active Pi resources changed.

Review found five gaps. Long PAX paths and an ignored-update SQLite trigger were reproduced as two failing regressions. Fixes add bounded path expansion, transaction-consistent state reads, exact schema/affected-row checks, durable directory ancestry, and a non-vacuous abandoned-download test. The latter now creates a real partial `.acquire-*` tree and asserts its presence before killing the worker. All fixes and strengthened tests pass in the final clean-install/current-runtime/minimum-runtime/smoke run. The pinned-reader test also confirms the competing writer fails specifically on timeout, not an unrelated error. This is focused review and regression verification, not a comprehensive security audit.

The suite exercises isolated synthetic manifests, transport faults, real explicitly allowlisted loopback HTTP, malicious archives, rollback/opt-out, corruption, cross-process contention, first-initialization readers, and SIGKILL around partial acquisition, staging, revision publication, state write, and committed state. Existing real-Pi M0/M1 tests remain included. The network tripwire rejects all non-allowlisted traffic; it is not an OS sandbox.

Reproduce ordinary verification with `npm ci --ignore-scripts`, `npm test`, `npm run typecheck`, and `git diff --check`. Live upstream qualification is deliberately separate and explicit: `RUN_PUBLIC_SMOKE=1 node --import tsx test/smoke-upstream.ts`. It performs public reads into a disposable store, not active installation.

## Constraints and next stage

- A local filesystem with working OS locks and fsync is required. Network/synchronized filesystems are not qualified.
- Node's built-in SQLite API is available without a flag since 22.13, but remains experimental in Node 22; its warning is not suppressed or patched away.
- Process-death and flush-call evidence is not proof against arbitrary hardware/filesystem failure or power loss. No power-cut test was performed.
- Same-user malicious concurrent mutation of live source/store ancestors is outside the boundary. Downloaded archive entries and pre-existing invalid state remain subject to validation.
- macOS remains unverified. npm packaging, terminal UX, automatic lifecycle wiring, and production optional-subagent handling remain M3–M4 work.
- The package is private with empty Pi resource lists. No active installation, publication, commit, or push has been performed as part of M2.

Primary references: [Node 22 SQLite API](https://nodejs.org/docs/latest-v22.x/api/sqlite.html), [SQLite locking and recovery](https://www.sqlite.org/lockingv3.html), [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html), [tar-stream](https://github.com/mafintosh/tar-stream), and [Marked](https://marked.js.org/).
