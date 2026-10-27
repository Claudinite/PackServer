import type { Mail } from "@packserver/ports";
import { render, type Notice } from "./notice";
import { appealDecided } from "./templates/appeal-decided";
import { domainDriftWarning } from "./templates/domain-drift-warning";
import { domainProofMoved } from "./templates/domain-proof-moved";
import { domainProofWarning } from "./templates/domain-proof-warning";
import { factorAdded } from "./templates/factor-added";
import { githubOrgProofAlert } from "./templates/github-org-proof-alert";
import { newDeviceSignIn } from "./templates/new-device-sign-in";
import { packActioned } from "./templates/pack-actioned";
import { providerLinked } from "./templates/provider-linked";
import { recoveryApproved } from "./templates/recovery-approved";
import { recoveryStarted } from "./templates/recovery-started";
import { reportStatusChanged } from "./templates/report-status-changed";
import { scopeNameDisputed } from "./templates/scope-name-disputed";
import { scopeRenamed } from "./templates/scope-renamed";
import { securityReportReminder } from "./templates/security-report-reminder";
import { securityReportUpdate } from "./templates/security-report-update";
import { stepUpLocked } from "./templates/step-up-locked";
import { trustedPublisherChanged } from "./templates/trusted-publisher-changed";
import { validationVerdict } from "./templates/validation-verdict";
import { verifiedPublisherDecision } from "./templates/verified-publisher-decision";
import { versionPublished } from "./templates/version-published";
import { versionWithdrawn } from "./templates/version-withdrawn";

export type { Notice } from "./notice";
export { escapeHtml, render } from "./notice";

/** Each notice-emitting task adds its template file and one line here. */
export const NOTICES = {
  "factor-added": factorAdded,
  "new-device-sign-in": newDeviceSignIn,
  "step-up-locked": stepUpLocked,
  "provider-linked": providerLinked,
  "recovery-approved": recoveryApproved,
  "recovery-started": recoveryStarted,
  "trusted-publisher-changed": trustedPublisherChanged,
  "validation-verdict": validationVerdict,
  "version-published": versionPublished,
  "domain-proof-warning": domainProofWarning,
  "verified-publisher-decision": verifiedPublisherDecision,
  "report-status-changed": reportStatusChanged,
  "security-report-reminder": securityReportReminder,
  "security-report-update": securityReportUpdate,
  "version-withdrawn": versionWithdrawn,
  "pack-actioned": packActioned,
  "appeal-decided": appealDecided,
  "domain-drift-warning": domainDriftWarning,
  "domain-proof-moved": domainProofMoved,
  "github-org-proof-alert": githubOrgProofAlert,
  "scope-name-disputed": scopeNameDisputed,
  "scope-renamed": scopeRenamed,
} as const;

export type NoticeKind = keyof typeof NOTICES;
export type NoticeData<K extends NoticeKind> = Parameters<(typeof NOTICES)[K]>[0];

export function renderNotice<K extends NoticeKind>(kind: K, data: NoticeData<K>) {
  const template = NOTICES[kind] as (d: NoticeData<K>) => Notice;
  return render(template(data));
}

export function sendNotice<K extends NoticeKind>(mail: Mail, to: string, kind: K, data: NoticeData<K>) {
  return mail.send({ to, ...renderNotice(kind, data) });
}
