import assert from "node:assert/strict";
import { access, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { acquireSnapshot, parseArchive, ACQUISITION_LIMITS } from "../src/acquisition.ts";
import { captureSnapshot, inspectSnapshot } from "../src/snapshot.ts";
import { operationBudget, SyncFailure } from "../src/sync-operation.ts";
import { commitA, snapshotFixture } from "./snapshot-fixtures.ts";

type Entry = Partial<tar.Header> & Pick<tar.Header, "name"> & { bytes?: Buffer | string };
async function archive(entries: Entry[]) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const consume = (async () => { for await (const chunk of pack) { assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk); } })();
  for (const { bytes, ...header } of entries) {
    await new Promise<void>((resolve, reject) => pack.entry(header, bytes ?? "", error => error ? reject(error) : resolve()));
  }
  pack.finalize(); await consume;
  return gzipSync(Buffer.concat(chunks));
}
async function fixtureArchive(root: string) {
  const { entries } = await captureSnapshot(root, commitA);
  return archive([...entries.values()].map(entry => ({ name: `skills-${commitA}/${entry.info.path}`,
    type: entry.info.kind, mode: entry.info.mode, linkname: entry.info.target, bytes: entry.bytes })));
}
function transport(bytes: Buffer, calls: string[] = []): typeof fetch {
  return async (input, options) => {
    const url = String(input); calls.push(url);
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    if (url.endsWith("/repos/mattpocock/skills")) return Response.json({ default_branch: "fixture/branch" });
    if (url.endsWith("/commits/fixture%2Fbranch")) return Response.json({ sha: commitA });
    assert.equal(url, `https://codeload.github.com/mattpocock/skills/tar.gz/${commitA}`);
    return new Response(new Uint8Array(bytes));
  };
}
const options = { timeout: 15000 };

test("official resolution pins all imported content to one commit and preserves safe links", options, async () => {
  const f = await snapshotFixture();
  await symlink("shared/guide.md", join(f.source, "GUIDE.md"));
  const bytes = await fixtureArchive(f.source);
  const calls: string[] = [];
  const acquired = await acquireSnapshot({ directory: join(f.root, "downloads"), signal: new AbortController().signal, fetch: transport(bytes, calls) });
  try {
    assert.equal(acquired.commit, commitA);
    assert.equal(calls.length, 3);
    const source = await inspectSnapshot(f.source, commitA);
    const imported = await inspectSnapshot(acquired.root, commitA);
    assert.equal(imported.digest, source.digest);
    assert.deepEqual(imported.skills, source.skills);
    assert.equal(await readlink(join(acquired.root, "GUIDE.md")), "shared/guide.md");
    assert.deepEqual(await readFile(join(acquired.root, "shared/guide.md")), await readFile(join(f.source, "shared/guide.md")));
    await assert.rejects(access(join(acquired.root, "SHOULD_NEVER_RUN")));
  } finally { await acquired.cleanup(); }
  await assert.rejects(access(acquired.root));
});

for (const entries of [
  [{ name: "../escape", bytes: "no" }],
  [{ name: "/absolute", bytes: "no" }],
  [{ name: `skills-${commitA}/a/../escape`, bytes: "no" }],
  [{ name: `skills-${commitA}/a\\b`, bytes: "no" }],
  [{ name: `skills-${commitA}/a`, bytes: "one" }, { name: `skills-${commitA}/a`, bytes: "two" }],
  [{ name: `skills-${commitA}/a`, bytes: "one" }, { name: `skills-${commitA}/A`, bytes: "two" }],
  [{ name: `skills-${commitA}/hard`, type: "link", linkname: "target" }],
  [{ name: `skills-${commitA}/pipe`, type: "fifo" }],
  [{ name: `skills-${commitA}/bad`, type: "symlink", linkname: "../outside" }],
  [{ name: `skills-${commitA}/bad`, type: "symlink", linkname: "bad" }],
  [{ name: `skills-${commitA}/parent`, type: "symlink", linkname: "." }, { name: `skills-${commitA}/parent/child`, bytes: "no" }],
  [{ name: `skills-${commitA}/parent/child`, bytes: "no" }, { name: `skills-${commitA}/parent`, type: "symlink", linkname: "." }],
  [{ name: "wrong-revision/file", bytes: "no" }],
  [{ name: `skills-${commitA}/caf\u00e9`, bytes: "one" }, { name: `skills-${commitA}/cafe\u0301`, bytes: "two" }],
  [{ name: `skills-${commitA}/absolute-link`, type: "symlink", linkname: "/outside" }],
  [{ name: `skills-${commitA}/special-mode`, mode: 0o4755, bytes: "no" }],
] satisfies Entry[][]) {
  test(`rejects unsafe archive entries: ${entries.map(e => e.name).join(", ")}`, options, async () => {
    const f = await snapshotFixture();
    const bytes = await archive(entries);
    const directory = join(f.root, "downloads");
    await assert.rejects(acquireSnapshot({ directory, signal: new AbortController().signal, fetch: transport(bytes) }));
    await assert.rejects(access(directory), "entry validation must precede filesystem extraction");
  });
}

test("truncated gzip and compressed-byte limits fail closed", options, async () => {
  const f = await snapshotFixture();
  const bytes = await fixtureArchive(f.source);
  await assert.rejects(parseArchive(bytes.subarray(0, bytes.length - 8), commitA, new AbortController().signal));
  await assert.rejects(parseArchive(Buffer.alloc(ACQUISITION_LIMITS.compressedBytes + 1), commitA, new AbortController().signal));
});

