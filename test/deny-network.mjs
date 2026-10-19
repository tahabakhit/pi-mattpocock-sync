import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

// Test-only explicit loopback capabilities. No remote address or Unix socket is
// allowed. This remains a tripwire, not an OS sandbox for arbitrary subprocesses.
const ports = new Set();
Object.defineProperty(globalThis, Symbol.for("sync-test-loopback-ports"), { value: ports });
const connect = net.Socket.prototype.connect;
const nativeFetch = globalThis.fetch;
const denied = () => { throw new Error("Fixture tests forbid unapproved network access"); };
const allowed = (host, port) => host === "127.0.0.1" && ports.has(Number(port));
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const host = typeof first === "object" && first ? first.host : values[1];
  const port = typeof first === "object" && first ? first.port : first;
  if (!allowed(host, port)) return denied();
  return connect.apply(this, args);
};
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" || url.username || url.password || !allowed(url.hostname, url.port)) return denied();
  return nativeFetch(input, options);
};
syncBuiltinESMExports();
