import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Deliberately separate from npm test: this qualification installs public npm
// runtime dependencies into a disposable consumer, never into active Pi.
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-mattpocock-package-")));
const env = {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
  NPM_CONFIG_USERCONFIG: join(root, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global-npmrc"),
  NPM_CONFIG_CACHE: join(root, "npm-cache"), NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  NO_COLOR: "1", TERM: "dumb",
};
const run = (command, args, cwd = repository) => {
  const pending = exec(command, args, { cwd, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  pending.child.stdin?.end();
  return pending;
};
try {
  await mkdir(env.HOME);
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  assert.equal(manifest.private, true, "M4 must not remove the publication guard");
  assert.equal(manifest.version, "0.0.0", "a release version requires release approval");
  assert.ok(manifest.files.every(path => typeof path === "string" && !/[*!\\]/.test(path) && !path.split("/").includes("..")));
  assert.deepEqual(manifest.pi, { extensions: ["./src/extension.ts"], skills: [], prompts: [], themes: [] });
  assert.deepEqual(manifest.peerDependencies, { "@earendil-works/pi-coding-agent": "*" });
  assert.ok(!manifest.bundledDependencies && !manifest.bundleDependencies);
  for (const name of Object.keys(manifest.scripts)) assert.ok(!/^(pre|post|prepare|install|publish)/.test(name), "no lifecycle scripts in the artifact");
  const packed = JSON.parse((await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root])).stdout);
  assert.equal(packed.length, 1);
  const artifact = packed[0];
  assert.deepEqual(artifact.files.map(file => file.path).sort(), [...new Set(["package.json", ...manifest.files])].sort(), "tarball must match the exact file allowlist");
  assert.ok(artifact.files.every(file => file.size <= 128 * 1024));
  assert.ok(artifact.unpackedSize < 256 * 1024);
  const consumer = join(root, "consumer"); await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "isolated-fixture-consumer", private: true, version: "0.0.0" }));
  const tarball = join(root, artifact.filename);
  await run("npm", ["install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball], consumer);
  const installed = join(consumer, "node_modules", manifest.name);
  assert.equal((await lstat(installed)).isSymbolicLink(), false, "must install the tarball, not link the checkout");
  for (const file of artifact.files) {
    assert.deepEqual(await readFile(join(installed, file.path)), await readFile(join(repository, file.path)), `artifact changed ${file.path}`);
  }
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.private, true);
  const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
  for (const path of Object.keys(lock.packages)) {
    assert.ok(!/node_modules\/(?:@earendil-works\/|@gotgenes\/|typescript(?:\/|$)|tsx(?:\/|$)|@types\/)/.test(path), `development/host dependency leaked: ${path}`);
  }
  async function inspectPhysicalPackages(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspectPhysicalPackages(path);
      else if (entry.isFile() && entry.name === "package.json") {
        const value = JSON.parse(await readFile(path, "utf8"));
        assert.ok(!/^(?:@earendil-works\/|@gotgenes\/|typescript$|tsx$|@types\/)/.test(value.name ?? ""), `physical development/host dependency leaked: ${value.name}`);
      }
    }
  }
  await inspectPhysicalPackages(join(consumer, "node_modules"));
  const require = createRequire(join(installed, "package.json"));
  for (const dependency of Object.keys(manifest.dependencies)) {
    assert.ok(require.resolve(dependency).startsWith(join(consumer, "node_modules") + "/"), `${dependency} must resolve inside the independent consumer`);
  }
  for (const path of ["README.md", "docs/usage.md", "docs/release.md"]) {
    const text = await readFile(join(installed, path), "utf8");
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const destination = match[1].split("#")[0];
      if (!destination || /^[a-z]+:/i.test(destination)) continue;
      assert.ok((await lstat(join(dirname(join(installed, path)), destination))).isFile(), `missing packaged documentation link: ${destination}`);
    }
  }
  const checked = await run(process.execPath, [join(repository, "test/run.mjs"), "--package", installed]);
  process.stdout.write(checked.stdout); process.stderr.write(checked.stderr);
  console.log(JSON.stringify({ artifact: artifact.filename, sha256: createHash("sha256").update(await readFile(tarball)).digest("hex"),
    files: artifact.files.map(file => file.path), unpackedBytes: artifact.unpackedSize,
    runtimeDependencies: Object.fromEntries(Object.entries(lock.packages).filter(([path]) => path && path !== `node_modules/${manifest.name}`).map(([path, value]) => [path.replace(/^node_modules\//, ""), value.version])),
    hostPeerBundled: false, upstreamContentBundled: false, consumerRemovedOnExit: true }, null, 2));
} catch (error) {
  // Only disposable fixtures/public npm metadata occur in these subprocesses.
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally { await rm(root, { recursive: true, force: true }); }
