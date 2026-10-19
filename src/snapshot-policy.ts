import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { Marked } from "marked";
import { resolveEntry, type CapturedEntry, type Snapshot } from "./snapshot.ts";
import { SyncFailure } from "./sync-operation.ts";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
const markdown = new Marked({ gfm: true, async: false });

/** Conservative policy: preserve notices, but require review if MIT terms change. */
export async function verifySnapshotPolicy(snapshot: Snapshot, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (snapshot.license !== "MIT") throw new SyncFailure("license");
  const license = await readFile(join(snapshot.root, "LICENSE"), { encoding: "utf8", signal });
  const ownLicense = await readFile(new URL("../LICENSE", import.meta.url), { encoding: "utf8", signal });
  const start = license.indexOf("Permission is hereby granted,");
  const ownStart = ownLicense.indexOf("Permission is hereby granted,");
  if (start < 0 || ownStart < 0 || !/^MIT License\r?\n(?:\r?\n|Copyright[^\r\n]*\r?\n)+$/.test(license.slice(0, start))
    || normalize(license.slice(start)) !== normalize(ownLicense.slice(ownStart))) throw new SyncFailure("license");

  // Only actual Markdown link/image tokens count: code examples and arbitrary
  // prose paths are not treated as required supporting files. External URLs,
  // fragments, and absolute/project-environment paths are outside this check.
  const entries = new Map<string, CapturedEntry>(snapshot.files.map(info => [info.path, { info }]));
  for (const skill of snapshot.skills) {
    signal.throwIfAborted();
    const text = (await readFile(join(snapshot.root, skill.path), { encoding: "utf8", signal })).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const content = text.slice(text.indexOf("\n---", 3) + 4);
    const tokens = markdown.lexer(content);
    markdown.walkTokens(tokens, token => {
      if (token.type !== "link" && token.type !== "image") return;
      const href = token.href;
      if (!href || href.startsWith("#") || href.startsWith("/") || href.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      let path: string;
      try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { throw new SyncFailure("invalid"); }
      if (!path) return;
      if (posix.isAbsolute(path) || /^[a-z]:/i.test(path) || /[\\\x00-\x1f\x7f]/.test(path)) throw new SyncFailure("invalid");
      // Resolve components in filesystem order (including link/.. combinations)
      // against the captured tree, without touching an outside filesystem path.
      resolveEntry(`${posix.dirname(skill.path)}/${path}`, entries);
    });
  }
  signal.throwIfAborted();
}
