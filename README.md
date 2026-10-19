# pi-mattpocock-sync

An unofficial Pi package that synchronizes Matt Pocock's official Claude plugin skills without rewriting their content.

**Private, unpublished development candidate.** Core, package/CLI/RPC, and official standalone Pi checks pass on Linux. Live upstream synchronization and 27/27 selected skills were verified before an owner-authorized local installation. macOS and visual terminal qualification remain incomplete; see issue #1 for exact evidence. Nothing is published on npm.

## Content contract

- The official [plugin manifest](https://github.com/mattpocock/skills/blob/main/.claude-plugin/plugin.json) selects the exact skill set—no hard-coded list or third-party port.
- Each sync resolves one immutable commit from the official upstream default branch.
- Snapshot files, supporting references, structure, modes, attribution and license notices are preserved. Pi compatibility guidance stays separate.
- Added/changed/removed skills are synchronized, including an empty manifest.
- Actual upstream version and commit are reported. Content parity does not promise identical model behavior or every Claude workflow capability.

## Lifecycle

Load validated cached skills first; prepare one bounded update in the background. Activate the selected revision on a fresh session or explicit Pi `/reload`, never by changing files underneath a running session. With no cache, attempt bounded bootstrap and continue without these skills if it fails.

Automatic checks default to a 5000 ms budget. Explicit update/retry defaults to 30000 ms. Rollback selects the previous validated snapshot and pauses automatic updates. Store configuration and retained immutable revisions live in `<Pi agent directory>/mattpocock-sync`, outside scanned skill roots. No daemon, scheduler, project override, or automatic garbage collection is installed.

Automatic updates change trusted agent instructions. Integrity hashes do not establish author trust. Unknown executable plugin resources are reported, not activated; synchronization never runs upstream package lifecycle scripts.

## Controls

```text
/mattpocock status
/mattpocock update [milliseconds]
/mattpocock retry [milliseconds]
/mattpocock rollback
/mattpocock auto on|off
/mattpocock budget <milliseconds>
```

Status distinguishes loaded/contributed resources, available/previous revisions, latest session attempts, and the last committed check. Print/JSON diagnostics go to stderr; interactive/RPC uses notifications. See [operating guidance](docs/usage.md) for activation, recovery, configuration, trust and storage limits.

## Compatibility and requirements

- Node 22.19+ or the official standalone Pi executable (embedded Bun); initially tested against Pi 1.3.0. The store selects the runtime's native SQLite driver and shares the same database format. Linux is verified; macOS is targeted but still pending qualification. Windows and network/synchronized stores are unsupported.
- Pi supplies its SDK. The artifact ships TypeScript source and small runtime parser dependencies, not another Pi installation or static upstream skills.
- Ordinary name collisions withhold this package's entire contribution and preserve user skills. Other extensions' dynamic skill collisions are unsupported; exact-set parity is not guaranteed in that configuration.
- Subagents are optional. Minimal guidance uses the existing `subagent`, `get_subagent_result`, and `steer_subagent` tools from a separately installed/configured [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents). No worker framework or dependency installation is supplied.
- Tested in-process children inherit the parent's contribution without another update check. Missing parent captures fail closed; cross-process inheritance is unsupported.
- Worktree isolation is not supplied or verified. Missing workflow prerequisites must stop that workflow; never substitute parallel writes in a shared checkout. Guidance does not grant permission for commits, pushes, configuration changes, or remote resources.

## Candidate verification—not npm installation

There is no published npm package to install. Active installation and publication require separate approval. The package manifest exposes the source entrypoint for isolated candidate testing; `private: true` remains set.

From the repository:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:package
# Optional: qualify the exact standalone Pi runtime's SQLite implementation:
node test/standalone-run.mjs /absolute/path/to/pi
```

Ordinary fixtures are synthetic/offline except explicitly allowlisted loopback servers. The separate package check creates the actual tarball, installs only its production dependencies into a disposable consumer via public npm, checks contents/byte identity, and runs isolated real-Pi package/CLI/RPC checks with a fake provider. It does not touch active Pi or call a real model. See [release checks and gates](docs/release.md).

Development decisions and milestone reports are tracked in the [public repository](https://github.com/tahabakhit/pi-mattpocock-sync) and [issue #1](https://github.com/tahabakhit/pi-mattpocock-sync/issues/1). The local installation requires Pi `/reload` or a fresh session to activate.

## Attribution and license

Independent project; not created by or endorsed by Matt Pocock or the Pi maintainers. Original integration code is [MIT licensed](LICENSE). Upstream content belongs to its respective authors and retains original license and attribution notices in each downloaded snapshot. The npm artifact does not bundle upstream content.
