import { emptyHistogram, LATENCY_BOUNDS_MS } from "@packserver/core/gates";
import { createFakePorts, type FakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { authoriseAdminCall, type AdminRequest, type AdminResponse } from "@packserver/schema";
import type { JudgeRuntime } from "../src/bindings";
import type { AdminClient } from "../src/heartbeat/admin-client";
import type { DomainRow, GateDataSource, ProbeRow, ReadWindow, RequestData, RequestGroup, WindowCounts } from "../src/stats/source";

/** The groups and clients are given for one window and answered for every window the cycle asks about, unless `provider` answers by window. */
export class FakeGateData implements GateDataSource {
  groups: GroupSpec[] = [];
  principals: ClientSpec[] = [];
  ips: ClientSpec[] = [];
  domain: Array<Omit<DomainRow, "windows"> & { windows?: number[] }> = [];
  listsCut = false;
  probes: ProbeRow[] = [];
  reads: string[] = [];
  windows: ReadWindow[] = [];
  provider: ((window: ReadWindow) => RequestData) | null = null;
  async requestOutcomes(window: ReadWindow): Promise<RequestData> {
    this.reads.push("request_outcomes");
    this.windows.push(window);
    if (this.provider) return this.provider(window);
    const n = window.starts.length;
    return {
      groups: this.groups.map(({ counts, ...g }) => ({ ...g, windows: Array.from({ length: n }, () => counts) })),
      principals: this.principals.map((c) => ({ version_id: c.version_id, key: c.key, windows: Array.from({ length: n }, () => ({ samples: c.samples, bad: c.bad })) })),
      ips: this.ips.map((c) => ({ version_id: c.version_id, key: c.key, windows: Array.from({ length: n }, () => ({ samples: c.samples, bad: c.bad })) })),
      exactVersions: window.candidates.map((c) => c.version),
      listsCut: this.listsCut,
    };
  }
  async domainEvents(window: ReadWindow): Promise<DomainRow[]> {
    this.reads.push("domain_events");
    return this.domain.map((r) => ({ ...r, windows: r.windows ?? window.starts.map(() => r.n) }));
  }
  async syntheticProbes() {
    this.reads.push("synthetic_probes");
    return this.probes;
  }
}

export type GroupSpec = Omit<RequestGroup, "windows"> & { counts: WindowCounts };
export interface ClientSpec {
  version_id: string;
  key: string;
  samples: number;
  bad: number;
}

export class FakeAdmin implements AdminClient {
  calls: AdminRequest[] = [];
  refuse = false;
  async call(request: AdminRequest): Promise<AdminResponse> {
    this.calls.push(request);
    return this.refuse ? { ok: false, refusal: { reason: "forbidden" } } : { ok: true, audit_id: "audit-1" };
  }
}

/** `samples` requests answered in 100 ms, `bad` of them failed. */
export function counts(samples: number, bad = 0, downloads = 0): WindowCounts {
  const latency = emptyHistogram();
  latency[LATENCY_BOUNDS_MS.findIndex((b) => 100 <= b)] = samples;
  return { samples, bad, downloads, latency };
}

export function group(version: string, worker: string, samples: number, bad = 0, options: Partial<Omit<GroupSpec, "counts">> = {}): GroupSpec {
  return { version_id: version, worker, override: false, synthetic: false, today: samples, recent: samples, counts: counts(samples, bad), ...options };
}

export function runtimeWith(fakes: FakePorts, data: GateDataSource = new FakeGateData(), admin: AdminClient = new FakeAdmin()): JudgeRuntime {
  return {
    worker: "judge",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: fakes,
    services: { admin: {} as Fetcher },
    config: { alerts: null, alertsMissing: [], data, adminClient: admin, audit: { list: async () => ({ result: [] }) }, ciTokenIds: [], dailyLogAllowance: 1000 },
  };
}

export const judgeFakes = (): FakePorts => createFakePorts({ worker: "judge" });

export const adminAllows = (caller: "judge" | "admin_app", method: string): boolean => authoriseAdminCall(caller, method, false).allowed;
