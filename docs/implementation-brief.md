# Implementation brief

## Approved scope

Build a public Pi package that automatically follows the official Matt Pocock Claude plugin's skill content. The public repository currently contains a scaffold and an approved implementation plan; runtime implementation awaits a separate owner go-ahead.

“1:1” refers to content and selected resources, not deterministic behavior or identical harness execution.

## Sources of truth

- Official upstream repository: https://github.com/mattpocock/skills
- Claude plugin manifest: .claude-plugin/plugin.json
- Pi package documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
- Pi skill documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md

Verify current primary sources before implementation. Follow one immutable upstream commit throughout each sync transaction; never combine a manifest from one revision with files from another.

Selected tracking policy: follow the upstream default branch, resolving one immutable commit per sync. This intentionally differs from following releases, marketplace-selected revisions, or the locally installed Claude version. Matching an installed local Claude version is outside v1 scope.

## Selected design direction

- Native Pi extension; initially verify against Pi 1.3.0 on Linux and macOS, without a launcher or older-version fallback. Use TypeScript, Node 22.19+, npm, and Node's test runner with a TypeScript loader.
- Use the awaited `resources_discover` event to return exact manifest-selected paths from an immutable validated revision. This runs after ordinary skill discovery; Pi then loads the dynamic resources and rebuilds its system prompt. This is source-level evidence, not yet a verified end-to-end integration.
- Prefer Claude-like activation: immediately load cached skills, prepare updates in the background, and activate on a fresh session or explicit Pi `/reload`. This supersedes the earlier blocking startup-check decision. Loaded paths must not change underneath a running session.
- Background updating is conditional on ordinary public lifecycle hooks. If it requires private APIs, monkey-patching, a scheduler, or a launcher, propose the simpler bounded startup-check fallback instead.
- Configurable five-second automatic update budget, including update lock/network waits; keep the last validated revision on failure. When there is no cache, attempt a bounded bootstrap, then continue Pi without this package's skills on failure, issue a clear warning, and offer an explicit retry with a longer timeout.
- One configuration and revision store per Pi agent directory; no project overrides. Retain immutable revisions in v1, document disk growth and cleanup with affected sessions stopped, and do not build automatic garbage collection.
- Minimal namespaced status, update/retry, rollback, and auto-update controls. Report loaded versus available revisions. Rollback selects the previous validated revision and pauses automatic updates; active resources change only on reload/new session.
- Minimal, optional subagent integration through the existing tools of `@gotgenes/pi-subagents` when installed. Document `pi install npm:@gotgenes/pi-subagents`; the package declares its source entrypoint itself.
- Do not build a worker framework, auto-install subagent packages, or rewrite upstream skills. Detect/report missing workflow capabilities rather than pretend full compatibility.
- The subagent core supplies spawning, background execution, result retrieval, and steering, not worktree isolation. Do not add its separate worktree companion in v1. Compatibility guidance must stop worktree-dependent workflows and explain the missing prerequisite; never substitute concurrent writes in a shared checkout. This guidance is not a runtime security boundary.
- On a collision with an already-loaded skill, preserve user-authored skills and withhold this package's entire skill set with an explicit conflict report. Do not rename or overwrite user skills. The owner narrowed this guarantee after source inspection: collisions with other extensions' dynamic skill contributions are unsupported in v1, because Pi buffers those contributions and resolves names individually without a public package-wide veto. Disclose the limitation and do not claim exact-set parity in that configuration.

