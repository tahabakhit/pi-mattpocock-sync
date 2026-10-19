# Operating the sync package

This is an unofficial content integration, not a Claude plugin emulator or a promise of equivalent model behavior. The package remains **private and unpublished**. M4 package/platform qualification is in progress; do not treat candidate artifacts as a release.

## Requirements and loading

- Node 22.19+ and the initially qualified Pi 1.3.0 host. Other Pi versions are not claimed as tested.
- Linux or macOS with a local filesystem providing working SQLite locks, atomic rename, and fsync. macOS qualification remains pending; Windows and network/synchronized stores are unsupported.
- Runtime npm dependencies installed without lifecycle scripts. Pi supplies its own SDK; do not bundle another SDK copy.

The package manifest exposes `src/extension.ts`, not a compiled bundle or a static skills directory. No build is required: Pi loads TypeScript extensions through its own loader. The npm artifact contains integration code, these operating documents, and the integration's MIT license, not an upstream snapshot, personal configuration, or workers.

Do not use `pi install npm:pi-mattpocock-sync`: no package has been published. [Release checks](release.md) explain how actual candidate artifacts are verified in disposable consumers. Active installation is a separate owner decision; none of the following commands has been run against active Pi.

**Only after reviewing the local tarball and approving installation**, choose a new dedicated consumer directory and use the tested artifact layout:

```sh
npm install --prefix /absolute/path/to/new-consumer \
  --ignore-scripts --omit=dev --legacy-peer-deps \
  /absolute/path/to/pi-mattpocock-sync-0.0.0.tgz
pi install /absolute/path/to/new-consumer/node_modules/pi-mattpocock-sync
```

The first command installs runtime dependencies locally via npm; it does not install another Pi SDK. The second records the prepared local package in the selected Pi agent directory. Do not point Pi at an unreviewed checkout merely to test it. Keep that consumer directory available while Pi uses it. Start a fresh Pi session or `/reload` to discover the package; first bootstrap may fetch public upstream content.

To remove the local package declaration after approval, use `pi remove /absolute/path/to/new-consumer/node_modules/pi-mattpocock-sync`, then reload or stop Pi. Local removal does not delete the candidate directory or dedicated revision store; follow stopped-session cleanup guidance below. To test without affecting active Pi, use an explicitly disposable `PI_CODING_AGENT_DIR` and no personal settings/credentials instead.

## Startup and activation

Cached validated skills load before one background update check. The check follows the official default branch, resolves one commit, and stages that commit's unchanged snapshot. Added/changed/removed skills become active only after a full Pi `/reload` or fresh session. Resume also rediscovers current content; it does not permanently pin old conversations.

With no cached snapshot, an enabled automatic check attempts bounded bootstrap. Failure starts Pi without this package's skills, emits a warning, and leaves explicit retry available. Offline use with a valid cache retains those resources. Corrupt content is withheld rather than overwritten.

Automatic updates are on by default, with a 5000 ms update budget. There is no periodic scheduler, service, or background daemon. Initial local cache validation has its own bounded store read; synchronous parsing/SQLite/fsync cannot be forcibly preempted, so this is not a hard real-time guarantee. Pi's own `--offline` option controls core networking; use this package's automatic-update opt-out to disable its checks.

## Commands

| Command | Action |
| --- | --- |
| `/mattpocock status` | Show loaded/contributed, selected and previous revisions; automatic state/budget; latest session attempt and last committed check |
| `/mattpocock update [milliseconds]` | Explicit update, default 30000 ms; does not enable auto-update or reload |
| `/mattpocock retry [milliseconds]` | Same explicit path, useful after bootstrap failure |
| `/mattpocock rollback` | Select the validated previous revision and pause auto-update; reload/new session activates it |
| `/mattpocock auto off` | Cancel this session's automatic task and persist opt-out |
| `/mattpocock auto on` | Enable checks on subsequent session discovery, not an immediate check |
| `/mattpocock budget <milliseconds>` | Set the automatic budget, 1–300000 ms |
| `/mattpocock help` | Show usage |

