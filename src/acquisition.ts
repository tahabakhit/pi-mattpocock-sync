import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import * as tar from "tar-stream";
import { canonicalPathKey, PATH_LIMITS, resolveEntry, sha256, validatePathBounds, validateRelativePath, type CapturedEntry } from "./snapshot.ts";
import { abortable, SyncFailure } from "./sync-operation.ts";

const API = "https://api.github.com/repos/mattpocock/skills";
export const ACQUISITION_LIMITS = Object.freeze({ jsonBytes: 1024 * 1024, compressedBytes: 8 * 1024 * 1024,
  tarBytes: 64 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, entries: 10_000 });
export interface AcquiredSnapshot { root: string; commit: string; cleanup(): Promise<void> }
export interface AcquisitionOptions { directory: string; signal: AbortSignal; fetch?: typeof globalThis.fetch }
export type AcquireSnapshot = (options: AcquisitionOptions) => Promise<AcquiredSnapshot>;

async function body(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new SyncFailure("invalid");
  }
  if (!response.body) throw new SyncFailure("invalid");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new SyncFailure("invalid");
      parts.push(chunk.value);
    }
    return Buffer.concat(parts, size);
  } finally { void reader.cancel().catch(() => {}); }
}

async function request(url: string, limit: number, options: AcquisitionOptions): Promise<Buffer> {
  options.signal.throwIfAborted();
  const transport = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await abortable(transport(url, { signal: options.signal, redirect: "error",
      credentials: "omit", headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-mattpocock-sync" } }), options.signal);
  } catch (error) {
    options.signal.throwIfAborted();
    throw new SyncFailure("network");
  }
  // No redirect locations are followed, even by an injected transport.
  if (response.redirected || (response.url && response.url !== url)) {
    void response.body?.cancel().catch(() => {});
    throw new SyncFailure("invalid");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SyncFailure("http", response.status);
  }
  return body(response, limit, options.signal);
}

/** Parse and validate the entire bounded archive before materializing any entry. */
export async function parseArchive(compressed: Buffer, commit: string, signal: AbortSignal) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || compressed.length > ACQUISITION_LIMITS.compressedBytes) throw new SyncFailure("invalid");
  signal.throwIfAborted();
  const unpacked = await abortable(promisify(gunzip)(compressed, { maxOutputLength: ACQUISITION_LIMITS.tarBytes }), signal);
  signal.throwIfAborted();
  const parser = tar.extract();
  const entries = new Map<string, CapturedEntry>();
  const explicit = new Set<string>();
  const folded = new Map<string, string>();
  let count = 0, size = 0, pathBytes = 0;
  const abort = () => parser.destroy(new SyncFailure("cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  function remember(path: string, entry: CapturedEntry, implicit = false) {
    const key = canonicalPathKey(path);
    const prior = folded.get(key);
    if (prior !== undefined && prior !== path) throw new SyncFailure("invalid");
    const existing = entries.get(path);
    if (existing && (existing.info.kind !== "directory" || entry.info.kind !== "directory" || (!implicit && explicit.has(path)))) throw new SyncFailure("invalid");
    if (!existing) {
      pathBytes += Buffer.byteLength(path) + Buffer.byteLength(entry.info.target ?? "");
      if (pathBytes > PATH_LIMITS.aggregateBytes) throw new SyncFailure("invalid");
    }
    folded.set(key, path);
    if (!implicit || !existing) entries.set(path, entry);
    if (!implicit) explicit.add(path);
    if (entries.size > ACQUISITION_LIMITS.entries) throw new SyncFailure("invalid");
  }
  try {
    const consume = (async () => {
      for await (const stream of parser) {
        signal.throwIfAborted();
        const header = stream.header;
        const pax = (header as tar.Header & { pax?: Record<string, string> }).pax;
        if (pax && (Object.keys(pax).some(key => key.startsWith("GNU.sparse."))
          || (pax.size !== undefined && (!/^\d+$/.test(pax.size) || Number(pax.size) !== header.size)))) throw new SyncFailure("invalid");
        if (++count > ACQUISITION_LIMITS.entries) throw new SyncFailure("invalid");
        if (!["file", "directory", "symlink"].includes(header.type ?? "")) throw new SyncFailure("invalid");
        const name = header.type === "directory" ? header.name.replace(/\/$/, "") : header.name;
        validateRelativePath(name);
        // tar-stream decodes names as UTF-8. Reject replacement characters rather
        // than risk silently normalizing invalid original path/link bytes.
        if (name.includes("\uFFFD") || header.linkname?.includes("\uFFFD")) throw new SyncFailure("invalid");
        if (header.type === "symlink") validatePathBounds(header.linkname ?? "");
        const prefix = `skills-${commit}`;
        if (name === prefix) {
          if (header.type !== "directory" || header.size !== 0 || explicit.has("")) throw new SyncFailure("invalid");
          explicit.add(""); stream.resume(); continue;
        }
        if (!name.startsWith(prefix + "/")) throw new SyncFailure("invalid");
        const path = validateRelativePath(name.slice(prefix.length + 1));
        if (path === ".git" || path.startsWith(".git/")) throw new SyncFailure("invalid");
        if (!Number.isSafeInteger(header.size) || header.size! < 0 || header.size! > ACQUISITION_LIMITS.fileBytes - size) throw new SyncFailure("invalid");
        if (header.type !== "file" && header.size !== 0) throw new SyncFailure("invalid");
        const mode = header.mode ?? (header.type === "directory" ? 0o755 : 0o644);
        if (!Number.isInteger(mode) || mode < 0 || (mode & ~0o777) !== 0) throw new SyncFailure("invalid");
        if (header.type === "directory" && (mode & 0o700) !== 0o700) throw new SyncFailure("invalid");
        if (header.type === "file" && !(mode & 0o400)) throw new SyncFailure("invalid");
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          remember(parent, { info: { path: parent, kind: "directory", mode: 0o755 } }, true);
        }
        const chunks: Buffer[] = [];
        let entrySize = 0;
        for await (const chunk of stream) {
          signal.throwIfAborted();
          if (!Buffer.isBuffer(chunk)) throw new SyncFailure("invalid");
          entrySize += chunk.length;
          if (entrySize > header.size!) throw new SyncFailure("invalid");
          chunks.push(chunk);
        }
        if (entrySize !== header.size) throw new SyncFailure("invalid");
        size += entrySize;
        const bytes = Buffer.concat(chunks, entrySize);
        const kind = header.type as "file" | "directory" | "symlink";
        if (kind === "symlink" && !header.linkname) throw new SyncFailure("invalid");
        remember(path, { info: { path, kind, mode: kind === "symlink" ? 0o777 : mode,
          ...(kind === "file" ? { sha256: sha256(bytes) } : kind === "symlink" ? { target: header.linkname!, sha256: sha256(header.linkname!) } : {}) },
          ...(kind === "file" ? { bytes } : {}) });
      }
    })();
    parser.end(unpacked);
    await consume;
    for (const entry of entries.values()) if (entry.info.kind === "symlink") resolveEntry(entry.info.path, entries);
    if (!entries.size) throw new SyncFailure("invalid");
    return entries;
  } finally { signal.removeEventListener("abort", abort); parser.destroy(); }
}

