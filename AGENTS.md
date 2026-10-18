# Agent guide

## Read first

Read README.md and docs/implementation-brief.md before implementing. This is a scaffold, not a working integration. Do not report planned behavior as implemented.

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

No test runner or build system has been selected yet. Add reproducible commands with the implementation and document what actually ran.

## Release

package.json is private intentionally. Choose the public repository URL and confirm npm name availability before adding release metadata. Do not claim a package is available until it has actually been published.
