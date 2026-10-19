# Agent guide

## Read first

Read README.md, docs/implementation-brief.md, docs/implementation-plan.md, docs/m0-feasibility.md, docs/m1-snapshot-slice.md, docs/m2-transactional-sync.md, docs/m3-lifecycle.md, and docs/m4-packaging.md before implementing. M0 is a lifecycle experiment; M1 is a local snapshot slice; M2 owns transactional synchronization; M3 wires the source extension. Check each report's verification status. No active Pi installation or published package exists; M4 tests a disposable installed candidate. Do not report planned or unverified behavior as working.

## Product contract

- Synchronize the exact skill set declared by the official Claude plugin manifest.
- Preserve upstream skill content and supporting files byte-for-byte.
- Keep Pi compatibility code separate from upstream content.
- Automate updates, including added and removed skills.
- Record and expose the actual upstream version and commit.
- Behavioral equivalence between models/harnesses is out of scope.
- Do not replace the upstream source with a third-party port.

## Working rules

- Verify current Pi APIs and upstream layout against primary sources; do not assume a session-start hook runs before resource discovery.
- Keep architecture small. Establish a tested end-to-end slice before adding optional modes.
- Never hard-code a skill list or an upstream release version.
- Preserve directory structure and relative references; validate them with fixtures.
- Treat downloaded paths, manifests, archives, and symlinks as untrusted input.
- Do not execute upstream package lifecycle scripts as part of skill synchronization.
- Stage and validate updates before switching the active revision. Preserve the last good revision on failure.
- Never overwrite user-authored skills or register duplicate skills silently.
- Use synthetic fixtures in tests, not personal Claude caches or machine-specific paths.
- Preserve upstream attribution and license notices.
- No credentials, private configuration, local session transcripts, or personal filesystem details in this public repository.
- Do not install globally, schedule background services, publish npm packages, create GitHub resources, or push without owner approval.

## Verification

Scale tests to the change. Core sync coverage must include manifest selection, exact bytes, supporting references, removals, safe paths, interrupted/offline updates, concurrent updates, and version/commit reporting. Verify resource discovery in a real Pi session before claiming the integration works.

The toolchain is TypeScript, Node 22.19+, npm, and Node's test runner with a TypeScript loader. `npm test` runs the isolated core/lifecycle suites and M4 metadata/workflow checks; `npm run typecheck` checks source and test types. Follow docs/implementation-plan.md, scale verification as production code is added, and document what actually ran. The M0 fixture extension is not production code. The local importer assumes stable inputs and one writer; RevisionStore owns the SQLite writer protocol and durable selection. Keep its local-filesystem requirement, cancellation/commit boundary, and integrity checks intact. Ordinary tests allow only explicitly registered loopback servers, not public network access; the live smoke test is a separate opt-in command. Keep lifecycle tasks owned and cancelled/awaited on shutdown, captured resource paths immutable, and latest session attempts distinct from committed store checks. Missing/withheld parent contributions must not silently turn into child updates. Assert per-run compatibility guidance in the fake provider's received transcript, not the idle session.systemPrompt getter.

## Release

package.json is private intentionally, at development version 0.0.0. The public repository URL is selected and npm returned 404 for the proposed name during M4 preparation; that is not a reservation. Keep the exact file allowlist and wildcard host peer; do not bundle upstream content or another Pi SDK. `npm run test:package` has an explicit public npm dependency-install phase, then isolated offline runtime checks; it must never use active Pi configuration. Recheck naming/access and get separate owner approval before changing release guards or publishing. Do not claim a package is available until it has actually been published.
