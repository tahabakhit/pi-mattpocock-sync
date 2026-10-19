import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RevisionStore, type SyncPhase } from "../../src/revision-store.ts";

const config = JSON.parse(process.argv[2]) as {
  directory: string; source: string; commit: string; pause?: SyncPhase | "download-partial";
  operation?: "update" | "automatic" | "rollback" | "off"; budgetMs?: number;
};
const watchdog = setTimeout(() => process.exit(70), 10000);
const store = new RevisionStore(config.directory, {
  acquire: async ({ directory, signal }) => {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const root = await mkdtemp(join(directory, ".acquire-"));
    await writeFile(join(root, "partial-download"), "incomplete fixture bytes");
    process.send?.({ phase: "download-partial" });
    if (config.pause === "download-partial") await new Promise<void>(resolve => process.once("message", () => resolve()));
    signal.throwIfAborted();
    await rm(join(root, "partial-download"));
    await cp(config.source, root, { recursive: true });
    return { root, commit: config.commit, cleanup: () => rm(root, { recursive: true, force: true }) };
  },
  checkpoint: async phase => {
    process.send?.({ phase });
    if (phase === config.pause) await new Promise<void>(resolve => process.once("message", () => resolve()));
  },
});
try {
  const options = { budgetMs: config.budgetMs ?? 5000 };
  const state = config.operation === "rollback" ? await store.rollback(options)
    : config.operation === "off" ? await store.setAutomatic(false, options)
    : await store.update({ ...options, automatic: config.operation === "automatic" });
  process.send?.({ done: true, selected: state.selected?.commit, automatic: state.automatic });
} catch (error) {
  process.send?.({ failure: (error as { code?: string }).code ?? "unexpected" });
  process.exitCode = 1;
} finally { clearTimeout(watchdog); process.disconnect?.(); }