export const acquireSnapshot: AcquireSnapshot = async options => {
  const decode = (bytes: Buffer) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
  const repository = decode(await request(API, ACQUISITION_LIMITS.jsonBytes, options));
  const branch = repository?.default_branch;
  if (typeof branch !== "string" || !branch || branch.length > 255 || branch === "." || branch === ".." || /[\x00-\x1f\x7f]/.test(branch)) throw new SyncFailure("invalid");
  const resolved = decode(await request(`${API}/commits/${encodeURIComponent(branch)}`, ACQUISITION_LIMITS.jsonBytes, options));
  const commit = resolved?.sha;
  if (typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new SyncFailure("invalid");
  const bytes = await request(`https://codeload.github.com/mattpocock/skills/tar.gz/${commit}`, ACQUISITION_LIMITS.compressedBytes, options);
  const entries = await parseArchive(bytes, commit, options.signal);
  options.signal.throwIfAborted();
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(options.directory, ".acquire-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    for (const entry of entries.values()) {
      options.signal.throwIfAborted();
      const target = join(root, entry.info.path);
      if (entry.info.kind === "directory") await mkdir(target, { recursive: true });
      if (entry.info.kind === "file") {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.bytes!, { flag: "wx", signal: options.signal });
        await chmod(target, entry.info.mode);
      }
    }
    for (const entry of entries.values()) {
      options.signal.throwIfAborted();
      if (entry.info.kind === "symlink") await symlink(entry.info.target!, join(root, entry.info.path));
    }
    for (const entry of [...entries.values()].reverse()) {
      options.signal.throwIfAborted();
      if (entry.info.kind === "directory") await chmod(join(root, entry.info.path), entry.info.mode);
    }
    return { root, commit, cleanup };
  } catch (error) { await cleanup(); throw error; }
};
