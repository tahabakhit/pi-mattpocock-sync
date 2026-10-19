import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { parseDocument } from "yaml";

export const UPSTREAM_REPOSITORY = "https://github.com/mattpocock/skills";
const MAX_ENTRIES = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
// Link targets are paths: a leading BOM is a real filename character.
const linkDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
export const PATH_LIMITS = Object.freeze({ bytes: 1024, depth: 64, componentBytes: 255, aggregateBytes: 2 * 1024 * 1024, resolutionSteps: 256 });
export function validatePathBounds(value: string): void {
  const parts = value.split("/");
  if (Buffer.byteLength(value) > PATH_LIMITS.bytes || parts.length > PATH_LIMITS.depth
    || parts.some(part => Buffer.byteLength(part) > PATH_LIMITS.componentBytes)) throw new Error("Snapshot path size/depth limit exceeded");
}
export function validateRelativePath(value: string): string {
  validatePathBounds(value);
  if (!value || posix.isAbsolute(value) || /^[a-z]:/i.test(value) || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Unsafe relative snapshot path");
  }
  return value;
}
export const canonicalPathKey = (path: string) => path.normalize("NFC").toLowerCase();

export function resolveManifest(value: unknown) {
  const manifest = object(value, "Plugin manifest");
  const name = string(manifest.name, "Plugin name");
  const version = string(manifest.version, "Plugin version");
  const license = string(manifest.license, "Plugin license");
  if (!Array.isArray(manifest.skills)) throw new Error("Manifest skills must be an explicit array");
  const seen = new Set<string>();
  const skillDirectories = manifest.skills.map(value => {
    const path = string(value, "Manifest skill path");
    if (!path.startsWith("./")) throw new Error("Manifest skill paths must start with ./");
    const relative = validateRelativePath(path.slice(2));
    const key = canonicalPathKey(relative);
    if (seen.has(key)) throw new Error("Duplicate or case-colliding manifest path");
    seen.add(key);
    return relative;
  });
  const metadata = new Set(["name", "version", "license", "skills", "description", "author", "homepage", "repository", "keywords", "metadata"]);
  const unsupportedFields = Object.keys(manifest).filter(key => !metadata.has(key)).sort()
    .map(key => /^[a-z][a-z0-9_-]{0,63}$/i.test(key) ? key : "unrecognized-field");
  return { name, version, license, skillDirectories, unsupportedFields };
}

export interface SnapshotFile {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly sha256?: string;
  readonly target?: string;
}
export interface SnapshotSkill {
  readonly name: string;
  readonly description: string;
  /** Snapshot-relative SKILL.md path; never a recursive discovery root. */
  readonly path: string;
  readonly disableModelInvocation: boolean;
}
export interface Snapshot {
  readonly root: string;
  readonly repository: string;
  readonly commit: string;
  readonly version: string;
  readonly name: string;
  readonly license: string;
  readonly files: readonly SnapshotFile[];
  readonly skills: readonly SnapshotSkill[];
  readonly unsupportedFields: readonly string[];
  readonly digest: string;
}
export interface CapturedEntry { info: SnapshotFile; bytes?: Buffer }

/** Resolve links against captured entries, never follow them while copying. */
export function resolveEntry(path: string, entries: Map<string, CapturedEntry>): CapturedEntry {
  const pending = path.split("/");
  const resolved: string[] = [];
  let hops = 0, steps = 0;
  while (pending.length) {
    if (++steps > PATH_LIMITS.resolutionSteps) throw new Error("Snapshot path resolution limit exceeded");
    const component = pending.shift()!;
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!resolved.length) throw new Error("Snapshot link points outside root");
      resolved.pop();
      continue;
    }
    const prefix = [...resolved, component].join("/");
    const entry = entries.get(prefix);
    if (!entry) throw new Error("Missing snapshot path or broken link");
    if (entry.info.kind === "symlink") {
      if (++hops > 64) throw new Error("Snapshot link cycle or excessive link depth");
      const target = entry.info.target!;
      validatePathBounds(target);
      if (posix.isAbsolute(target) || /^[a-z]:/i.test(target) || /[\\\x00-\x1f\x7f]/.test(target)) throw new Error("Unsafe snapshot link");
      // Expand a link before interpreting subsequent '..' components, just as
      // the filesystem does. Lexical normalization first can hide an escape.
      pending.unshift(...target.split("/"));
    } else {
      if (pending.length && entry.info.kind !== "directory") throw new Error("Snapshot path traverses a non-directory");
      resolved.push(component);
    }
  }
  return resolved.length ? entries.get(resolved.join("/"))!
    : { info: { path: "", kind: "directory", mode: 0o755 } };
}

/**
 * Capture a caller-owned, stable local snapshot. M1 is not an archive extractor
 * or a security boundary against another process mutating the source tree.
 */
