# M0: native Pi lifecycle feasibility

Status: M0 verified on the tested Linux host; 14 tests passed. This is a fixture-only experiment, not the shipped sync implementation. Tracking: [issue #1](https://github.com/tahabakhit/pi-mattpocock-sync/issues/1).

## Scope and reproducibility

The tests exercise the real Pi default resource loader, extension loader, `AgentSession`, and `AgentSessionRuntime`. Extension handlers are loaded from temporary files, not replaced by mocked Pi methods. Explicit `/skill:` invocations run through Pi's prompt expansion and a deterministic in-process fake provider. The suite calls the same public session reload/new/resume operations that the interactive host uses; it does not exercise terminal rendering or keybindings.

Dependencies are development-only. Pi and its fake-provider API are pinned to 1.3.0 to reproduce the approved host target. Other tools use ordinary version ranges, with exact resolved dependencies recorded in `package-lock.json`.

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
git diff --check
```

`npm test` starts a child process with a temporary HOME, agent directory, and XDG directories, an allowlisted environment without provider credentials, and a disposable workspace. It does not discover the real user's extensions or skills. SDK model-catalog network refresh is disabled; a Node socket/fetch tripwire rejects accidental network calls. This is a test tripwire, not an OS sandbox for arbitrary native code or subprocesses. The optional subagent fixture has only the read tool and the fake provider never requests tools.

The runner deletes its temporary directory after the child exits. Synthetic prompts, observation logs, settings, and session files are created only there. The optional package is a repository-local dev dependency, not installed into active Pi. No Matt Pocock content, personal cache, credentials, or real model calls are used.

## Findings

### Native discovery and explicit invocation

The `resources_discover` hook can return individual immutable `SKILL.md` paths. Only those paths are registered; another skill tree outside the supplied paths remains undiscovered. A user-only skill stays out of automatic model selection while its explicit command expands its actual bytes.

The parent harness needs the read tool enabled to test the model-facing skill catalogue: disabling all tools hides the catalogue. The initial harness did that incorrectly; assertions now check positive catalogue presence before testing exclusions/removals. Each invocation must produce exactly one new fake-provider request, and assertions inspect its latest user message rather than matching old conversation history.

### Background staging is viable without private APIs

A `session_start` handler captures the selected revision synchronously and starts one asynchronous, cancellable operation without awaiting it. Dynamic discovery returns the captured paths while that operation is still pending. Completing the operation changes only the selected revision for future discovery, not the running session's paths or explicit invocation bytes.

This experiment holds/release-controls a simulated fetch using the public event bus. It proves the lifecycle integration point, not network timeout behavior or production storage safety. No launcher, scheduler, background service, private API, or Pi monkey-patch is needed for this slice.

Reload and shutdown abort the pending operation and await its cleanup. A setup-failure regression check verifies cleanup also occurs when binding reports an extension error before the harness can return the session to its caller.

### Reload, new sessions, and resume

Full session reload replaces the dynamic set: changed and added skills load, removed skills disappear, and an entirely empty contribution removes all prior contributed skills. A fresh session selects the new revision while another active session continues using its old paths.

The real session runtime's new-session and saved-session resume operations both rediscover current resources. They do not permanently pin saved conversations to old plugin content. These are native lifecycle observations, not custom resource replacement logic.

### Collision guarantee and limitation

For an already-loaded ordinary skill, `pi.getCommands()` reveals its name during discovery. The fixture withholds its entire set, keeps the user's skill available, and verifies the user file did not change.

For another extension's dynamic contribution, neither handler sees the other's buffered skills. Tests in both extension orders demonstrate Pi's first-name-wins resolution and collision diagnostic. The non-conflicting remainder of our set still loads. This is the explicitly unsupported case from the approved plan, not package-wide conflict protection.

### Optional subagent inheritance

The suite loads the actual `@gotgenes/pi-subagents` dev dependency and uses its public service to run a tool-free-response fixture agent against the in-process fake provider. Without compatibility glue, its new session rediscovers the newly selected revision and can start another update attempt. It does not automatically preserve the parent's dynamically registered revision.

A small fixture-only bridge works through public session headers: keep loaded snapshots keyed by session ID, recognize an in-process child's `parentSession`, reuse that parent's snapshot, and skip an independent update attempt. State is scoped to the fixture and removed on session shutdown. The strengthened test checks both the selected paths and the child's actual model-facing catalogue, excluding the alternate revision.

This supports a minimal compatibility approach, not a new spawner, worker protocol, or worktree manager. Production handling of all child lifetimes and configuration changes still belongs to the later compatibility milestone.

## Verification record

- Host: Linux x64, Node 26.11.1, npm 11.20.0.
- Pi SDK and Pi AI: 1.3.0.
- Optional subagents: 25.0.1 (resolved development dependency).
- `npm test`: 14 passed, 0 failed/skipped/cancelled, about 1.2 seconds in the final run. Includes failure cleanup and strengthened child-catalogue/invocation assertions.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Local dependency installs used `--ignore-scripts`; npm reported no known vulnerabilities in the resolved 125-package development tree at install time. This is not a production security review.
- At M0, macOS and the minimum Node 22.19 runtime had not been executed. M2 subsequently reran the combined suite on Node 22.19; see [the M2 report](m2-transactional-sync.md). macOS remains unverified.

## Decision and remaining limits

Retain the native-extension/background-staging design: the strengthened suite passed. The bounded startup-check fallback remains available if later production constraints require it. The next implementation stage is M1's synthetic manifest-to-resource vertical slice, not a live updater; this M0 step does not implement it.

M0 does **not** implement or validate real fetching, manifest resolution, archive/path/symlink security, five-second network/lock budgets, cross-process locking, atomic durable activation, corruption recovery, rollback controls, production diagnostics, packaging, or live terminal UX. Those remain M1–M4 work. `package.json` still exposes no extension or skills and remains private.
