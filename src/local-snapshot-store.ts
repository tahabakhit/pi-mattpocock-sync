import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { captureSnapshot, inspectSnapshot, type Snapshot } from "./snapshot.ts";
import { durableDirectory, syncPath as flush } from "./durable-fs.ts";

interface ImportOptions {
  signal?: AbortSignal;
  durable?: boolean;
  checkpoint?: (phase: "staged" | "published") => Promise<void>;
}
const MAX_PROVENANCE_BYTES = 8 * 1024 * 1024;
async function flushRevision(snapshot: Snapshot, signal?: AbortSignal) {
  for (const file of snapshot.files) if (file.kind === "file") await flush(join(snapshot.root, file.path), signal);
  for (const file of [...snapshot.files].reverse()) if (file.kind === "directory") await flush(join(snapshot.root, file.path), signal);
  await flush(snapshot.root, signal);
  await flush(join(snapshot.root, "../provenance.json"), signal);
  await flush(dirname(snapshot.root), signal);
}

/**
 * Single-writer immutable import seam. Its convenience selection is in-memory;
 * RevisionStore owns the production writer lock and durable selection record.
 * Callers supply a stable local snapshot, not a concurrently edited checkout.
 */
export class LocalSnapshotStore {
  readonly directory: string;
  #selected: Snapshot | undefined;
  constructor(directory: string) { this.directory = resolve(directory); }
  current(): Snapshot | undefined { return this.#selected; }

  async read(commit: string, expectedDigest?: string, signal?: AbortSignal): Promise<Snapshot> {
    signal?.throwIfAborted();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Invalid commit ID");
    const directory = join(await realpath(this.directory), commit);
    const content = join(directory, "content");
    if (!(await lstat(directory)).isDirectory() || !(await lstat(content)).isDirectory() || await realpath(content) !== content) {
      throw new Error("Existing revision content must be a real directory inside its revision");
    }
    const metadataPath = join(directory, "provenance.json");
    const metadataStat = await lstat(metadataPath);
    if (!metadataStat.isFile() || metadataStat.nlink !== 1 || metadataStat.size > MAX_PROVENANCE_BYTES) throw new Error("Invalid provenance file");
    const snapshot = await inspectSnapshot(content, commit, signal);
    const { root: _root, ...expected } = snapshot;
    const metadata: unknown = JSON.parse(await readFile(metadataPath, { encoding: "utf8", signal }));
    if (!isDeepStrictEqual(metadata, expected) || (expectedDigest !== undefined && snapshot.digest !== expectedDigest)) {
      throw new Error("Snapshot/provenance digest mismatch");
    }
    return snapshot;
  }

  async select(source: string, commit: string, options: ImportOptions = {}): Promise<Snapshot> {
    const { signal } = options;
    const captured = await captureSnapshot(source, commit, signal);
    const ensureOutsideSource = (directory: string) => {
      const nested = relative(captured.snapshot.root, directory);
      if (!nested || (!isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${sep}`))) {
        throw new Error("Snapshot store must be outside the source tree");
      }
    };
    ensureOutsideSource(this.directory);
    if (options.durable) await durableDirectory(this.directory, signal);
    else await mkdir(this.directory, { recursive: true });
    const storeRoot = await realpath(this.directory);
    ensureOutsideSource(storeRoot);
    const destination = join(storeRoot, commit);
    let exists = false;
    try { await lstat(destination); exists = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      const existing = await this.read(commit, captured.snapshot.digest, signal);
      if (options.durable) { await flushRevision(existing, signal); await flush(storeRoot, signal); }
      signal?.throwIfAborted();
      this.#selected = existing;
      return existing;
    }

    const staging = await mkdtemp(join(storeRoot, ".stage-"));
    try {
      const content = join(staging, "content");
      await mkdir(content);
      // Make directories/files first and links last: never write through a link.
      for (const entry of captured.entries.values()) {
        signal?.throwIfAborted();
        const target = join(content, entry.info.path);
        if (entry.info.kind === "directory") await mkdir(target, { recursive: true });
        else if (entry.info.kind === "file") {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, entry.bytes!, { flag: "wx", signal });
          await chmod(target, entry.info.mode);
        }
      }
      for (const entry of captured.entries.values()) {
        signal?.throwIfAborted();
        if (entry.info.kind === "symlink") await symlink(entry.info.target!, join(content, entry.info.path));
      }
      for (const entry of [...captured.entries.values()].reverse()) {
        signal?.throwIfAborted();
        if (entry.info.kind === "directory") await chmod(join(content, entry.info.path), entry.info.mode);
      }
      const checked = await inspectSnapshot(content, commit, signal);
      if (checked.digest !== captured.snapshot.digest) throw new Error("Staged snapshot integrity mismatch");
      const { root: _root, ...provenance } = checked;
      const serialized = JSON.stringify(provenance, null, 2) + "\n";
      if (Buffer.byteLength(serialized) > MAX_PROVENANCE_BYTES) throw new Error("Provenance size limit exceeded");
      await writeFile(join(staging, "provenance.json"), serialized, { flag: "wx", signal });
      if (options.durable) await flushRevision(checked, signal);
      await options.checkpoint?.("staged");
      signal?.throwIfAborted();
      await rename(staging, destination);
      if (options.durable) await flush(storeRoot, signal);
      await options.checkpoint?.("published");
      signal?.throwIfAborted();
      // Validation and import finished before changing the visible selection.
      const selected = Object.freeze({ ...checked, root: join(destination, "content") });
      this.#selected = selected;
      return selected;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
