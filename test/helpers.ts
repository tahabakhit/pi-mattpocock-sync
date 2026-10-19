import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  createEventBus, ModelRuntime, SessionManager, SettingsManager,
  type CreateAgentSessionRuntimeFactory, type EventBus, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { FixtureState } from "./fixtures/discovery-extension.ts";

export async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

export async function makeFixture() {
  assert.ok(process.env.M0_ROOT, "Run via npm test to isolate HOME and deny network");
  const root = await mkdtemp(join(process.env.M0_ROOT, "case-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const provider = join(root, "fake-provider.ts");
  const extension = join(root, "discovery-extension.ts");
  for (const name of ["fake-provider.ts", "discovery-extension.ts"]) {
    await copyFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), join(root, name));
  }
  const statePath = join(root, "state.json");
  const settingsPath = join(agentDir, "settings.json");
  const extensions = [provider, extension];
  const writeState = (state: FixtureState) => json(statePath, state);
  await writeState({ selected: null });

  async function skill(base: string, name: string, body: string, userOnly = false) {
    const path = join(base, name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nname: ${name}\ndescription: Fixture ${name}\n${userOnly ? "disable-model-invocation: true\n" : ""}---\n${body}\n`);
    return { name, path };
  }
  async function revision(id: string, entries: Array<[string, string, boolean?]>) {
    const skills = [];
    for (const [name, body, userOnly] of entries) {
      skills.push(await skill(join(root, "revisions", id), name, body, userOnly));
    }
    return { id, skills };
  }
  async function boot(extraExtensions: string[] = extensions, factories: ExtensionFactory[] = [], parentSession?: string, packages: string[] = []) {
    await json(settingsPath, {
      defaultProvider: "m0-fixture", defaultModel: "echo", defaultThinkingLevel: "off",
      defaultTools: [], enableInstallTelemetry: false, enableAnalytics: false,
      compaction: { enabled: false }, retry: { enabled: false },
      extensions: extraExtensions, packages,
    });
    const errors: unknown[] = [];
    const observations: unknown[] = [];
    const requests: unknown[] = [];
    const bus = createEventBus();
    bus.on("m0:discovery", data => observations.push(data));
    bus.on("m0:request", data => requests.push(data));
    const create: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"), modelsPath: null,
        modelsStorePath: join(agentDir, "models-cache.json"),
        allowModelNetwork: false, refreshOnCreate: false,
      });
      const services = await createAgentSessionServices({
        cwd, agentDir, modelRuntime, settingsManager: SettingsManager.create(cwd, agentDir),
        resourceLoaderOptions: { eventBus: bus, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: factories },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, [], "fixture extensions must load");
      return {
        ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
          tools: ["read", "subagent", "get_subagent_result", "steer_subagent"] }),
        services, diagnostics: services.diagnostics,
      };
    };
    const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
    if (parentSession) sessionManager.newSession({ parentSession });
    const runtime = await createAgentSessionRuntime(create, { cwd, agentDir, sessionManager });
    try {
      runtime.setRebindSession(async session => {
        await session.bindExtensions({ onError: error => errors.push(error) });
      });
      await runtime.session.bindExtensions({ onError: error => errors.push(error) });
      assert.deepEqual(errors, [], "fixture binding must succeed");
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
    let closed = false;
    return {
      runtime, bus, observations, requests, errors,
      get session() { return runtime.session; },
      get loader() { return runtime.services.resourceLoader; },
      async close() {
        if (closed) return;
        closed = true;
        await runtime.dispose();
      },
      async invoke(name: string, args = "") {
        const previousRequests = requests.length;
        await runtime.session.prompt(`/skill:${name} ${args}`.trim());
        assert.deepEqual(errors, []);
        assert.equal(requests.length, previousRequests + 1, "this invocation must reach the fake provider exactly once");
        const request = requests.at(-1) as TranscriptContext;
        const latestUser = request.messages.findLast(message => message.role === "user");
        assert.ok(latestUser, "the fake request must contain this invocation");
        return JSON.stringify(latestUser);
      },
    };
  }
  return { root, cwd, agentDir, provider, extension, extensions, statePath, boot,
    writeState, revision, skill, readState: async () => JSON.parse(await readFile(statePath, "utf8")) as FixtureState };
}

export function eventOnce(bus: EventBus, name: string, matches: (data: unknown) => boolean = () => true) {
  return new Promise<unknown>((resolve) => {
    const off = bus.on(name, data => {
      if (matches(data)) { off(); resolve(data); }
    });
  });
}
