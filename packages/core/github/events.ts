import { z } from "zod";

/** The only events the App subscribes to; `push` is deliberately absent. */
export const SUBSCRIBED_EVENTS = ["installation", "installation_repositories", "issues"] as const;
export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

const Account = z.object({ id: z.number().int(), login: z.string().min(1), type: z.enum(["Organization", "User"]) });
const Installation = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().optional(),
  account: Account.optional(),
  repository_selection: z.enum(["all", "selected"]).optional(),
});
const Sender = z.object({ login: z.string().min(1) });

const InstallationEvent = z.object({
  action: z.string(),
  installation: Installation.extend({ account: Account, repository_selection: z.enum(["all", "selected"]) }),
  sender: Sender,
});
const InstallationRepositoriesEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository_selection: z.enum(["all", "selected"]),
});
const IssuesEvent = z.object({
  action: z.string(),
  installation: Installation.pick({ id: true }).optional(),
  issue: z.object({
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    html_url: z.url(),
    updated_at: z.string().min(1),
  }),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().min(1), private: z.boolean() }),
});

export type GithubFact =
  | {
      kind: "installation";
      action: string;
      installationId: number;
      appId: number | null;
      account: z.infer<typeof Account>;
      repositorySelection: "all" | "selected";
      senderLogin: string;
    }
  | { kind: "repositories"; installationId: number; repositorySelection: "all" | "selected" }
  | {
      kind: "issue";
      action: string;
      installationId: number | null;
      repositoryId: number;
      repository: string;
      repositoryPrivate: boolean;
      number: number;
      htmlUrl: string;
      state: "open" | "closed" | "deleted";
      updatedAt: string;
    };

/** Throws a ZodError for a body that is not the documented shape of a subscribed event. */
export function parseEvent(event: SubscribedEvent, payload: unknown): GithubFact {
  switch (event) {
    case "installation": {
      const p = InstallationEvent.parse(payload);
      return {
        kind: "installation",
        action: p.action,
        installationId: p.installation.id,
        appId: p.installation.app_id ?? null,
        account: p.installation.account,
        repositorySelection: p.installation.repository_selection,
        senderLogin: p.sender.login,
      };
    }
    case "installation_repositories": {
      const p = InstallationRepositoriesEvent.parse(payload);
      return { kind: "repositories", installationId: p.installation.id, repositorySelection: p.repository_selection };
    }
    case "issues": {
      const p = IssuesEvent.parse(payload);
      return {
        kind: "issue",
        action: p.action,
        installationId: p.installation?.id ?? null,
        repositoryId: p.repository.id,
        repository: p.repository.full_name,
        repositoryPrivate: p.repository.private,
        number: p.issue.number,
        htmlUrl: p.issue.html_url,
        state: p.action === "deleted" ? "deleted" : p.issue.state,
        updatedAt: p.issue.updated_at,
      };
    }
  }
}

export const isSubscribedEvent = (event: string): event is SubscribedEvent => (SUBSCRIBED_EVENTS as readonly string[]).includes(event);