Changing the selection does not rewrite files used by a running session. A timeout/cancellation may leave the last committed check unchanged; the latest session attempt is shown separately and is not retained through reload. Print/JSON diagnostics use stderr. Interactive/RPC notifications use Pi's UI interface; no modal response is needed.

## Store and recovery

Configuration and revisions live in `<Pi agent directory>/mattpocock-sync`, outside automatic skill-discovery roots. The default agent directory is Pi's normal user directory; `PI_CODING_AGENT_DIR` changes it. SDK embedders must align that environment setting with their SDK agent directory or explicitly inject a scoped store. Project overrides are not supported.

The store contains `state.sqlite`, immutable `revisions/<commit>/content`, adjacent provenance, and transient download/staging directories. Each imported snapshot preserves upstream layout, file bytes, supporting references, modes, license and notices. Old revisions remain available to running parent/child sessions. Disk use grows with distinct commits; v1 has no garbage collector.

- **Offline/network/HTTP:** keep using cached resources, retry later, or use a longer explicit budget. Credentials are not required for public GitHub reads. Rate limits can still apply.
- **Timeout:** status distinguishes an interrupted latest attempt from an older committed success. Increase a bounded budget if appropriate; do not disable validation.
- **Invalid input/license change:** keep the last good revision. Review upstream changes rather than bypassing the path, reference, integrity or MIT-terms checks.
- **Corrupt selected revision:** attempt `/mattpocock rollback` if a previous validated revision exists. Updates do not overwrite corrupted immutable content.
- **No usable rollback target or corrupt state:** stop every affected Pi/child session first. Back up the entire dedicated store, including any SQLite sidecars, before resetting it. Do not hand-edit the database or delete individual referenced revisions.
- **Full reset/cleanup:** only with all affected sessions stopped, back up and remove the entire dedicated store if discarding configuration/history is intended. Next startup bootstraps again; automatic updates revert to enabled. Do not delete user-authored skill directories.

M2 format-1 state is read with the default automatic budget; a successful M3+ write atomically persists format 2. Downgrading to M2 after that write is not supported. Restore a complete stopped-session backup if an approved downgrade is required.

## Collisions and compatibility

An already-loaded ordinary skill name collision withholds this package's entire contribution and reports the name/origin. User skills are never overwritten or renamed. Other extensions' dynamic contributions are buffered by Pi and deduplicated individually: collisions with them are unsupported, even if status happens to show every selected path. Do not claim exact-set parity in that configuration.

Separate compatibility instructions explain Pi skill reads and user-only `/skill:name` invocation. They do not rewrite upstream text or add a replacement Skill tool. Hidden/inactive tools are not usable merely because a package exists; indirect tools require an orchestration/search entrypoint.

Subagents are optional. The separately maintained `@gotgenes/pi-subagents` provides worker tools when installed/configured by the owner; synchronization does not require it. This package never installs dependencies into active Pi or creates workers itself. In-process children of the tested optional package inherit the parent's captured contribution and do not check again. Missing parent captures withhold synced skills. Cross-process inheritance and ambiguous custom/saved-child startup headers are not fully supported; explicit resume/new/fork uses fresh discovery.

Worktree isolation is not provided or verified. Stop workflows requiring absent capabilities, writable workers, configured models, or separate worktrees. Never substitute concurrent writes in one checkout. Upstream instructions do not grant permission to commit, push, install packages, create remote resources, or alter configuration.

## Trust and licensing

Automatic updates change trusted model instructions even when no extension code is executed. Snapshot hashes establish content integrity, not author trust or instruction safety. Review the source and opt out when automatic instruction updates are inappropriate.

No upstream hooks, npm lifecycle scripts, or executable plugin resources are automatically run by synchronization. Unsupported manifest fields are reported, not activated. A model following a skill may later request script execution; normal user approval and harness boundaries still apply.

Original integration code is MIT licensed; see [LICENSE](../LICENSE). Upstream authors retain their content ownership. Each downloaded revision preserves its license and notices. Current automatic import policy accepts the expected MIT terms and stops on changes requiring review; it is not a legal audit of every asset. No upstream content is bundled in the npm tarball.
