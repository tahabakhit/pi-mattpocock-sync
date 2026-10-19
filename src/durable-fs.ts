import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

export async function syncPath(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Persist the directory entry chain, not only the leaf's own contents. Sync
 * existing ancestors too: a concurrent creator may not have flushed them yet.
 * This relies on a local filesystem implementing directory fsync correctly.
 */
export async function durableDirectory(
  path: string,
  signal?: AbortSignal,
  synchronize: typeof syncPath = syncPath,
): Promise<string> {
  signal?.throwIfAborted();
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  for (let current = canonical; ; current = dirname(current)) {
    signal?.throwIfAborted();
    await synchronize(current, signal);
    if (dirname(current) === current) break;
  }
  return canonical;
}
