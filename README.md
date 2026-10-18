# pi-mattpocock-sync

An unofficial Pi integration that stays in sync with Matt Pocock's official agent skills.

**Status: scaffold only.** Synchronization, automatic updates, and compatibility glue are not implemented. Nothing is published or installable yet.

## Goal

Use the same skill set and unchanged skill files as the official Claude Code plugin, automatically following upstream updates—not a fork, curated subset, or independently maintained port.

Upstream: [mattpocock/skills](https://github.com/mattpocock/skills), specifically its [.claude-plugin/plugin.json](https://github.com/mattpocock/skills/blob/main/.claude-plugin/plugin.json).

### What “1:1” means

- The official plugin manifest determines which skills are exposed.
- Each selected skill and its supporting files remain byte-for-byte identical at a recorded upstream commit.
- Additions, changes, and removals are synchronized.
- Relative references retain their meaning and required supporting content stays available.
- Pi-specific adapters live separately; they never rewrite upstream skills.
- Identical model behavior across Claude Code, Codex, and Pi is not a requirement.

This is a Pi integration of the official skill content, not an emulator for every Claude plugin feature. If upstream adds executable hooks or other unsupported resources, report the compatibility gap instead of silently claiming full parity.

## Planned experience

Install once as a Pi package; subsequent sessions automatically obtain upstream skill updates before skill discovery. Expose the active upstream version, commit, and last update result. Keep the last validated version available offline and support rollback and disabling automatic updates.

The exact installation command and update mechanism remain to be designed and tested. Do not treat a normal Pi package installation as proof of automatic updates.

## Start building

Read [the implementation brief](docs/implementation-brief.md) and [AGENTS.md](AGENTS.md).

Suggested first agent task:

> Read README.md, AGENTS.md, and docs/implementation-brief.md. Verify the current upstream plugin layout and Pi package/resource lifecycle against primary sources. Propose the smallest design that preserves exact content parity and automatically updates before skill discovery. Identify decisions requiring owner approval, then implement a tested vertical slice.

## Development

This repository currently contains documentation and package metadata only. There are no runtime dependencies, scripts, tests, or shipped skill files yet. The package is marked private to prevent accidental publication; remove that guard only when release readiness has been verified.

## Attribution and license

Independent project; not created by or endorsed by Matt Pocock or the Pi maintainers.

Original integration code is MIT licensed. Upstream skills are owned by their respective authors and must retain their original license and notices when distributed. Verify the license at every imported revision.
