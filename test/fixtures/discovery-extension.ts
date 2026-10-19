import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Revision {
  id: string;
  skills: Array<{ name: string; path: string }>;
}
export interface FixtureState {
  selected: Revision | null;
  backgroundTarget?: Revision;
  inheritParent?: boolean;
}

// Test-only lifecycle probe. state.json is synthetic trusted fixture data, not
// an upstream manifest. There is deliberately no downloader or production store.
const directory = dirname(fileURLToPath(import.meta.url));
const statePath = join(directory, "state.json");
const readState = () => JSON.parse(readFileSync(statePath, "utf8")) as FixtureState;

// A tiny optional inheritance probe using the public session-header parent ID.
// Shared across in-process child extension instances, scoped to this fixture.
const key = Symbol.for("pi-mattpocock-sync:m0-snapshots");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, Revision | null> };
const snapshots = shared[key] ??= new Map<string, Revision | null>();
const snapshotKey = (id: string) => `${statePath}:${id}`;

export default function discoveryProbe(pi: ExtensionAPI) {
  let loaded: Revision | null = null;
  let sessionId = "";
  let inherited = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;

  function report(channel: string, data: Record<string, unknown>) {
    const record = { sessionId, ...data };
    appendFileSync(join(directory, "observations.jsonl"), JSON.stringify({ channel, ...record }) + "\n");
    pi.events.emit(channel, record);
  }

  pi.on("session_start", (_event, ctx) => {
    const state = readState();
    sessionId = ctx.sessionManager.getSessionId();
    const parent = ctx.sessionManager.getHeader()?.parentSession;
    inherited = Boolean(state.inheritParent && parent && snapshots.has(snapshotKey(parent)));
    loaded = inherited ? snapshots.get(snapshotKey(parent!))! : state.selected;
    snapshots.set(snapshotKey(sessionId), loaded);
    report("m0:start", { loaded: loaded?.id ?? null, inherited, parent });
    if (!state.backgroundTarget || inherited) return;

    controller = new AbortController();
    const { signal } = controller;
    // Simulates a cancellable delayed fetch. A test releases the barrier;
    // no timers, sockets, scheduler, model calls, or SDK mutation are involved.
    pending = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const off = pi.events.on("m0:release-update", () => {
            signal.removeEventListener("abort", abort);
            off();
            resolve();
          });
          function abort() { off(); reject(signal.reason); }
          signal.addEventListener("abort", abort, { once: true });
        });
        signal.throwIfAborted();
        const current = readState();
        writeFileSync(statePath, JSON.stringify({ ...current, selected: state.backgroundTarget, backgroundTarget: undefined }));
        report("m0:update", { status: "staged", available: state.backgroundTarget!.id });
      } catch (error) {
        if (!signal.aborted) throw error;
        report("m0:update", { status: "aborted" });
      }
    })().catch(error => {
      report("m0:update", { status: "error", message: String(error) });
    });
    report("m0:update", { status: "pending" });
  });

  pi.registerCommand("m0-commands", {
    description: "Test-only command inventory probe",
    handler: async () => { report("m0:commands", { commands: pi.getCommands() }); },
  });

  pi.on("resources_discover", () => {
    const seen = pi.getCommands().filter(c => c.source === "skill").map(c => c.name);
    const collisions = loaded?.skills.filter(s => seen.includes(`skill:${s.name}`)) ?? [];
    const paths = collisions.length ? [] : loaded?.skills.map(s => s.path) ?? [];
    report("m0:discovery", { seen, loaded: loaded?.id ?? null, inherited,
      status: collisions.length ? "collision" : loaded ? "loaded" : "no-cache", paths });
    return { skillPaths: paths };
  });

  pi.on("session_shutdown", async () => {
    controller?.abort();
    await pending;
    snapshots.delete(snapshotKey(sessionId));
  });
}