test("long PAX paths are rejected before implicit-parent expansion", options, async () => {
  const path = Array.from({ length: 200 }, () => "segment".repeat(10)).join("/");
  const bytes = await archive([{ name: `skills-${commitA}/${path}/file`, bytes: "" }]);
  await assert.rejects(parseArchive(bytes, commitA, new AbortController().signal));
});

test("aggregate implicit-parent paths and link-target depth are bounded", options, async () => {
  const entries = Array.from({ length: 1500 }, (_, i) => ({
    name: `skills-${commitA}/${"a".repeat(240)}/${i}/${"b".repeat(240)}/${"c".repeat(240)}`, bytes: "",
  }));
  await assert.rejects(parseArchive(await archive(entries), commitA, new AbortController().signal));
  const links: Entry[] = [
    { name: `skills-${commitA}/target`, bytes: "valid target" },
    { name: `skills-${commitA}/link`, type: "symlink", linkname: "./".repeat(1000) + "target" },
  ];
  await assert.rejects(parseArchive(await archive(links), commitA, new AbortController().signal));
});

test("file, decompression and entry-count limits are enforced before extraction", options, async () => {
  const signal = new AbortController().signal;
  const oversizedFile = await archive([{ name: `skills-${commitA}/large`, bytes: Buffer.alloc(ACQUISITION_LIMITS.fileBytes + 1) }]);
  await assert.rejects(parseArchive(oversizedFile, commitA, signal));
  const expansion = gzipSync(Buffer.alloc(ACQUISITION_LIMITS.tarBytes + 1));
  await assert.rejects(parseArchive(expansion, commitA, signal));
  const entries = Array.from({ length: ACQUISITION_LIMITS.entries + 1 }, (_, i) => ({ name: `skills-${commitA}/file-${i}`, bytes: "" }));
  await assert.rejects(parseArchive(await archive(entries), commitA, signal));
});

for (const status of [301, 403, 429, 500]) {
  test(`HTTP ${status} is not silently followed or accepted`, options, async () => {
    const f = await snapshotFixture();
    let calls = 0;
    await assert.rejects(acquireSnapshot({ directory: join(f.root, "downloads"), signal: new AbortController().signal,
      fetch: async () => { calls++; return new Response("untrusted response body", { status, headers: { location: "https://untrusted.invalid/" } }); } }),
    error => error instanceof SyncFailure && error.code === "http" && error.httpStatus === status);
    assert.equal(calls, 1);
  });
}

test("offline transport and an oversized metadata response are bounded failures", options, async () => {
  const f = await snapshotFixture();
  await assert.rejects(acquireSnapshot({ directory: join(f.root, "downloads"), signal: new AbortController().signal,
    fetch: async () => { throw new TypeError("fixture offline"); } }), error => error instanceof SyncFailure && error.code === "network");
  await assert.rejects(acquireSnapshot({ directory: join(f.root, "downloads"), signal: new AbortController().signal,
    fetch: async () => new Response("{}", { headers: { "content-length": String(ACQUISITION_LIMITS.jsonBytes + 1) } }) }));
});

test("real fixture HTTP covers success, rate limits, redirects and stalled sockets without remote access", options, async t => {
  const f = await snapshotFixture();
  const bytes = await fixtureArchive(f.source);
  let mode = "success";
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/target") redirectedRequests++;
    if (mode === "rate-limit") { response.writeHead(429); response.end("fixture rate limit"); return; }
    if (mode === "redirect") { response.writeHead(302, { location: "/target" }); response.end(); return; }
    if (mode === "stalled") { response.writeHead(200); response.write("{"); return; }
    if (request.url?.endsWith("/repos/mattpocock/skills")) response.end(JSON.stringify({ default_branch: "fixture/branch" }));
    else if (request.url?.includes("/commits/")) response.end(JSON.stringify({ sha: commitA }));
    else response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const ports = Reflect.get(globalThis, Symbol.for("sync-test-loopback-ports")) as Set<number>;
  ports.add(address.port);
  t.after(async () => {
    ports.delete(address.port);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.ok(["api.github.com", "codeload.github.com"].includes(url.hostname));
    const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  const acquired = await acquireSnapshot({ directory: join(f.root, "downloads"), signal: new AbortController().signal, fetch: fetchFixture });
  assert.equal((await inspectSnapshot(acquired.root, commitA)).version, f.manifest.version);
  await acquired.cleanup();
  mode = "rate-limit";
  await assert.rejects(acquireSnapshot({ directory: join(f.root, "downloads"), signal: new AbortController().signal, fetch: fetchFixture }),
    error => error instanceof SyncFailure && error.httpStatus === 429);
  mode = "redirect";
  await assert.rejects(acquireSnapshot({ directory: join(f.root, "downloads"), signal: new AbortController().signal, fetch: fetchFixture }));
  assert.equal(redirectedRequests, 0);
  mode = "stalled";
  const budget = operationBudget(40);
  try {
    await assert.rejects(acquireSnapshot({ directory: join(f.root, "downloads"), signal: budget.signal, fetch: fetchFixture }),
      error => error instanceof SyncFailure && error.code === "timeout");
  } finally { budget.dispose(); }
  assert.throws(() => fetch("https://example.invalid/"), /unapproved network/);
});

test("the operation budget cancels a stalled response body and runs cleanup", options, async () => {
  const f = await snapshotFixture();
  const budget = operationBudget(30);
  let cancelled = false;
  try {
    await assert.rejects(acquireSnapshot({ directory: join(f.root, "downloads"), signal: budget.signal,
      fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }),
    error => error instanceof SyncFailure && error.code === "timeout");
    assert.ok(cancelled);
    await assert.rejects(access(join(f.root, "downloads")));
  } finally { budget.dispose(); }
});