Primary references: [Pi dynamic-resources example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/dynamic-resources/index.ts), [subagent documentation](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents#readme), and [subagent package manifest](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/package.json). These are moving references; reverify exact dependency versions when implementing.

## Initial portability findings

Inspection of the installed official plugin v1.3.1 found 27 manifest-selected skills. This is a historical baseline, not a list or version to hard-code.

- Instructions frequently say “call the Skill tool.” Pi normally loads skill instructions by reading files. Assess whether a small instruction bridge suffices or a compatibility tool is needed.
- Several workflows require parallel/background subagents; implementation workflows need writable workers and separate worktrees. Do not assume every Pi installation includes a compatible subagent extension.
- The setup skill prefers CLAUDE.md when present. Ensure setup guidance is visible to Pi without rewriting upstream content or changing user files silently.
- User-only skills use disable-model-invocation metadata; verify Pi's actual discovery and invocation semantics.
- Preserve supporting Markdown, scripts, assets, and relative references, not just SKILL.md.
- The initial manifest exposes skills, not a requirement to execute arbitrary Claude-specific plugin components.

Recheck these findings at the chosen upstream revision. Unsupported future manifest resources must produce a visible compatibility report.

## Minimal architecture to investigate

1. Fetch a single upstream revision and resolve its official plugin manifest.
2. Validate resource paths, supporting references, metadata, and upstream license.
3. Stage the selected skill trees and required shared supporting content unchanged.
4. Generate Pi resource registration separately, preserving the manifest's selected skill set.
5. Activate the revision atomically and record provenance and integrity information.
6. Automatically check for updates at an appropriate lifecycle point.

The skill update must finish before Pi discovers the active skills, or use a verified resource-refresh mechanism. Investigate Pi's real lifecycle before selecting an extension, launcher, or external scheduler. Avoid assuming that a normal session-start callback or an unpinned package declaration provides automatic updates.

Avoid copying the entire upstream repository into a discoverable skill root: that may expose experimental skills excluded from the official manifest.

## Update requirements

- Include additions, content changes, and removals from the official manifest.
- Preserve the active validated revision if offline, rate-limited, interrupted, or given invalid content.
- Serialize concurrent updates; never expose a partially written revision.
- Bound network waits; document update frequency and startup latency.
- Expose active upstream version/commit, last check, and failure status.
- Provide an auto-update opt-out and a recovery/rollback path.
- Do not run upstream install scripts or import executable plugin hooks implicitly.
- Reject traversal, out-of-root symlinks, unsafe extraction, and unexpected resource types.
- Document that automatic skill updates change trusted agent instructions, even when they contain no extension code.

## Acceptance criteria

- A fixture plugin manifest determines exactly the exposed skill names; no hand-maintained allowlist.
- Imported file hashes match the same upstream commit, including supporting content.
- Relative references resolve without changing imported files.
- A subsequent revision adds, changes, and removes skills correctly.
- Invalid updates and interrupted activation preserve the last good revision.
- Clean and offline startups load a validated revision with truthful status.
- Pi discovery and explicit invocation are verified in a real supported Pi version.
- A second startup demonstrates automatic updating without a manual update command.
- Compatibility limitations are documented separately from content-parity guarantees.
- Upstream licensing and attribution ship with redistributed content.

## Suggested implementation sequence

1. Verify upstream tracking policy and Pi lifecycle; record the chosen approach.
2. Implement a pure manifest resolver and content-parity tests using synthetic fixtures.
3. Implement staged sync, provenance, safe activation, and failure/recovery tests.
4. Integrate Pi resource discovery and the minimal compatibility bridge.
5. Add and verify automatic updating across successive launches.
6. Document installation, trust model, limitations, diagnostics, and release procedure.

## Implementation gates

See [the approved implementation plan](implementation-plan.md) for milestones, verification, and the separate implementation go-ahead.

- Prove native discovery, reload removals, supported collision detection, and simple background staging in isolated real Pi tests. Fall back only after reporting any lifecycle limitation.
- Verify optional subagent resource inheritance without adding orchestration. Return for a scope decision if consistent revisions require invasive integration.
- Pi 1.3.0 is the initial verification target, not yet a tested compatibility claim.
- Prepare npm packaging while keeping `private: true`; actual publication and active installation need separate approval. The public repository is https://github.com/tahabakhit/pi-mattpocock-sync. An npm lookup found no package under the proposed name, but name availability is not reserved or guaranteed.

Do not publish, install globally, or create external resources as part of answering these questions without approval.
