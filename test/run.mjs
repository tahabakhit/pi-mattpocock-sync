import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Set HOME before Pi (or any dependency) imports. Never inherit provider keys,
// NODE_OPTIONS, Pi extensions, user npm settings, or the active agent directory.
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--package")) throw new Error("Usage: node test/run.mjs [--package <installed directory>]");
const packageDirectory = args.length ? await realpath(args[1]) : undefined;
// Canonicalize macOS /var and /tmp aliases before enforcing store containment.
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-mattpocock-test-")));
const cwd = join(root, "workspace");
await mkdir(cwd);
const env = {
  PATH: process.env.PATH,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  PI_CODING_AGENT_DIR: join(root, "agent"),
  M0_ROOT: root,
  ...(packageDirectory ? { M4_PACKAGE_DIR: packageDirectory } : {}),
  TERM: "dumb",
  NO_COLOR: "1",
};
try {
  const child = spawn(process.execPath, [
    "--import", fileURLToPath(new URL("./deny-network.mjs", import.meta.url)),
    "--import", import.meta.resolve("tsx"),
    "--test", "--test-concurrency=1",
    ...(packageDirectory ? [fileURLToPath(new URL("./fixtures/package-check.ts", import.meta.url))]
      : (await readdir(fileURLToPath(new URL("./", import.meta.url))))
        .filter(name => name.endsWith(".test.ts")).sort()
        .map(name => fileURLToPath(new URL(name, import.meta.url)))),
  ], { cwd, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(root, { recursive: true, force: true });
}
