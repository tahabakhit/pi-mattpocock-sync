# Candidate verification and release gates

**Private and unpublished.** Version `0.0.0` identifies a development candidate, not an available npm release. Owner approval is required before committing/pushing implementation, active installation, or publication. M4 local qualification does not waive those gates.

Public repository: [tahabakhit/pi-mattpocock-sync](https://github.com/tahabakhit/pi-mattpocock-sync). The public npm registry returned HTTP 404 for `pi-mattpocock-sync` during M4 preparation; name availability is neither reserved nor guaranteed and must be rechecked immediately before a release.

## Reproducible development checks

From the repository, with Node 22.19+ and npm:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:package
git diff --check
```

`npm test` uses isolated temporary HOME/agent/XDG directories, synthetic snapshots, real Pi, and a fake provider. Only explicitly allowlisted loopback traffic is permitted; no real model calls or private caches are used. This is a tripwire, not an OS sandbox.

`npm run test:package` is a separate qualification command with a **public npm network phase**. It:

1. Builds the actual tarball using `npm pack --ignore-scripts` in a temporary destination.
2. Asserts that every packed file is exactly allowlisted, private publication guards remain set, and no lifecycle scripts or bundled host/worker dependencies are present.
3. Installs the tarball in an independent disposable consumer with `--ignore-scripts --omit=dev --legacy-peer-deps`, a private temporary npm cache/configuration, and no inherited credentials. Runtime dependency ranges resolve against public npm; actual versions are printed in the result.
4. Compares installed artifact bytes to the reviewed checkout and checks relative links in the shipped operating documents.
5. Runs isolated real Pi package discovery, reload/invocation, local package install/list/remove, CLI print/JSON, and RPC checks against the installed artifact. Runtime tests deny public network and use synthetic snapshots plus a fake provider.
6. Prints artifact contents/hash and dependency resolutions, then removes the tarball, consumer, npm cache and temporary homes.

The dependency installation intentionally resembles Pi's host-peer omission; it does not install another SDK or optional subagent package into the consumer. Pi itself is provided by the pinned development test host. Tarball qualification is not npm publication, a global install, or an active-Pi configuration change.

To produce a separately retained, reviewed candidate after qualification:

```sh
npm pack --ignore-scripts
```

This creates a local `pi-mattpocock-sync-0.0.0.tgz`; it does not publish it. Treat hashes as artifact-specific: documentation or metadata changes alter the tarball. Review the actual final artifact, not a previous dry-run file list.

## CI and platform qualification

The repository workflow prepares checks for Ubuntu and macOS on Node 22.19.0 and Node 26. Exact minimum-Node testing is a compatibility requirement, not an upstream release pin. It runs clean installation without lifecycle scripts, type checking, ordinary fixtures, and installed-tarball qualification. The workflow has read-only repository permissions, no secrets, publication step, or scheduled background service.

A workflow file is not a successful CI run. Until the owner approves pushing the implementation/workflow or supplies an authorized Mac runner, macOS and hosted CI remain **blocked/unverified**. Record the actual workflow run, commit, OS/architecture and dependency resolutions before marking those gates complete.

The public-upstream smoke is deliberately opt-in and outside deterministic CI:

```sh
RUN_PUBLIC_SMOKE=1 node --import tsx test/smoke-upstream.ts
```

It uses a disposable store, verifies current official layout and cached offline recovery, and removes that store. It does not exercise active installation or paid model behavior.

## Manual terminal check

Automated SDK/CLI/RPC evidence does not establish visual terminal UX. Before release, use a disposable Pi agent directory and reviewed package candidate, with no personal credentials/settings/extensions. Verify command discoverability, readable status/warnings, first-run offline and cached startup, update availability, `/reload` removals, rollback/opt-out, and orderly exit during an update. Record the Pi/Node/terminal/platform versions and observed results. Never claim this check passed merely because a notification method exists.

## Release checklist

- All required Linux/macOS/minimum-runtime checks passed at the exact proposed revision.
- Isolated actual-tarball loading and dependency separation passed; terminal presentation was checked.
- Final tarball contains only listed integration source, README, MIT license, and operating/release docs: no test payloads, development dependencies, caches, upstream snapshots, credentials, session data, personal paths, or project agent instructions.
- Runtime imports and shipped documentation references resolve from the artifact, independently of the checkout.
- Upstream attribution, content-preservation policy, default-branch tracking, update trust model, SQLite/local-filesystem constraints, retained-revision growth, and compatibility limits are documented in [usage](usage.md).
- Confirm repository URL, npm name/access and chosen release version. No publication is attempted to probe access.
- Obtain separate owner approval to remove `private: true`, choose release metadata/version, commit/push/tag, publish, and install into active Pi as applicable.
- Rebuild/review the artifact after any version/manifest change; verify actual registry availability after an approved publication before documenting npm install commands.

Do not add an automatic publication workflow or silently convert this development candidate into a release. See [operating guidance](usage.md) for recovery and uninstall/reset considerations.
