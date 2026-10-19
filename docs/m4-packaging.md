# M4: package qualification and release readiness

Status: **in progress, not release-ready**. The owner authorized M4 and subsequently approved committing/pushing the implementation and workflow after local checks/review pass, then running hosted Linux/macOS CI. Hosted results and visual terminal qualification remain pending. Active Pi installation and npm publication are not authorized. Tracking: [issue #1](https://github.com/tahabakhit/pi-mattpocock-sync/issues/1).

## Candidate changes

- `package.json` stays private at `0.0.0`, declares the selected public repository, Linux/macOS OS boundary, wildcard host peer, and the actual `./src/extension.ts` Pi entrypoint. Skills/prompts/themes are explicitly empty; upstream resources remain dynamically selected at runtime.
- The npm `files` list names exact integration source files, README, LICENSE and the two operating/release documents. No test code, project instructions, development dependencies, caches, local sessions, or downloaded upstream snapshot should ship.
- `test/package-run.mjs` packs the artifact, compares exact contents and installed bytes, installs production dependencies in a disposable independent consumer, and checks dependency isolation and shipped documentation references. Its npm download phase is separate from ordinary offline tests and uses isolated configuration/cache without inherited credentials.
- `test/fixtures/package-check.ts` exercises real Pi discovery from the installed package directory via package settings, not an explicit source extension or injected factory. It tests catalogue/invocation/support files/reload, real CLI text/JSON diagnostics, and RPC command/notification behavior using synthetic data and the fake provider.
- `test/run.mjs` has an explicit package-test mode. Temporary roots are canonicalized to avoid macOS `/var`/`/tmp` symlink aliases interfering with intentional store-containment checks.
- `.github/workflows/verify.yml` prepares Ubuntu/macOS checks for Node 22.19.0 and Node 26, with read-only repository permission, no retained Git credentials, and no publishing or scheduled service. Official latest release metadata was checked before selecting the actions/checkout and actions/setup-node v7 major lines.
- README and [usage](usage.md)/[release](release.md) explain candidate status, activation, controls, update trust, retained storage, recovery, licensing and remaining gates. Relative links needed by artifact readers are included in the artifact.

The npm registry returned HTTP 404 for the proposed name during preparation; the public repository URL/visibility was independently checked. Neither observation reserves a name or authorizes publishing.

## Verification

Final local clean qualification passed:

- `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm run test:package`, and whitespace validation.
- Linux x64 / Node 26.11.1 / npm 11.20.0: 132 ordinary tests (about 11.9 s) and five installed-artifact checks (about 4.9 s), with zero failures/skips/cancellations.
- Node 22.19.0: the same 132 ordinary tests (about 13.6 s) and five installed-artifact checks (about 4.9 s), with zero failures/skips/cancellations. The official temporary Linux runtime was checksum-verified against its SHASUMS and removed; system Node was unchanged.
- Artifact: `pi-mattpocock-sync-0.0.0.tgz`, 15 files, 92,481 bytes unpacked. Both runtimes produced SHA-256 `7c1c93d40b1e3de6478344a11e129f798f3f3f459a9fa1a08bb31128bc859629`. Temporary tarballs/consumers/caches were removed.
- Runtime roots resolved independently inside the consumer: YAML 2.9.1, Marked 18.1.1, tar-stream 3.2.2. Its remaining resolved closure was b4a 1.9.0, bare-events 2.9.2, bare-fs 4.8.4, bare-path 3.1.2, bare-stream 2.13.4, bare-url 2.5.5, events-universal 1.0.1, fast-fifo 1.3.2, streamx 2.28.1, teex 1.0.1 and text-decoder 1.2.7. No physical Pi SDK, worker, TypeScript or tsx package was present in the consumer.
- The pinned development host was Pi/Pi AI 1.3.0. Real CLI text/JSON/RPC children used plain Node with only the network-denial preload, not tsx; Pi's own loader handled the installed TypeScript entrypoint. Extension load errors/warnings were empty.

Hosted Ubuntu/macOS results remain pending the approved push. These local results do not establish macOS or visual-terminal behavior.

Two test-harness assumptions were caught by real CLI checks: print/JSON needs EOF on piped stdin, and Pi stores local-package sources relative to the settings directory. The harness now closes one-shot stdin explicitly and checks resolved install destinations plus actual post-install skill invocation. All five artifact tests now pass, including installation source resolution, post-install invocation and preservation of settings/store data on local removal. Focused static M4 review found no actionable defect; this is not a security audit or a substitute for runtime results.

## Remaining approval and qualification gates

1. **Passed locally:** actual-artifact qualification, including the minimum Node runtime.
2. Perform the approved push after local gates pass, run the full hosted Linux/macOS matrix, and record its evidence. No existing Mac host/configuration is assumed or changed.
3. Perform the documented visual-terminal check in a disposable environment; SDK or RPC success alone is not visual rendering evidence.
4. **Passed for the recorded artifact:** contents, bytes, dependency isolation and shipped documentation links reviewed/tested. Repeat after any packaged documentation/manifest changes.
5. Obtain separate owner approval for commit/push, release version/guard changes, publication and active installation as applicable. Keep issue #1 open while required gates remain unmet.

M4 does not add a worker framework, worktree companion, updater service, release automation, private provider calls, or upstream content rewrites. See [M3](m3-lifecycle.md) for the lifecycle/content guarantees and explicit inheritance/dynamic-collision limitations.
