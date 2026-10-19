import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { RevisionStore } from "../../src/revision-store.ts";
import { transactionFixture } from "../transaction-fixtures.ts";
import { json } from "../helpers.ts";
import { put } from "../snapshot-fixtures.ts";

const exec = promisify(execFile);
const packageDirectory = process.env.M4_PACKAGE_DIR;
assert.ok(packageDirectory, "Run through npm run test:package");
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const deny = fileURLToPath(new URL("../deny-network.mjs", import.meta.url));
const commonArgs = ["--offline", "--no-mcp", "--no-context-files", "--no-themes", "--no-prompt-templates", "--no-session", "--tools", "read"];
const options = { timeout: 30000 };
function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const pending = exec(process.execPath, args, { cwd, env, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  // Print/JSON modes await EOF on non-TTY stdin before starting. execFile leaves
  // its pipe open; explicitly finish it rather than mistaking that wait for a hang.
  pending.child.stdin?.end();
  return pending;
}

async function fixture() {
  const f = await transactionFixture(), host = f.a.fixture;
  process.env.PI_CODING_AGENT_DIR = host.agentDir;
  const store = new RevisionStore(join(host.agentDir, "mattpocock-sync"), { acquire: f.acquire });
  await store.update(); await store.setAutomatic(false);
  // The only explicit extension is the fake provider. Pi must find the sync
  // entrypoint through the INSTALLED package manifest, not an injected factory.
  const boot = () => host.boot([host.provider], [], undefined, [packageDirectory!]);
  return { ...f, host, store, boot };
}

test("installed tarball loads through Pi package discovery, including supporting files and reload removals", options, async t => {
  const f = await fixture();
  const app = await f.boot(); t.after(() => app.close());
  assert.ok(app.loader.getExtensions().extensions.some(extension => extension.path === join(packageDirectory!, "src/extension.ts")));
  assert.deepEqual(app.loader.getExtensions().errors, []);
  assert.deepEqual(app.loader.getExtensions().warnings ?? [], []);
  assert.deepEqual(app.loader.getSkills().diagnostics, []);
  assert.deepEqual(app.loader.getSkills().skills.map(skill => skill.name).sort(), ["kept", "manual", "removed"]);
  assert.match(await app.invoke("manual"), /Manual fixture body/);
  assert.doesNotMatch(app.session.systemPrompt, /<name>manual<|nested-hidden|<name>excluded</);
  const selected = await f.store.loadSelected(); assert.ok(selected);
  assert.deepEqual(await readFile(join(selected.root, "LICENSE")), await readFile(join(f.a.root, "LICENSE")));
  assert.deepEqual(await readFile(join(selected.root, "skills/engineering/kept/assets/icon.bin")), await readFile(join(f.a.root, "skills/engineering/kept/assets/icon.bin")));
  assert.match(await readFile(join(selected.root, "shared/guide.md"), "utf8"), /bytes A/);
  await json(join(f.b.root, ".claude-plugin/plugin.json"), { ...f.b.fixture.manifest, version: "0.2.0-fixture", skills: ["./skills/engineering/kept"] });
  await put(f.b.root, "skills/engineering/kept/SKILL.md", "---\nname: kept\ndescription: Fixture\n---\nPackaged revision B.\n");
  f.choose(f.b); await f.store.update();
  assert.match(await app.invoke("kept"), /Original kept bytes/);
  await app.session.reload();
  assert.deepEqual(app.loader.getSkills().skills.map(skill => skill.name), ["kept"]);
  assert.match(await app.invoke("kept"), /Packaged revision B/);
  assert.deepEqual(app.errors, []);
});

for (const mode of ["text", "json"]) {
  test(`packaged production entrypoint works in real CLI ${mode} mode without stdout diagnostics`, options, async () => {
    const f = await fixture(), app = await f.boot(); await app.close();
    const env = { ...process.env, PI_CODING_AGENT_DIR: f.host.agentDir };
    const args = ["--import", deny, cli, ...commonArgs, "--provider", "m0-fixture", "--model", "echo", "--mode", mode, "--print"];
    const response = await runCLI([...args, "/skill:kept"], f.host.cwd, env);
    if (mode === "json") {
      const events = response.stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.ok(events.some(event => event.type === "message_end" && event.message.role === "assistant"));
    } else assert.match(response.stdout, /fixture answer/);
    const requests = (await readFile(join(f.host.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const request = requests.at(-1).context;
    assert.match(JSON.stringify(request.messages.findLast((message: { role: string }) => message.role === "user")), /Original kept bytes/);
    assert.match(getCurrentSystemPrompt(request.messages), /Stop worktree-dependent workflows/);
    const status = await runCLI([...args, "/mattpocock status"], f.host.cwd, env);
    assert.match(status.stderr, /Loaded: "0.1.0-fixture" @ a{40}/);
    assert.doesNotMatch(status.stdout, /pi-mattpocock-sync:|Latest session/);
    if (mode === "json") for (const line of status.stdout.trim().split("\n").filter(Boolean)) JSON.parse(line);
  });
}

test("real Pi local install/list/remove round trip stays inside disposable settings", options, async () => {
  const f = await fixture(), app = await f.boot(); await app.close();
  const env = { ...process.env, PI_CODING_AGENT_DIR: f.host.agentDir };
  const args = ["--import", deny, cli];
  const settingsPath = join(f.host.agentDir, "settings.json");
  const before = JSON.parse(await readFile(settingsPath, "utf8"));
  const state = await f.store.read();
  await runCLI([...args, "remove", packageDirectory!], f.host.cwd, env);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages, []);
  await runCLI([...args, "install", packageDirectory!], f.host.cwd, env);
  const installed = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(installed.packages.map((source: string) => resolve(f.host.agentDir, source)), [packageDirectory]);
  assert.deepEqual(installed.extensions, before.extensions);
  const listed = await runCLI([...args, "list"], f.host.cwd, env);
  assert.ok(listed.stdout.includes(installed.packages[0]) || listed.stdout.includes(packageDirectory!));
  const invoked = await runCLI([...args, ...commonArgs, "--provider", "m0-fixture", "--model", "echo", "--print", "/skill:manual"], f.host.cwd, env);
  assert.match(invoked.stdout, /fixture answer/);
  const requests = (await readFile(join(f.host.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.match(JSON.stringify(requests.at(-1).context.messages.findLast((message: { role: string }) => message.role === "user")), /Manual fixture body/);
  await runCLI([...args, "remove", packageDirectory!], f.host.cwd, env);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages, []);
  assert.deepEqual(await f.store.read(), state, "package settings operations do not erase or update the revision store");
  assert.ok(await readFile(join(packageDirectory!, "src/extension.ts")), "local removal must not delete the candidate directory");
});

test("packaged commands and notifications work over real Pi RPC", options, async t => {
  const f = await fixture(), app = await f.boot(); await app.close();
  const client = new RpcClient({ cliPath: cli, cwd: f.host.cwd, provider: "m0-fixture", model: "echo", args: commonArgs,
    env: { PI_CODING_AGENT_DIR: f.host.agentDir, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--import=${pathToFileURL(deny).href}` } });
  const events: unknown[] = [];
  client.onEvent(event => events.push(event));
  t.after(() => client.stop());
  await client.start();
  const commands = await client.getCommands();
  assert.ok(commands.some(command => command.name === "mattpocock"));
  assert.ok(commands.some(command => command.name === "skill:manual"));
  assert.equal(await client.prompt("/mattpocock status"), "handled");
  assert.match(JSON.stringify(events), /"method":"notify"/);
  assert.match(JSON.stringify(events), /Loaded:.*0.1.0-fixture/);
  await client.promptAndWait("/skill:manual", undefined, 15000);
  assert.equal(await client.getLastAssistantText(), "fixture answer");
});
