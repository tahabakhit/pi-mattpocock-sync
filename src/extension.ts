import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { capabilities, compatibilityGuidance } from "./compatibility.ts";
import { createSnapshotExtension, type ResourceStatus } from "./pi-resources.ts";
import { RevisionStore, validBudget, type RevisionState } from "./revision-store.ts";
import type { Snapshot } from "./snapshot.ts";
import { failureCode, operationBudget, type FailureCode } from "./sync-operation.ts";

interface Captured { snapshot?: Snapshot }
// Jiti and SDK imports need one in-process registry. Store identity prevents
// unrelated agent directories sharing revisions. No session content is stored.
const key = Symbol.for("pi-mattpocock-sync:session-snapshots:v1");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, Captured> };
const captures = shared[key] ??= new Map<string, Captured>();
const captureKey = (store: RevisionStore, id: string) => JSON.stringify([store.directory, id]);
const quoted = (text: string) => JSON.stringify(text).replace(/[\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16)}`);
const revision = (ref: { version: string; commit: string } | null | undefined) => ref ? `${quoted(ref.version)} @ ${ref.commit}` : "none";
const help = "/mattpocock status | update [milliseconds] | retry [milliseconds] | rollback | auto on|off | budget <milliseconds>. Budgets: 1–300000 ms; explicit update/retry defaults to 30000 ms. Activate changes with Pi /reload or a new session.";
interface Attempt { at: string; operation: string; outcome: "running" | "updated" | "unchanged" | "skipped" | "ok" | "failed"; reason?: FailureCode }

/** Native lifecycle adapter; injected store is a test/SDK seam, not project configuration. */
export function createSyncExtension(options: { store?: RevisionStore } = {}): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    // No I/O, timers, or acquisition during extension discovery/factory loading.
    const store = options.store ?? new RevisionStore(join(getAgentDir(), "mattpocock-sync"));
    const controller = new AbortController();
    const { signal } = controller;
    let live = false;
    let captured: Captured = {};
    let id = "";
    let inherited = false;
    let resources: ResourceStatus | undefined;
    let latest: Attempt | undefined;
    let lastControl: Attempt | undefined;
    let mutation: Promise<void> | undefined;
    let automaticController: AbortController | undefined;
    const owned = new Set<Promise<unknown>>();
    let commandBusy = false;

    function track<T>(task: Promise<T>): Promise<T> {
      owned.add(task);
      void task.then(() => owned.delete(task), () => owned.delete(task));
      return task;
    }
    function notify(ctx: ExtensionContext, message: string, warning = false) {
      if (!live) return;
      const text = `pi-mattpocock-sync: ${message}`;
      if (ctx.hasUI) ctx.ui.notify(text, warning ? "warning" : "info");
      else console.warn(text); // stderr also works in print/JSON mode; no stdout protocol pollution
    }
    function failure(ctx: ExtensionContext, operation: string, error: unknown, control = false) {
      const attempt: Attempt = { at: new Date().toISOString(), operation, outcome: "failed", reason: failureCode(error, signal) };
      if (control) lastControl = attempt; else latest = attempt;
      notify(ctx, `${operation} failed (${attempt.reason}). Loaded resources are unchanged. Use /mattpocock status; retry with /mattpocock retry 30000.`, true);
    }
    async function update(ctx: ExtensionContext, automatic: boolean, budgetMs: number, updateSignal = signal) {
      latest = { at: new Date().toISOString(), operation: automatic ? "automatic update" : "explicit update", outcome: "running" };
      try {
        const state = await store.update({ automatic, budgetMs, signal: updateSignal });
        latest = { ...latest, outcome: automatic && !state.automatic ? "skipped" : state.lastCheck?.outcome === "updated" ? "updated" : "unchanged" };
        if (live && state.selected?.commit !== captured.snapshot?.commit && latest.outcome !== "skipped") {
          notify(ctx, `Available: ${revision(state.selected)}. Loaded resources remain unchanged; use Pi /reload or a new session.`);
        }
      } catch (error) { failure(ctx, automatic ? "automatic update" : "explicit update", error); }
    }

    pi.on("session_start", async (event, ctx) => {
      if (live || signal.aborted) return;
      live = true;
      id = ctx.sessionManager.getSessionId();
      const parent = ctx.sessionManager.getHeader()?.parentSession;
      const parentCapture = parent && captures.get(captureKey(store, parent));
      // Explicit resume/fork/new is fresh discovery, not historical plugin pinning.
      // The tested optional package uses a parent ID on startup, unlike native
      // file-path parent references. Unknown ID parents fail closed, not re-sync.
      inherited = Boolean(parent && !["resume", "fork", "new"].includes(event.reason) && !/[\\/]/.test(parent));
      if (inherited) {
        captured = { snapshot: parentCapture ? parentCapture.snapshot : undefined };
        if (!parentCapture) notify(ctx, "Parent snapshot is unavailable; this child contributes no synced skills and will not check for updates. Cross-process inheritance is unsupported.", true);
        return;
      }
      await track((async () => {
        try {
          const state = await store.read({ signal });
          // Cache validation does not wait for acquisition. Freeze this result
          // before any update can change the selected revision.
          captured = { snapshot: await store.loadSelected({ signal }) };
          if (!captured.snapshot && state.automatic) {
            const budget = operationBudget(state.automaticBudgetMs, signal);
            try {
              latest = { at: new Date().toISOString(), operation: "bootstrap", outcome: "running" };
              const selected = await store.update({ automatic: true, budgetMs: state.automaticBudgetMs, signal: budget.signal });
              captured = { snapshot: await store.loadSelected({ signal: budget.signal, budgetMs: state.automaticBudgetMs }) };
              budget.check();
              latest = { ...latest, outcome: selected.automatic ? "ok" : "skipped" };
            } finally { budget.dispose(); }
          } else if (captured.snapshot && state.automatic && live) {
            automaticController = new AbortController();
            mutation = track(update(ctx, true, state.automaticBudgetMs, AbortSignal.any([signal, automaticController.signal])));
          }
          if (!captured.snapshot) notify(ctx, "No synced skills loaded. Automatic updates may be disabled; use /mattpocock status or /mattpocock retry 30000, then /reload.", true);
        } catch (error) {
          captured = {};
          failure(ctx, latest?.operation === "bootstrap" ? "bootstrap" : "cached load", error);
          notify(ctx, "No synced skills loaded. A corrupt cache requires inspection or /mattpocock rollback; it is never silently overwritten.", true);
        }
      })());
    });

    await createSnapshotExtension({ current: () => captured.snapshot }, status => {
      resources = status;
      // A withheld parent contribution must not reappear in its child.
      if (live) captures.set(captureKey(store, id), captured = { snapshot: status.status === "offered" ? captured.snapshot : undefined });
    })(pi);

    function report(ctx: ExtensionContext, state: RevisionState | undefined, stateError?: FailureCode) {
      const snapshot = captured.snapshot;
      const paths = new Set(snapshot?.skills.map(skill => join(snapshot.root, skill.path)) ?? []);
      const effective = pi.getCommands().filter(command => command.source === "skill" && paths.has(command.sourceInfo.path)).length;
      const loaded = resources?.status === "offered" ? revision(snapshot) : "none";
      const missing = capabilities(pi).missingWorkerTools;
      notify(ctx, [
        `Loaded: ${loaded}; ${effective}/${snapshot?.skills.length ?? 0} selected paths registered; contribution: ${resources?.status ?? "not discovered"}${inherited ? "; inherited parent snapshot" : ""}.`,
        `Available (selected): ${state ? revision(state.selected) : `unknown (${stateError})`}. Previous: ${state ? revision(state.previous) : "unknown"}.`,
        `Automatic updates: ${state ? state.automatic ? "on" : "off" : "unknown"}; budget: ${state?.automaticBudgetMs ?? "unknown"} ms.`,
        `Latest session update/load attempt: ${latest ? JSON.stringify(latest) : "none"}.`,
        `Last control operation: ${lastControl ? JSON.stringify(lastControl) : "none"}.`,
        `Last committed check (may predate a timeout/cancellation): ${state ? JSON.stringify(state.lastCheck) : "unknown"}.`,
        `Missing optional worker tools: ${missing.length ? missing.join(", ") : "none detected (permissions/models/isolation not verified)"}. Worktree isolation: not supplied or verified.`,
        "Other extensions' dynamic skill collisions are unsupported; contributed paths are not a guarantee of exact-set parity. Use Pi /reload or a new session to activate the selected revision.",
      ].join("\n"));
    }
    pi.registerCommand("mattpocock", {
      description: "Synced skills: status, update/retry, rollback, auto on/off, budget",
      handler: async (args, ctx) => {
        if (!live || signal.aborted) return;
        const [action = "status", value, ...extra] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "help") { notify(ctx, help); return; }
        const numeric = value !== undefined && /^\d+$/.test(value) && validBudget(Number(value));
        const valid = !extra.length && ((["status", "rollback"].includes(action) && value === undefined)
          || (["update", "retry"].includes(action) && (value === undefined || numeric))
          || (action === "auto" && ["on", "off"].includes(value)) || (action === "budget" && numeric));
        if (!valid) { notify(ctx, help, true); return; }
        if (action === "status") {
          await track((async () => {
            try { report(ctx, await store.read({ signal })); }
            catch (error) { report(ctx, undefined, failureCode(error, signal)); }
          })());
          return;
        }
        if (inherited) { notify(ctx, "This child inherits resources; change synchronization settings from the parent session.", true); return; }
        if (commandBusy) { notify(ctx, "A control operation is already running. Use /mattpocock status.", true); return; }
        commandBusy = true;
        try {
          // Rollback/opt-out cancel our automatic check before taking the lock.
          // Other processes still re-check the flag under the store writer lock.
          if (action === "rollback" || (action === "auto" && value === "off")) automaticController?.abort();
          await track((async () => {
            await mutation;
            signal.throwIfAborted();
            if (action === "update" || action === "retry") await update(ctx, false, value === undefined ? 30000 : Number(value));
            else {
              lastControl = { at: new Date().toISOString(), operation: action, outcome: "running" };
              if (action === "rollback") await store.rollback({ signal });
              else if (action === "auto") await store.setAutomatic(value === "on", { signal });
              else await store.setAutomaticBudget(Number(value), { signal });
              lastControl = { ...lastControl, outcome: "ok" };
              notify(ctx, action === "rollback" ? "Rollback selected; automatic updates paused. Loaded resources unchanged; use Pi /reload or a new session." : "Setting saved for subsequent checks; no reload or update was started.");
            }
          })());
        } catch (error) { failure(ctx, action, error, true); }
        finally { commandBusy = false; }
      },
    });
    pi.on("before_agent_start", event => {
      if (resources?.status === "offered") event.systemPromptOptions.sections["mattpocock_compatibility"] = compatibilityGuidance(pi);
    });
    pi.on("session_shutdown", async () => {
      live = false;
      controller.abort();
      await Promise.allSettled([...owned]);
      if (captures.get(captureKey(store, id)) === captured) captures.delete(captureKey(store, id));
    });
  };
}

export default createSyncExtension();
