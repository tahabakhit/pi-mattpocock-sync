# M3: native lifecycle, controls, and minimal compatibility

Status: M3 verified on Linux with Node 26.11.1 and 22.19.0. All 130 tests pass on both runtimes after a clean dependency install, plus type checking, whitespace validation, and the disposable public-source smoke. This verifies the source integration, not an installed/published package. Tracking: [issue #1](https://github.com/tahabakhit/pi-mattpocock-sync/issues/1).

## Implementation boundary

- `src/extension.ts`: native lifecycle adapter and `/mattpocock` command family.
- `src/compatibility.ts`: separate, runtime-capability-aware guidance; upstream bytes remain untouched.
- `src/revision-store.ts`: the existing transactional store now persists the automatic-update budget. Exact M2 format-1 records are read with a 5000 ms default; the next successful transaction writes format 2. Unknown formats/fields and invalid budgets still fail closed. The SQLite schema and writer protocol are unchanged.
- `src/pi-resources.ts`: exact-path resource contribution and ordinary collision withholding, now including available conflicting origins.

The default file entrypoint uses `<Pi agent directory>/mattpocock-sync`, outside scanned skill roots. It calls Pi's public `getAgentDir()`; SDK embedders must align `PI_CODING_AGENT_DIR` with their SDK agent directory or inject an explicitly scoped `RevisionStore` through `createSyncExtension`. There are no project overrides, new services, scheduled checks, workers, or automatic dependency installs.

At the M3 boundary, `package.json` remained private with empty Pi resource lists. The source entrypoint was tested directly in disposable Pi sessions; those M3 results did not establish an installed package, published artifact, or completed package-loader qualification. See [M4](m4-packaging.md) for subsequent artifact/entrypoint work and its current gates.

## Session lifecycle

Factory evaluation only registers handlers; it does not open the store or start a network request. On session start:

1. Read the shared configuration and validate the selected cached snapshot.
2. Capture that immutable snapshot before launching one asynchronous automatic check. A fast check cannot replace the captured paths before discovery.
3. Without a selected snapshot, and only when automatic updates are enabled, await a bounded bootstrap. An outer budget covers acquisition/selection and final cached loading without resetting the deadline between them.
4. Return only exact manifest-selected paths from the capture during `resources_discover`.

Initial local state/cache reads have the store's bounded read budget; the configured automatic budget applies to the update/bootstrap, including its lock waits. Synchronous SQLite, parsing, and filesystem flushes remain non-preemptible; this is not a hard real-time startup guarantee.

A failed bootstrap or invalid cache contributes no skills and emits a diagnostic, without failing the Pi session. Cached updates retain the loaded revision on failure. Updates only select the next revision: full Pi `/reload`, a new session, or saved-conversation resume performs fresh discovery and replaces the contribution, including removals and an empty manifest. There is no timer or retry loop after the single startup check.

Shutdown/reload marks the instance stopped, cancels owned operations, awaits cleanup, and removes its session registry entry only if it still owns that entry. No late completion uses the stale UI. Use Pi's normal runtime shutdown; directly disposing a bare SDK `AgentSession` without emitting its shutdown lifecycle does not supply this contract.

## Controls and diagnostics

| Command | Effect |
| --- | --- |
| `/mattpocock` or `/mattpocock status` | Loaded/contributed paths, selected/previous revisions, automatic state/budget, latest session update/load attempt, last control operation, and last committed check |
| `/mattpocock update [milliseconds]` | Explicit update; defaults to 30000 ms; does not enable automatic updates or reload |
| `/mattpocock retry [milliseconds]` | Same explicit update path, useful after failed bootstrap |
| `/mattpocock rollback` | Cancel/await local automatic work, select the validated previous revision, and pause automatic updates transactionally; loaded paths stay unchanged |
| `/mattpocock auto on` | Enable future automatic checks; does not start a check or reload immediately |
| `/mattpocock auto off` | Cancel/await local automatic work and persist opt-out under the writer lock |
| `/mattpocock budget <milliseconds>` | Persist a 1–300000 ms automatic budget for subsequent checks |
| `/mattpocock help` | Command usage |

Local mutations are serialized; an overlapping control command is rejected with a diagnostic rather than queued indefinitely. Explicit update/retry waits for the existing bounded background attempt; rollback/opt-out cancels it first. Other processes still use the M2 writer protocol and re-read the automatic flag under the lock. A transaction that commits before opt-out/rollback takes the lock is not retroactively undone.

Status uses Pi's actual command inventory and matching source paths to count currently registered selected skills. It distinguishes unavailable/withheld/offered resources, but cannot detect every rejected contender from another dynamic extension. Other dynamic-extension collisions remain unsupported; never interpret an offered set as proof of exact-set parity in that configuration.

Cancelled/expired checks intentionally leave the durable `lastCheck` unchanged. The separately displayed latest session attempt prevents an old committed success being presented as a newer timeout's result; successful settings controls do not erase that update outcome. This session-only attempt is not persisted through reload. Nested budgets preserve timeout classification.

Interactive/RPC contexts use ordinary notifications. Print/JSON contexts use stderr, not stdout or a modal widget. Diagnostics emit bounded codes and escaped provenance, not raw downloaded bodies or exception messages. Terminal rendering and RPC client presentation still require M4/manual qualification.

## Optional subagent inheritance

The tested `@gotgenes/pi-subagents` package constructs a new loader and rediscovers resources; it does not copy the parent's dynamic resource paths. A process-global map scoped by store directory and public session ID carries only the parent's immutable contribution. No session messages, credentials, or transcripts are stored in this map.

A child recognized by the tested package's ID-valued `parentSession` header captures the parent's offered snapshot and starts no bootstrap/check. Unavailable and withheld contributions remain unavailable in the child. The child still applies its own ordinary-skill collision checks. Its capture survives parent shutdown; each live child owns its own map entry. Inherited sessions cannot mutate shared sync settings through these commands.

A missing parent entry fails closed with an explicit warning and no contribution/check. Cross-process inheritance is unsupported. Pi's normal file-path parent headers and explicit resume/fork/new lifecycle reasons use fresh discovery instead. An independently reopened saved child with an ID parent and a generic `startup` reason is ambiguous and conservatively withheld; this is not perfect identification of every custom SDK or external worker. Explicit reload re-evaluates the live parent capture; it does not permanently pin saved conversations.

## Compatibility, not emulation

Before an agent run, a separate structured prompt section explains how to read advertised skills with Pi's existing tools, preserve user-only invocation, resolve supporting paths, and respect owner approval boundaries. It does not add a replacement Skill tool or change upstream files.

Capability checks use current public active/configured tool metadata. Hidden and inactive direct/model-only tools are not treated as available. Codemode/deferred tools are callable, but may require an available orchestration/search entrypoint; this conditional-stop guidance applies to both worker tools and indirect `read`. Names alone do not establish writable workers, configured models, permissions, or worktree isolation.

Missing prerequisites must stop the affected workflow with an explanation. The core works without subagents. Worktree isolation is neither supplied nor verified; do not substitute parallel writes in a shared checkout. No companion package is installed. Pi's normal CLAUDE.md discovery/precedence applies; this integration does not silently copy it to AGENTS.md. This guidance is not a runtime security boundary or a promise of equivalent model behavior.

## Verification record

Final qualification after the review fix and all regressions:

- `npm ci --ignore-scripts`: passed; no dependency lifecycle scripts ran.
- Linux x64 / Node 26.11.1 / npm 11.20.0: 130 passed, zero failed/skipped/cancelled, about 11.7 seconds.
- Node 22.19.0: the same 130 tests passed, zero failed/skipped/cancelled, about 13.4 seconds. The temporary official Linux runtime was checksum-verified against its release SHASUMS and removed afterward; system Node was unchanged. Node 22's SQLite experimental warning remains visible.
- `npm run typecheck` and `git diff --check`: passed.
- Tested host: Pi/Pi AI 1.3.0; optional subagents 25.0.1. Exact dependencies remain recorded in `package-lock.json`.
- `RUN_PUBLIC_SMOKE=1 node --import tsx test/smoke-upstream.ts`, with a disposable HOME/store: passed on Node 26.11.1. Observed upstream version `1.3.1`, commit `49dd158d1076134a641b33efb035946536778336`, 27 selected skills, 189 regular files, and one symlink. Cached integrity and simulated offline recovery passed; the temporary store was removed. These observations are not runtime constants and the smoke does not install/load the package into active Pi.

Reproduce ordinary checks with `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `git diff --check`. The live smoke is deliberately separate from the offline/allowlisted fixture suite.

Fixtures cover bootstrap/offline/timeout, cached-first staging and successive starts, removals/reload, control persistence and migration, latest versus committed outcomes, cancellation, corruption, ordinary collision withholding and known partial dynamic contributions, public parent-header cases, and the real optional subagent package with the production source entrypoint and a fake provider. Existing M0–M2 tests remain in the run.

Initial type checking caught a misuse of tool-execution-only `ctx.tools` in a lifecycle context; capability detection now uses the public active/configured tool APIs. Initial prompt assertions inspected Pi's idle `session.systemPrompt`, which clears run-specific options after completion; corrected assertions inspect the fake provider's received transcript instead. A focused static implementation review found no blocking defect and identified one indirect-read guidance gap, now addressed with codemode/deferred regressions. This is not a comprehensive security audit or a substitute for runtime qualification.

No active Pi installation, publication, commit, or push is part of M3. macOS, package tarball/production package loading, and terminal UX remain unverified or deferred to M4.

Primary implementation references are the pinned Pi 1.3.0 extension/SDK/configuration/skill/session documentation and public declarations, its `dynamic-resources` example, and the installed optional subagent 25.0.1 lifecycle source. Inspecting these sources is not itself a runtime test result.
