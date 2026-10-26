import { emptyHistogram, LATENCY_BOUNDS_MS } from "@packserver/core/gates";
import { createFakePorts, type FakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { authoriseAdminCall, type AdminRequest, type AdminResponse } from "@packserver/schema";
import type { JudgeRuntime } from "../src/bindings";
import type { AdminClient } from "../src/heartbeat/admin-client";
import type { DomainRow, GateDataSource, ProbeRow, RequestGroup } from "../src/stats/source";

export class FakeGateData implements GateDataSource {
  groups: RequestGroup[] = [];
  domain: DomainRow[] = [];
  probes: ProbeRow[] = [];
  reads: string[] = [];
  async requestOutcomes() {
    this.reads.push("request_outcomes");
    return this.groups;
  }
  async domainEvents() {
    this.reads.push("domain_events");
    return this.domain;
  }
  async syntheticProbes() {
    this.reads.push("synthetic_probes");
    return this.probes;
  }
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
export function group(version: string, worker: string, samples: number, bad = 0, options: Partial<RequestGroup> = {}): RequestGroup {
  const latency = emptyHistogram();
  latency[LATENCY_BOUNDS_MS.findIndex((b) => 100 <= b)] = samples;
  return { version_id: version, worker, override: false, synthetic: false, principal: "", ip: "", samples, bad, downloads: 0, today: samples, recent: samples, latency, ...options };
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
    config: { data, adminClient: admin, audit: { list: async () => ({ result: [] }) }, ciTokenIds: [], dailyLogAllowance: 1000 },
  };
}

export const judgeFakes = (): FakePorts => createFakePorts({ worker: "judge" });

export const adminAllows = (caller: "judge" | "admin_app", method: string): boolean => authoriseAdminCall(caller, method, false).allowed;
