import { SqliteD1 } from "@packserver/core/audit/testing";
import { describe, expect, it } from "vitest";
import { d1GithubStore } from "../src/webhooks/d1-store";

const at = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();

describe("when an installation stopped counting (REQ-SCOPE-009)", () => {
  const setup = async () => {
    const d1 = new SqliteD1();
    const store = d1GithubStore(d1);
    await store.recordInstallation(
      { kind: "installation", installationId: 5, account: { id: 9, login: "acme", type: "Organization" }, senderLogin: "ann", repositorySelection: "all" } as never,
      at(1),
    );
    return { d1, store, since: () => d1.rows("select inactive_since from github_installations where installation_id = 5")[0]!.inactive_since };
  };

  it("is set once by a suspension and not moved by a redelivery, a selection change or a later removal", async () => {
    const { store, since } = await setup();
    expect(since()).toBeNull();
    await store.setInstallationStatus(5, "suspended", at(2));
    await store.setInstallationStatus(5, "suspended", at(4));
    await store.setRepositorySelection(5, "selected", at(5));
    await store.setInstallationStatus(5, "deleted", at(6));
    expect(since()).toBe(at(2));
  });

  it("is cleared by an unsuspend and by a reinstall", async () => {
    const { store, since } = await setup();
    await store.setInstallationStatus(5, "suspended", at(2));
    await store.setInstallationStatus(5, "active", at(3));
    expect(since()).toBeNull();
    await store.setInstallationStatus(5, "deleted", at(4));
    expect(since()).toBe(at(4));
    await store.recordInstallation(
      { kind: "installation", installationId: 5, account: { id: 9, login: "acme", type: "Organization" }, senderLogin: "ann", repositorySelection: "all" } as never,
      at(5),
    );
    expect(since()).toBeNull();
  });
});
