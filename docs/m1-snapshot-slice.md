# M1: fixture-backed manifest-to-Pi slice

Status: M1 verified on the tested Linux host; 53 combined M0/M1 tests pass. Tracking: [issue #1](https://github.com/tahabakhit/pi-mattpocock-sync/issues/1). This slice does not make the package ready for installation or release.

## Implemented boundary

Three small modules connect a stable local snapshot to Pi:

- `src/snapshot.ts`: resolve the official manifest shape, capture a local tree, derive selected skill metadata, and compute content/mode provenance.
- `src/local-snapshot-store.ts`: copy captured bytes and relative links into a commit-specific directory, validate that copy, retain previous revisions, and change an in-process selection only after success.
- `src/pi-resources.ts`: offer only the selected `SKILL.md` file paths through native resource discovery, withhold all offered skills on an already-loaded name collision, and report unsupported manifest fields without activating them.

The resolver accepts an explicit `skills` array, including an empty array. It does not scan for extra skills or maintain a name/version list. It rejects invalid paths and duplicate selections, validates effective names and descriptions against the initial Pi target, and preserves user-only invocation metadata. A missing name falls back to the directory name as Pi does; ambiguous duplicate effective names or canonical file aliases are rejected.

The complete source tree stays outside Pi's automatically scanned skill roots. Only exact selected file paths are returned to Pi, so excluded and nested `SKILL.md` files remain undiscovered while shared support files retain their original locations.

## Content, links, and provenance

File bytes are never normalized on disk. Parsing uses a separate text view; original line endings, UTF-8 bytes, binary assets, license/attribution files, and executable permission bits are copied intact. Generated `provenance.json` lives beside `content/`, never inside upstream content.

The local capture bounds inputs to 10,000 entries and 32 MiB of file bytes. It rejects traversal, backslash/control-character paths, normalized/case-colliding paths, special files, hardlinks, escaping/broken/cyclic symlink chains, malformed manifest/frontmatter, and duplicate manifest keys. It does not follow directory links while copying; links are materialized after ordinary directories and files. Valid relative links are preserved rather than dereferenced into changed content.

Provenance records the official repository identifier, **caller-supplied commit**, manifest version and license declaration, selected names/paths, per-entry hashes/modes, and a deterministic tree digest. M1 does not fetch or authenticate a Git commit, so it does not independently prove the supplied commit's origin. It preserves a nonempty root `LICENSE`; it does not establish legal compatibility of an arbitrary future license declaration. Acquisition and license-change policy remain later production work.

The fixture tests verify shared relative references and link targets against the preserved tree. There is no claim that arbitrary prose, dynamically generated paths, Markdown anchors, or external URLs have been validated.

## Local store limitations

This is an explicit single-writer, caller-owned local-input boundary:

- Inputs must be stable snapshots, not concurrently edited Git working copies. No archive extraction or remote transport exists yet.
- The selected revision is held in memory, not a durable active pointer. There is no cross-process lock, crash-recovery protocol, or fsync guarantee.
- Same-commit imports must match stored bytes/modes; different content is rejected rather than overwriting that revision.
- An invalid candidate must leave the previous selection intact. Old revision directories are retained, so previously loaded Pi paths keep working.
- The module does not defend against a separate process maliciously replacing source/store ancestors while it runs. M2 must establish the acquisition/storage trust boundary before handling downloaded inputs as a production updater.

No default installed-package entrypoint or update commands are enabled. `package.json` remains private and its Pi resource lists remain empty. YAML is a runtime parsing dependency; Pi remains host-provided via a wildcard peer dependency, with the approved 1.3.0 test host pinned only in development dependencies.

## End-to-end evidence

The isolated suite uses synthetic manifests and the actual Pi loader/runtime with a fake provider. It covers:

- Manifest-selected-only names, including exclusion of nested/unselected skills.
- Exact original file bytes, shared references, license notices, safe relative links, and executable bits.
- Truthful offered revision/version status and explicit user-only invocation.
- Revision A staying active after B is imported, then additions/changes/removals after reload.
- An explicitly empty manifest removing the entire prior contribution on reload.
- Ordinary collision withholding and unsupported executable-resource diagnostics without activation.
- Invalid metadata/paths, duplicate selections, immutable same-commit reuse/mismatch, and last-good preservation on validation failure.

Verified on Linux x64 / Node 26.11.1 / npm 11.20.0 with Pi 1.3.0 and optional subagents 25.0.1. The resolver uses YAML 2.9.1; the pinned Pi host resolves its own YAML 2.9.0 parser.

- `npm ci --ignore-scripts`: passed from the lockfile; no lifecycle scripts run.
- `npm test`: 53 passed, 0 failed/skipped/cancelled, about 2.8 seconds.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Existing M0 tests remain part of the isolated run.

Focused review found four issues, all reproduced by five additional failing regressions: filesystem-order symlink resolution, divergent Pi frontmatter delimiters, external content-directory substitution during reuse, and invalid UTF-8 link-target rewriting. All four findings are fixed and their regressions pass. Additional cycle/path/BOM checks and the clean-install full rerun pass too. This is a focused review plus regression verification, not a production security audit. At M1, macOS and minimum Node 22.19 were untested; no active Pi installation, upstream download, or publication was performed in that milestone. See [M2](m2-transactional-sync.md) for subsequent minimum-Node and disposable public-source checks. macOS remains unverified.

## Next milestone

M2 adds official acquisition, bounded network/archive handling, durable atomic selection, cross-process locking, interruption/offline recovery, and rollback state. This M1 slice does not claim those guarantees, optional subagent production integration, macOS/minimum-Node verification, or release readiness.