export async function captureSnapshot(sourceRoot: string, commit: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Invalid immutable commit ID");
  const root = await realpath(sourceRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error("Snapshot root must be a directory");
  const entries = new Map<string, CapturedEntry>();
  const foldedPaths = new Set<string>();
  let bytesRead = 0, pathBytes = 0;
  async function visit(directory: string) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      signal?.throwIfAborted();
      const path = validateRelativePath(directory ? `${directory}/${name}` : name);
      if (path === ".git") throw new Error("Pass a snapshot, not a Git working copy");
      const key = canonicalPathKey(path);
      if (foldedPaths.has(key)) throw new Error("Case or normalization collision in snapshot");
      foldedPaths.add(key);
      pathBytes += Buffer.byteLength(path);
      if (pathBytes > PATH_LIMITS.aggregateBytes) throw new Error("Snapshot aggregate path limit exceeded");
      if (foldedPaths.size > MAX_ENTRIES) throw new Error("Snapshot entry limit exceeded");
      const full = join(root, path);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        const targetBytes = await readlink(full, { encoding: "buffer" });
        let target: string;
        try { target = linkDecoder.decode(targetBytes); }
        catch { throw new Error("Snapshot link target is not valid UTF-8"); }
        validatePathBounds(target);
        pathBytes += targetBytes.length;
        if (pathBytes > PATH_LIMITS.aggregateBytes) throw new Error("Snapshot aggregate path limit exceeded");
        entries.set(path, { info: { path, kind: "symlink", mode: 0o777, target, sha256: sha256(targetBytes) } });
      } else if (stat.isDirectory()) {
        entries.set(path, { info: { path, kind: "directory", mode: stat.mode & 0o777 } });
        await visit(path);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error("Hardlinked snapshot files are unsupported");
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error("Snapshot changed during capture");
          if (opened.size > MAX_BYTES - bytesRead) throw new Error("Snapshot byte limit exceeded");
          const bytes = await handle.readFile({ signal });
          bytesRead += bytes.length;
          if (bytesRead > MAX_BYTES) throw new Error("Snapshot byte limit exceeded");
          entries.set(path, { info: { path, kind: "file", mode: opened.mode & 0o777, sha256: sha256(bytes) }, bytes });
        } finally { await handle.close(); }
      } else throw new Error("Unsupported snapshot file type");
    }
  }
  await visit("");
  for (const entry of entries.values()) if (entry.info.kind === "symlink") resolveEntry(entry.info.path, entries);
  function text(path: string) {
    const entry = resolveEntry(path, entries);
    if (entry.info.kind !== "file" || !entry.bytes) throw new Error("Expected a regular snapshot file");
    return decoder.decode(entry.bytes);
  }
  signal?.throwIfAborted();
  const manifestText = text(".claude-plugin/plugin.json");
  if (Buffer.byteLength(manifestText) > 1024 * 1024) throw new Error("Manifest size limit exceeded");
  const parsed: unknown = JSON.parse(manifestText);
  // JSON.parse accepts duplicate keys; reject that ambiguous selection too.
  if (parseDocument(manifestText, { schema: "json", uniqueKeys: true }).errors.length) throw new Error("Invalid or duplicate manifest keys");
  const manifest = resolveManifest(parsed);
  let licenseText: string;
  try { licenseText = text("LICENSE"); } catch { throw new Error("Missing snapshot license notice"); }
  if (!licenseText.trim()) throw new Error("Empty snapshot license notice");
  const names = new Set<string>();
  const skillTargets = new Set<string>();
  const skills = manifest.skillDirectories.map(directory => {
    const path = `${directory}/SKILL.md`;
    const target = resolveEntry(path, entries).info.path;
    if (skillTargets.has(target)) throw new Error("Duplicate resolved skill file");
    skillTargets.add(target);
    const content = text(path).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
    if (!match) throw new Error("Selected skill lacks valid frontmatter");
    if (Buffer.byteLength(match[1]) > 64 * 1024) throw new Error("Frontmatter size limit exceeded");
    // Pi 1.3.0 ends a header at the first '\\n---', even if more text
    // follows. Reject a divergent parse rather than rewrite upstream bytes.
    if (content.indexOf("\n---", 3) !== 4 + match[1].length) {
      throw new Error("Skill frontmatter delimiter differs from Pi");
    }
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error("Invalid skill frontmatter");
    const fields = object(document.toJS({ maxAliasCount: 0 }), "Skill frontmatter");
    const name = fields.name === undefined ? posix.basename(directory) : string(fields.name, "Skill name");
    if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid skill name");
    const description = string(fields.description, "Skill description");
    if (description.length > 1024) throw new Error("Skill description is too long");
    const disabled = fields["disable-model-invocation"];
    if (disabled !== undefined && typeof disabled !== "boolean") throw new Error("Invalid disable-model-invocation metadata");
    if (names.has(name)) throw new Error("Duplicate effective skill name");
    names.add(name);
    return Object.freeze({ name, description, path, disableModelInvocation: disabled === true });
  });
  const files = [...entries.values()].map(entry => Object.freeze(entry.info)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = sha256(JSON.stringify(files));
  const snapshot: Snapshot = Object.freeze({ root, repository: UPSTREAM_REPOSITORY, commit,
    name: manifest.name, version: manifest.version, license: manifest.license, digest,
    files: Object.freeze(files), skills: Object.freeze(skills), unsupportedFields: Object.freeze(manifest.unsupportedFields) });
  return { snapshot, entries };
}

export async function inspectSnapshot(root: string, commit: string, signal?: AbortSignal): Promise<Snapshot> {
  return (await captureSnapshot(root, commit, signal)).snapshot;
}
