// Explicit live-source qualification, intentionally excluded from npm test.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RevisionStore } from "../src/revision-store.ts";
import { SyncFailure } from "../src/sync-operation.ts";

if (process.env.RUN_PUBLIC_SMOKE !== "1") throw new Error("Set RUN_PUBLIC_SMOKE=1 to explicitly permit the public-source smoke test");
const root = await mkdtemp(join(tmpdir(), "pi-mattpocock-smoke-"));
try {
  const store = new RevisionStore(root);
  await store.update({ budgetMs: 30000 });
  const snapshot = await store.loadSelected();
  assert.ok(snapshot);
  const offline = new RevisionStore(root, { acquire: async () => { throw new SyncFailure("network"); } });
  await assert.rejects(offline.update(), error => error instanceof SyncFailure && error.code === "network");
  assert.equal((await offline.loadSelected())?.digest, snapshot.digest);
  console.log(JSON.stringify({ repository: snapshot.repository, commit: snapshot.commit, version: snapshot.version,
    selectedSkills: snapshot.skills.length, files: snapshot.files.filter(file => file.kind === "file").length,
    symlinks: snapshot.files.filter(file => file.kind === "symlink").length, digest: snapshot.digest,
    simulatedOfflineRecovery: true, temporaryStoreRemovedOnExit: true }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
