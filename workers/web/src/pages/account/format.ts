const day = (iso: string): string => iso.slice(0, 10);

export const dateOf = (iso: string | null | undefined): string => (iso ? day(iso) : "never");

export const stampOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One plain sentence per audited action a person can see in their own history. */
const EVENT_TEXT: Record<string, string> = {
  login: "Signed in",
  "factor.added": "Added a passkey or recovery codes",
  "factor.removed": "Removed a passkey",
  "provider.linked": "Linked GitHub",
  "token.minted": "Created a read token",
  "token.revoked": "Revoked a read token",
  "session.revoked": "Ended a session",
  "account.deleted": "Deleted the account",
  "recovery.requested": "Account recovery requested",
  "recovery.approved": "Account recovery approved",
  "recovery.cancelled": "Account recovery cancelled",
  "assertion.refused": "A confirmation did not verify",
  "signin.refused": "A sign-in was refused",
  "token.refused": "A token was refused",
  "grant.changed": "Changed who can read a private pack",
  "trusted_publisher.changed": "Changed a trusted publisher",
  "publish.approved": "Approved a version",
  "visibility.changed": "Changed a pack's visibility",
  "version.yanked": "Yanked a version",
  "scope.mfa_policy.changed": "Changed an organisation's sign-in policy",
  "publish.refused": "A publish was refused",
};

export const eventText = (action: string): string => EVENT_TEXT[action] ?? action;

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
