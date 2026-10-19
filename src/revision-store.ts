import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { acquireSnapshot, type AcquireSnapshot } from "./acquisition.ts";
import { LocalSnapshotStore } from "./local-snapshot-store.ts";
import { durableDirectory } from "./durable-fs.ts";
import { inspectSnapshot, type Snapshot } from "./snapshot.ts";
import { verifySnapshotPolicy } from "./snapshot-policy.ts";
import { failureCode, operationBudget, SyncFailure, type FailureCode } from "./sync-operation.ts";

export interface RevisionReference { readonly commit: string; readonly digest: string; readonly version: string }
export interface CheckResult {
  readonly at: string;
  readonly outcome: "updated" | "unchanged" | "failed";
  readonly reason?: FailureCode;
  readonly httpStatus?: number;
}
export interface RevisionState {
  readonly format: 2;
  readonly automatic: boolean;
  readonly automaticBudgetMs: number;
  readonly selected: RevisionReference | null;
  readonly previous: RevisionReference | null;
  readonly lastCheck: CheckResult | null;
}
export interface OperationOptions { budgetMs?: number; signal?: AbortSignal }
export type SyncPhase = "read-snapshot" | "locked" | "acquired" | "staged" | "published" | "state-written" | "committed";
interface StoreOptions {
  acquire?: AcquireSnapshot;
  /** Fault-injection seam; never read from upstream/configuration. */
  checkpoint?: (phase: SyncPhase) => Promise<void>;
}
type StateDatabase = Pick<DatabaseSync, "exec" | "prepare" | "close">;
const require = createRequire(import.meta.url);

// Standalone Pi embeds Bun: use its native driver, with the same database
// format and explicit transaction/locking protocol as Node.
function openDatabase(path: string): StateDatabase {
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite") as {
      Database: new (path: string, options: { create: boolean; strict: boolean }) => {
        exec: StateDatabase["exec"];
        query: StateDatabase["prepare"];
        close(throwOnError: boolean): void;
      };
    };
    const db = new Database(path, { create: true, strict: true });
    return {
      exec: sql => db.exec(sql),
      prepare: sql => db.query(sql),
      // Finalize cached statements and release the connection now, not at GC.
      close: () => db.close(true),
    };
  }
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path, { timeout: 0, allowExtension: false });
}

const STATE_SCHEMA = "CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)";
const initial = (): RevisionState => ({ format: 2, automatic: true, automaticBudgetMs: 5000, selected: null, previous: null, lastCheck: null });
export const validBudget = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 300_000;
const codes = new Set<FailureCode>(["network", "http", "invalid", "timeout", "cancelled", "state", "license"]);
const busy = (error: unknown) => {
  const details = error as { errcode?: number; errno?: number } | null;
  const code = details?.errcode ?? details?.errno;
  return typeof code === "number" && [5, 6].includes(code & 0xff);
};
type Budget = ReturnType<typeof operationBudget>;

function validReference(value: unknown): value is RevisionReference | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const ref = value as RevisionReference;
  return Object.keys(ref).sort().join() === "commit,digest,version" && typeof ref.commit === "string"
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref.commit) && typeof ref.digest === "string" && /^[a-f0-9]{64}$/.test(ref.digest)
    && typeof ref.version === "string" && !!ref.version.trim() && ref.version.length <= 1024;
}
function validateState(value: unknown): RevisionState {
  if (!value || typeof value !== "object") throw new SyncFailure("state");
  const input = value as Record<string, unknown>;
  // M2 records gain the default budget in memory; the next successful writer
  // persists format 2 atomically. Unknown fields/formats still fail closed.
  const legacy = input.format === 1 && Object.keys(input).sort().join() === "automatic,format,lastCheck,previous,selected";
  const state = (legacy ? { ...input, format: 2, automaticBudgetMs: 5000 } : input) as unknown as RevisionState;
  if (Object.keys(state).sort().join() !== "automatic,automaticBudgetMs,format,lastCheck,previous,selected" || state.format !== 2 || typeof state.automatic !== "boolean"
    || !validBudget(state.automaticBudgetMs) || !validReference(state.selected) || !validReference(state.previous)) throw new SyncFailure("state");
  const check = state.lastCheck;
  if (check !== null) {
    if (!check || typeof check !== "object" || typeof check.at !== "string" || check.at.length > 32 || !Number.isFinite(Date.parse(check.at))
      || !["updated", "unchanged", "failed"].includes(check.outcome)
      || Object.keys(check).some(key => !["at", "outcome", "reason", "httpStatus"].includes(key))
      || (check.outcome === "failed" ? !codes.has(check.reason!) : check.reason !== undefined)
      || (check.httpStatus !== undefined && (!Number.isInteger(check.httpStatus) || check.httpStatus < 100 || check.httpStatus > 599))) throw new SyncFailure("state");
  }
  return state;
}

