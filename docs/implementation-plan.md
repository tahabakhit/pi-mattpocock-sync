# Implementation plan

Status: plan approved; awaiting a separate implementation go-ahead. Runtime implementation has not started. Canonical implementation tracker: [GitHub issue #1](https://github.com/tahabakhit/pi-mattpocock-sync/issues/1). Begin with the bounded proof of concept in M0 only after the owner authorizes implementation. The discovery feasibility gate precedes production sync implementation.

## Product boundary

Build a small Pi package that follows the official Matt Pocock plugin manifest, preserves upstream skill content and supporting references, and automates safe updates. This is not a Claude plugin emulator, worker framework, or promise of identical model behavior.

### Owner decisions

- Track the official upstream default branch. Resolve one immutable commit for each transaction; the manifest version is reported, not used as the sole update key.
- Prefer Claude-like activation: cached skills load immediately, an ordinary in-process background check prepares a new revision, and a new session or explicit Pi `/reload` activates it. Do not silently change files underneath an active session.
- Background updates are optional if they require deep harness integration. Prove ordinary public lifecycle hooks suffice first. If private APIs, monkey-patching, a scheduler, or a launcher would be needed, present a bounded startup-check fallback instead.
- Use a configurable five-second automatic update budget, including lock and network waits. With no cache, attempt a bounded bootstrap; otherwise start without these skills, report the failure, and offer explicit retry. Never imply skills loaded when they did not.
- Use a native extension, initially verified against Pi 1.3.0; no older-version adapter or launcher in v1.
- Keep one configuration and immutable revision store per Pi agent directory, shared by projects using that directory. No project overrides or changes to user skill directories.
- Keep status, update/retry, rollback, and auto-update on/off controls in one namespaced command family. Use Pi's reload rather than inventing another resource-refresh mechanism.
- Rollback selects the previous validated revision and pauses automatic updates. It does not silently replace an active session's loaded paths; report when reload is needed. Explicit update must not silently re-enable auto-update.
- Preserve user skills. On a collision with an already-loaded skill, withhold this package's entire set and report the conflicting names and available origins. The owner explicitly narrowed this guarantee: collisions with other extensions' dynamic contributions are unsupported in v1; disclose Pi's first-name-wins behavior and do not claim exact-set parity in that configuration.
- Use only minimal, optional compatibility guidance for the installed `@gotgenes/pi-subagents` tools. Do not auto-install it, implement workers, configure models, or add its worktree companion.
- When a workflow requires missing capabilities, explain the prerequisite and stop that workflow in compatibility guidance. In particular, do not substitute parallel writes in one checkout for separate worktrees. Guidance is not a security enforcement boundary.
- Support Linux and macOS. Windows is explicitly unverified and unsupported in v1.
- Use TypeScript, Node 22.19+, npm, and Node's test runner with a TypeScript loader. Keep dependencies small; choose maintained parsers/extractors instead of inventing archive or YAML formats.
- Retain validated immutable revisions in v1; reuse an existing commit rather than duplicate it. No automatic garbage collector. Document disk growth and safe cleanup only with affected Pi sessions stopped.
- Aim for npm readiness, not publication. Keep `private: true` until separate release approval. Do not install into active Pi, publish, or push implementation without owner approval.

## Primary-source findings and limits

- Installed Pi 1.3.0 awaits `resources_discover` handlers after `session_start`, then loads their resource paths and rebuilds its system prompt. The official [dynamic resources example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/dynamic-resources/index.ts) uses this event. This has been inspected in source, not yet exercised by this package.
- Claude documents [background updates with explicit reload/new-session activation](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated). Its [loading reference](https://code.claude.com/docs/en/plugins/loading#when-auto-update-runs) also describes delayed interactive checks and manifest-version-based cache identity. We are not copying that delay, marketplace machinery, or version gating: commit tracking and the five-second budget are explicit project choices.
- Upstream inspection at commit `49dd158d1076134a641b33efb035946536778336` found a version `1.3.1` manifest selecting 27 skills, an MIT license, and 190 files totaling about 735 KB, including an internal symlink entry. These are research observations, never runtime constants or a maintained skill list.
- The [subagent package documentation](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents#readme) documents `subagent`, `get_subagent_result`, and `steer_subagent`; worktree isolation is a separate package. Its documented install is `pi install npm:@gotgenes/pi-subagents`, without `:src`.
- An npm lookup found no published package under `pi-mattpocock-sync`. This neither reserves the name nor proves that publishing it will be allowed; recheck at release.

## Architecture: small modules, immutable resources

Suggested seams, not a mandatory directory hierarchy:

1. **Manifest and snapshot validation**: resolve selected skill paths and names, validate metadata and safe filesystem structure, retain license/attribution, and calculate provenance and hashes. Do not execute downloaded code.
2. **Revision store and synchronization**: fetch one commit, stage and validate it, serialize writers, and atomically publish a small selection record. Own failure recovery, rollback, and configuration writes.
3. **Pi extension**: register the validated selected resources, coordinate startup/reload/background work, present status and controls, and supply separate minimal compatibility guidance.

### Snapshot representation

Preserve the upstream directory structure inside a revision directory outside Pi's automatically scanned skill roots. A complete validated repository snapshot is the initial candidate because it preserves shared relative references without rewriting files; register only exact manifest-selected `SKILL.md` paths, never the repository root or a recursive parent containing unselected skills.

Keep each completed revision immutable. Return paths containing its commit identity, not paths through a mutable `current` symlink. Separate these concepts:

- **Loaded revision**: the snapshot this session's resources refer to.
- **Selected revision**: the validated snapshot chosen for the next discovery/reload.
- **Previous revision**: the rollback target.
- **Update result**: last check, success/failure/timeout, and whether a different revision is available.

Store the actual upstream repository, resolved commit, manifest version, selected resources, license information, and per-file hashes. A hash verifies retained content against the downloaded snapshot; it does not establish author trust or make arbitrary instructions safe.

### Filesystem and network boundary

- Resolve the default branch and commit from the official upstream; fetch all transaction data from that immutable commit. No personal Claude cache or GitHub credentials required.
- Enforce bounded response/archive/file counts and sizes, cancellation, and allowed public source hosts. Values are implementation limits to justify with fixture tests and the observed repository size, not promises of unlimited future content.
- Validate archive entries before filesystem writes: reject traversal, absolute paths, ambiguous normalized duplicates, case collisions on supported filesystems, special devices, unsafe hardlinks, and paths resolving outside the staged root.
- Handle symlinks explicitly. Validate containment and cycles and never extract a later file through a link. Preserve safe upstream references; a reject-all-links strategy must not accidentally reject the actual upstream layout without explanation.
- Never run upstream lifecycle scripts, import upstream extension code, activate executable hooks, or discover unrelated plugins/skills. Unknown executable resources produce a compatibility report, not silent activation.
- Validate required relative supporting references against the snapshot. Define which static reference forms can be checked; do not claim arbitrary prose, dynamic paths, or external URLs have been fully verified.
- Retain the last good selection if anything fails. A failed stage is never a discovery root.
- Use a reviewed cross-process locking protocol with tests for abandoned locks, bounded contention, and process death. Re-read selection/config under the lock before committing so an older update cannot undo rollback or opt-out.
- Use same-filesystem staging and atomic publication. Test interruption at each stage and publication boundary. Never delete a prior immutable revision during update or reload.

### Lifecycle and optional compatibility

First prove these behaviors against real Pi, not mocks alone:

- Capture a session's loaded revision before starting background work. A faster-than-expected update must not race initial discovery into a mixed snapshot.
- A background check is a single cancellable task, not a service, periodic timer, or custom scheduler. Session shutdown/reload cancels or safely finishes owned work; never retain an unhandled promise or write from stale extension state.
- Explicit `/reload` must replace the resource set, including upstream removals. Merely returning additional paths is not proof that old paths disappear.
- Saved-conversation resume uses normal fresh-session resource discovery, not permanent historical plugin pinning. Report loaded/available provenance truthfully.
- Subagents should use the parent's loaded snapshot when inheriting resources, not silently select a newly downloaded revision or launch another update check. Verify the existing package's inheritance behavior; if it cannot be achieved with a minimal public integration, document the gap and return for a scope decision rather than build an orchestrator.
- Bridge upstream references to the Skill tool with Pi's existing skill-loading mechanisms. Preserve user-only skill invocation metadata. Prefer short separate instructions over adding another tool.
- Detect optional subagent tools/capabilities through supported runtime surfaces. Do not assume a package name alone guarantees a working writable worker or safe worktree.
- Keep compatibility and diagnostic behavior usable in non-interactive modes; do not require a terminal widget or modal dialog to report an error. Do not emit raw downloaded/error text that could leak local configuration.

## Collision contract and verified API limitation

Source inspection found that `pi.getCommands()` exposes already-loaded skills, including user-only skills, so a discovery handler can withhold its entire contribution on those collisions. Other discovery handlers' returned paths remain buffered until every handler finishes; even loading this extension last does not expose them. Pi then deduplicates individual names, retaining the first and recording diagnostics. The native extension API has no aggregate validation/retraction transaction.

The owner approved a narrower v1 guarantee: all-or-nothing withholding for already-loaded skills, with other dynamic-extension collisions explicitly unsupported. Do not patch Pi, rename imported skills, or hide only their display entries.

The runtime proof must:

1. Exercise a colliding ordinary skill and verify both catalog and explicit commands preserve it while none of this package's skills load.
2. Exercise two dynamic extensions in both orders and document the native first-name-wins limitation instead of asserting package-wide protection.
3. Verify collision-free exact-set discovery and full reload removal, including an empty new contribution.
4. Distinguish the manifest-selected set, resources contributed by this extension, and the effective loaded set. Do not present a known partial set as full parity; do not claim detection of every rejected dynamic contender through public APIs.

## Implementation sequence and acceptance gates

### M0 — Native lifecycle feasibility

Create a disposable fixture-only proof of concept using the initial supported Pi version. No live model calls or active-home discovery.

Demonstrate dynamic discovery, explicit invocation, reload removals, collision behavior, cached-first registration, and cancellation of a delayed background update. Verify optional subagent resource inheritance against the intended package version without executing real paid agents. Resolve or explicitly defer each API limitation with the owner.

**Exit:** an evidenced architecture decision, not just API presence. If background work requires invasive integration, propose the bounded startup fallback. Verify the narrowed collision guarantee and document the unsupported dynamic case. Return to the owner if even the supported guarantee or minimal subagent integration needs a scope change.

### M1 — Fixture-backed end-to-end slice

Implement a fixture manifest/snapshot resolver and minimal store-to-Pi path. Supply two synthetic revisions with selected and unselected skills, shared support files, a user-only skill, and an addition/change/removal.

**Exit:** real isolated Pi discovers exactly the declared set, supporting bytes and references remain intact, and reload replaces the set correctly. No hard-coded upstream names, paths, or version constants.

### M2 — Safe acquisition and transactional updates

Add official upstream resolution and bounded snapshot acquisition behind testable interfaces. Implement path/link validation, immutable storage, provenance, atomic selection, cross-process locking, interruption recovery, and rollback state.

**Exit:** fixture HTTP and filesystem fault tests prove timeouts/offline/rate-limit/invalid archive/concurrent writers/process death cannot expose a partial revision or destroy the last good one. A controlled public-source smoke test may verify current layout and bytes, but ordinary tests remain synthetic and offline.

### M3 — Session lifecycle, minimal controls, compatibility

Connect the proven background or approved fallback path. Add namespaced status, explicit update/retry, rollback, and auto-update controls. Report loaded versus available revisions; implement first-run warnings and graceful missing-capability diagnostics. Add only the minimal supported subagent guidance.

**Exit:** successive starts and explicit reload show the agreed activation semantics; active paths remain stable; rollback pauses updates even across concurrent checks. Core operation works with the subagent extension absent. No worktree orchestration or automatic dependency installation is introduced.

### M4 — Verification, documentation, npm readiness

Run Linux/macOS CI, type checking, focused unit/integration tests, real isolated Pi discovery/invocation tests, package-content inspection, and production-loader checks. Document install commands only for artifacts actually usable at that stage.

**Exit:** a reproducible verification report, explicit compatibility limits, and a reviewed package tarball with license notices and no caches, session data, personal paths, credentials, or test-only payloads. Keep publication and active installation blocked pending owner approval.

## Required verification matrix

| Area | Essential evidence |
| --- | --- |
| Selection and parity | Manifest alone selects the set; unchanged bytes and modes where relevant; supporting files and references; additions/removals; unselected resources stay undiscovered |
| Untrusted input | Traversal, absolute/backslash paths, case and normalized collisions, unsafe links, cyclic links, duplicate entries, special files, malformed metadata/manifest, archive expansion/size limits |
| Recovery | First-run offline warning, cached offline use, timeout and rate limit, interrupted downloads and activation, corrupt state/snapshot, no valid rollback target |
| Concurrency | Competing processes, abandoned locks, update versus rollback/opt-out, shutdown/reload during work, no partial resources |
| Real Pi | Catalog and explicit invocation, user-only metadata, both collision load orders, reload removal, loaded/available status, two successive starts, supported headless behavior |
| Optional subagents | Absent tools, installed tools, inherited revision, child lifecycle without repeated sync, clear worktree limitation; no real provider calls required for structural tests |
| Packaging | Linux/macOS, Node baseline, initial Pi target, published-file allowlist, loader resolution, preserved notices, private publication guard |

Use isolated temporary homes/agent directories and synthetic fixture repositories. Record exact tested versions and commands. Tests must not read personal settings, caches, transcripts, or credentials. A source inspection, mocked event, or successful package install alone is not an end-to-end pass.

## Plan approval and tracking

Use one canonical public GitHub issue for this package's implementation, with links to this plan, acceptance criteria, blockers, and verification evidence. Do not create a separate issue for each internal step unless the owner later asks.

The owner approved this plan and publication of its planning documents, not runtime implementation. Obtain a separate implementation go-ahead before M0 and return for approval if a feasibility finding changes the agreed guarantees. npm publication, active Pi installation, external provider calls, additional companion packages, and upstream Pi changes remain separate approval gates.
