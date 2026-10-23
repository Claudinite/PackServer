// Loaded into every Node process that runs pack content (node --import). It records each attempt to
// leave the machine and refuses it. The container has no network either way; this record is what
// turns an attempt into evidence. It must stay free of imports from the workspace.
import dns from "node:dns";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";

const channel = process.env.B_EGRESS_PIPE;

function record(kind: "connect" | "dns" | "udp" | "fetch", target: unknown) {
  if (!channel) return;
  try {
    // Named by path rather than inherited as a descriptor, so a child process of a worker reaches it too.
    const fd = fs.openSync(channel, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try {
      fs.writeSync(fd, JSON.stringify({ kind, target: String(target).slice(0, 200) }) + "\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Nothing to do: the attempt is refused below whether or not it could be written down.
  }
}

const refusal = (kind: string) => Object.assign(new Error(`egress refused (${kind})`), { code: "ECONNREFUSED" });

function describe(args: unknown[]): string {
  // net.connect hands the socket its arguments already normalized, as [options, callback].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    const o = first as { host?: string; port?: number; path?: string };
    return o.path ? `unix:${o.path}` : `${o.host ?? "localhost"}:${o.port ?? ""}`;
  }
  if (typeof first === "number") return `${typeof args[1] === "string" ? args[1] : "localhost"}:${first}`;
  return `unix:${String(first)}`;
}

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  record("connect", describe(args));
  process.nextTick(() => this.destroy(refusal("connect")));
  return this;
} as typeof net.Socket.prototype.connect;

const dnsRefuse = (name: string) =>
  function (...args: unknown[]) {
    record("dns", `${name} ${String(args[0])}`);
    const cb = args.find((a) => typeof a === "function") as ((e: Error) => void) | undefined;
    process.nextTick(() => cb?.(refusal("dns")));
  };
for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveMx", "resolveTxt", "resolveSrv", "resolveCname", "resolveNs", "reverse"]) {
  (dns as unknown as Record<string, unknown>)[name] = dnsRefuse(name);
  (dns.promises as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
    record("dns", `${name} ${String(args[0])}`);
    throw refusal("dns");
  };
}

dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: unknown[]) {
  const nums = args.filter((a) => typeof a === "number");
  const host = args.find((a) => typeof a === "string");
  record("udp", `${String(host ?? "")}:${String(nums[nums.length - 1] ?? "")}`);
  const cb = args.find((a) => typeof a === "function") as ((e: Error) => void) | undefined;
  process.nextTick(() => cb?.(refusal("udp")));
} as typeof dgram.Socket.prototype.send;

globalThis.fetch = async (input: unknown) => {
  record("fetch", input instanceof Request ? input.url : String(input));
  throw refusal("fetch");
};
