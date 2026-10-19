// Opt-in qualification against the exact official standalone Pi executable.
// Usage: node test/standalone-run.mjs /absolute/path/to/pi
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const binary = process.argv[2];
if (!binary || !isAbsolute(binary)) throw new Error("Supply the absolute standalone Pi executable path");
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sync-standalone-")));
const fixture = fileURLToPath(new URL("./fixtures/standalone-store.ts", import.meta.url));
const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), NO_COLOR: "1" };
async function run(executable, args, extra = {}) {
  const child = spawn(executable, args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "inherit", "inherit"], timeout: 15000 });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : code));
  });
  if (code !== 0) throw new Error(`Runtime qualification failed (${code})`);
}
async function checkLoader() {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(binary, ["--mode", "rpc", "--no-session", "-e", packageRoot], {
    cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "", status = "", errors = "", finished = false;
  await new Promise((resolve, reject) => {
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.stdin.end(); child.kill();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("Standalone RPC timed out")), 15000);
    child.once("error", finish);
    child.once("exit", code => { if (!finished) finish(new Error(`Unexpected exit ${code}: ${errors}`)); });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.stdout.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "extension_ui_request" && event.message?.includes("Loaded:")) status = event.message;
          if (event.type !== "response") continue;
          assert.equal(event.success, true, line);
          if (event.id === "commands") {
            assert(event.data.commands.some(command => command.name === "mattpocock"));
            child.stdin.write(JSON.stringify({ id: "status", type: "prompt", message: "/mattpocock status" }) + "\n");
          } else if (event.id === "status") {
            assert(status.includes("Loaded: none"), status);
            assert(status.includes("Automatic updates: off"), status);
            assert(!errors.includes("Failed to load extension"), errors);
            finish();
          }
        } catch (error) { finish(error); }
      }
    });
    child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
  });
  console.log("PASS: actual standalone extension loader and /mattpocock status (offline, isolated)");
}
try {
  const store = join(env.PI_CODING_AGENT_DIR, "mattpocock-sync");
  const preload = ["--import", fileURLToPath(new URL("./deny-network.mjs", import.meta.url)), "--import", import.meta.resolve("tsx")];
  await run(process.execPath, [...preload, fixture, store, "seed"]);
  await run(binary, [fixture, store, "bun"], { BUN_BE_BUN: "1" });
  await run(process.execPath, [...preload, fixture, store, "verify"]);
  console.log("PASS: standalone SQLite persistence, contention, rollback, and Node interoperability");
  await checkLoader();
} finally { await rm(root, { recursive: true, force: true }); }
