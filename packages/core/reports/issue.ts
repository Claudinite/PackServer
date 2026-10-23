import type { ReportInput } from "./input.ts";

/** GitHub refuses a new-issue link whose address is much longer than this. */
const MAX_URL_LENGTH = 7000;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepository(value: string): boolean {
  return REPOSITORY.test(value);
}

/**
 * The link a reporter opens to file the issue under their own account. Building it is all PackServer does:
 * nothing is sent to GitHub (REQ-MOD-001).
 */
export function prefilledIssueUrl(repository: string, report: Extract<ReportInput, { kind: "bug" }>, packName: string, reportUrl: string): string {
  if (!isRepository(repository)) throw new Error("not a GitHub repository");
  const body = (repro: string) =>
    [
      `Pack: ${packName}@${report.version}`,
      `Type: ${report.type.replace("_", " ")} · Severity: ${report.severity}`,
      "",
      "### Steps to reproduce",
      repro,
      "",
      "### Environment",
      report.environment,
      "",
      `Reported through PackServer: ${reportUrl}`,
    ].join("\n");
  const build = (repro: string) => {
    const query = new URLSearchParams({ title: report.title, body: body(repro) });
    return `https://github.com/${repository}/issues/new?${query.toString().replaceAll("+", "%20")}`;
  };
  let repro = report.repro;
  let url = build(repro);
  while (url.length > MAX_URL_LENGTH && repro.length > 0) {
    repro = `${repro.slice(0, Math.max(0, Math.floor(repro.length * 0.8) - 1))}…`;
    url = build(repro);
  }
  return url;
}

/** Reads a GitHub issue address the reporter pasted; any other host or shape is not an issue. */
export function parseIssueUrl(value: string): { repository: string; number: number; url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]{0,9})\/?$/.exec(parsed.pathname);
  if (!match) return null;
  const repository = `${match[1]}/${match[2]}`;
  const number = Number(match[3]);
  return { repository, number, url: `https://github.com/${repository}/issues/${number}` };
}