async function retry<T>(fn: () => T, budget: Budget): Promise<T> {
  for (;;) {
    budget.check();
    try { return fn(); } catch (error) {
      if (!busy(error)) throw error;
      await delay(20, undefined, { signal: budget.signal });
    }
  }
}

/** Local-filesystem store. SQLite owns writer locking and atomic selection. */
export class RevisionStore {
  readonly directory: string;
  constructor(directory: string, private readonly options: StoreOptions = {}) { this.directory = resolve(directory); }

  async #open(budget: Budget) {
    budget.check();
    const root = await durableDirectory(this.directory, budget.signal);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        const stat = await lstat(join(root, `state.sqlite${suffix}`));
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SyncFailure("state");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    budget.check();
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
      const mode = await retry(() => db.prepare("PRAGMA journal_mode").get(), budget);
      if (mode?.journal_mode !== "delete") throw new SyncFailure("state");
      return { db, root };
    } catch (error) { db.close(); throw error; }
  }
  #state(db: StateDatabase): RevisionState {
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_master").all();
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (!objects.length && version === 0) return initial();
    if (objects.length !== 1 || objects[0].type !== "table" || objects[0].name !== "sync_state"
      || objects[0].sql !== STATE_SCHEMA || version !== 1) throw new SyncFailure("state");
    const row = db.prepare("SELECT value FROM sync_state WHERE id=1").get();
    if (typeof row?.value !== "string" || Buffer.byteLength(row.value) > 64 * 1024) throw new SyncFailure("state");
    return validateState(JSON.parse(row.value));
  }
  async #cleanup(root: string, signal: AbortSignal) {
    // Only a writer holding the SQLite lock may remove abandoned temporary
    // trees. Published commit directories and SQLite journals are never removed.
    for (const [name, prefix] of [["downloads", ".acquire-"], ["revisions", ".stage-"]]) {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new SyncFailure("state");
      for (const entry of await readdir(directory)) {
        signal.throwIfAborted();
        if (entry.startsWith(prefix)) await rm(join(directory, entry), { recursive: true, force: true });
      }
    }
  }
  async #verify(root: string, reference: RevisionReference, signal?: AbortSignal): Promise<Snapshot> {
    try {
      const directory = join(root, "revisions");
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new SyncFailure("state");
      const snapshot = await new LocalSnapshotStore(directory).read(reference.commit, reference.digest, signal);
      if (snapshot.version !== reference.version) throw new SyncFailure("state");
      return snapshot;
    } catch (error) { signal?.throwIfAborted(); throw new SyncFailure("state"); }
  }
  async #write(options: OperationOptions, mutate: (state: RevisionState, root: string, budget: Budget) => Promise<RevisionState>) {
    const budget = operationBudget(options.budgetMs, options.signal);
    let db: StateDatabase | undefined;
    let transaction = false;
    try {
      const opened = await this.#open(budget); db = opened.db;
      await retry(() => db!.exec("BEGIN IMMEDIATE"), budget); transaction = true;
      const state = await retry(() => this.#state(db!), budget);
      await this.options.checkpoint?.("locked");
      await this.#cleanup(opened.root, budget.signal);
      const next = validateState(await mutate(state, opened.root, budget));
      budget.check();
      await retry(() => db!.exec(STATE_SCHEMA.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS") + "; PRAGMA user_version=1;"), budget);
      const written = await retry(() => db!.prepare("INSERT INTO sync_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(next)), budget);
      if (written.changes !== 1) throw new SyncFailure("state");
      await this.options.checkpoint?.("state-written");
      await retry(() => db!.exec("COMMIT"), budget); transaction = false;
      await this.options.checkpoint?.("committed");
      return next;
    } catch (error) {
      if (error instanceof SyncFailure) throw error;
      if (budget.signal.aborted) throw new SyncFailure(failureCode(error, budget.signal));
      throw new SyncFailure("state");
    } finally {
      try { if (transaction) db?.exec("ROLLBACK"); } finally { db?.close(); budget.dispose(); }
    }
  }

  async read(options: OperationOptions = {}): Promise<RevisionState> {
    const budget = operationBudget(options.budgetMs, options.signal);
    let db: StateDatabase | undefined;
    try {
      const opened = await this.#open(budget); db = opened.db;
      for (;;) {
        budget.check();
        let transaction = false;
        try {
          db.exec("BEGIN"); transaction = true;
          // Pin one schema/data generation before any asynchronous test hook.
          db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
          await this.options.checkpoint?.("read-snapshot");
          budget.check();
          const state = this.#state(db);
          db.exec("COMMIT"); transaction = false;
          return state;
        } catch (error) {
          if (transaction) db.exec("ROLLBACK");
          if (!busy(error)) throw error;
          await delay(20, undefined, { signal: budget.signal });
        }
      }
    } catch (error) { throw new SyncFailure(budget.signal.aborted ? failureCode(error, budget.signal) : "state"); }
    finally { db?.close(); budget.dispose(); }
  }
  async loadSelected(options: OperationOptions = {}): Promise<Snapshot | undefined> {
    const budget = operationBudget(options.budgetMs, options.signal);
    try {
      const state = await this.read({ ...options, signal: budget.signal });
      const snapshot = state.selected ? await this.#verify(await realpath(this.directory), state.selected, budget.signal) : undefined;
      budget.check();
      return snapshot;
    } finally { budget.dispose(); }
  }
  async update(options: OperationOptions & { automatic?: boolean } = {}): Promise<RevisionState> {
    let failed: SyncFailure | undefined;
    const state = await this.#write(options, async (current, root, budget) => {
      if (options.automatic && !current.automatic) return current;
      const at = new Date().toISOString();
      try {
        if (current.selected) await this.#verify(root, current.selected, budget.signal);
        const acquired = await (this.options.acquire ?? acquireSnapshot)({ directory: join(root, "downloads"), signal: budget.signal });
        try {
          budget.check(); await this.options.checkpoint?.("acquired");
          const candidate = await inspectSnapshot(acquired.root, acquired.commit, budget.signal);
          await verifySnapshotPolicy(candidate, budget.signal);
          const imported = await new LocalSnapshotStore(join(root, "revisions")).select(acquired.root, acquired.commit, {
            signal: budget.signal, durable: true, checkpoint: phase => this.options.checkpoint?.(phase) ?? Promise.resolve(),
          });
          budget.check();
          const reference: RevisionReference = { commit: imported.commit, digest: imported.digest, version: imported.version };
          const changed = current.selected?.commit !== imported.commit;
          return { ...current, selected: reference, previous: changed ? current.selected : current.previous,
            lastCheck: { at, outcome: changed ? "updated" : "unchanged" } };
        } finally { await acquired.cleanup(); }
      } catch (error) {
        failed = new SyncFailure(failureCode(error, budget.signal), error instanceof SyncFailure ? error.httpStatus : undefined);
        // A cancelled/expired operation must not make another state write.
        budget.check();
        return { ...current, lastCheck: { at, outcome: "failed", reason: failed.code, ...(failed.httpStatus === undefined ? {} : { httpStatus: failed.httpStatus }) } };
      }
    });
    if (failed) throw failed;
    return state;
  }
  async rollback(options: OperationOptions = {}): Promise<RevisionState> {
    return this.#write(options, async (state, root, budget) => {
      if (!state.previous) throw new SyncFailure("state");
      await this.#verify(root, state.previous, budget.signal);
      return { ...state, automatic: false, selected: state.previous, previous: state.selected };
    });
  }
  async setAutomaticBudget(milliseconds: number, options: OperationOptions = {}): Promise<RevisionState> {
    if (!validBudget(milliseconds)) throw new RangeError("Update budget must be between 1 and 300000 milliseconds");
    return this.#write(options, async state => ({ ...state, automaticBudgetMs: milliseconds }));
  }
  async setAutomatic(enabled: boolean, options: OperationOptions = {}): Promise<RevisionState> {
    if (typeof enabled !== "boolean") throw new TypeError("Automatic update flag must be boolean");
    return this.#write(options, async state => ({ ...state, automatic: enabled }));
  }
}
