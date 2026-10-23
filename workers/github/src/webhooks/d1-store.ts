import type { GithubFact, GithubStore, InstallationStatus } from "@packserver/core/github";
import type { D1 } from "@packserver/ports";

/** The webhook handler's memory, in the registry database. */
export function d1GithubStore(d1: D1): GithubStore {
  return {
    async hasDelivery(deliveryId, bodySha256) {
      const { rows } = await d1.query("select 1 from github_deliveries where delivery_id = ? or body_sha256 = ? limit 1", [deliveryId, bodySha256]);
      return rows.length > 0;
    },
    async installationStatus(installationId) {
      const { rows } = await d1.query("select status from github_installations where installation_id = ?", [installationId]);
      return (rows[0]?.status as InstallationStatus | undefined) ?? null;
    },
    async recordInstallation(fact: Extract<GithubFact, { kind: "installation" }>, now) {
      await d1.query(
        `insert into github_installations (installation_id, account_id, account_login, account_type, sender_login, repository_selection, status, installed_at, uninstalled_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'active', ?, null, ?)
         on conflict (installation_id) do update set account_id = excluded.account_id, account_login = excluded.account_login,
           account_type = excluded.account_type, sender_login = excluded.sender_login, repository_selection = excluded.repository_selection,
           status = 'active', installed_at = excluded.installed_at, uninstalled_at = null, updated_at = excluded.updated_at`,
        [fact.installationId, fact.account.id, fact.account.login, fact.account.type, fact.senderLogin, fact.repositorySelection, now, now],
      );
    },
    async setInstallationStatus(installationId, status, now) {
      await d1.query(
        "update github_installations set status = ?, uninstalled_at = case when ? = 'deleted' then ? else uninstalled_at end, updated_at = ? where installation_id = ?",
        [status, status, now, now, installationId],
      );
    },
    async setRepositorySelection(installationId, selection, now) {
      await d1.query("update github_installations set repository_selection = ?, updated_at = ? where installation_id = ?", [selection, now, installationId]);
    },
    async recordIssue(fact: Extract<GithubFact, { kind: "issue" }>, now) {
      await d1.query(
        `insert into github_issue_states (repository_id, issue_number, repository, html_url, state, source_updated_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (repository_id, issue_number) do update set repository = excluded.repository, html_url = excluded.html_url,
           state = excluded.state, source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at
         where excluded.source_updated_at >= github_issue_states.source_updated_at`,
        [fact.repositoryId, fact.number, fact.repository, fact.htmlUrl, fact.state, fact.updatedAt, now],
      );
    },
    async recordDelivery(deliveryId, event, bodySha256, now) {
      await d1.query("insert or ignore into github_deliveries (delivery_id, event, body_sha256, received_at) values (?, ?, ?, ?)", [deliveryId, event, bodySha256, now]);
    },
  };
}
