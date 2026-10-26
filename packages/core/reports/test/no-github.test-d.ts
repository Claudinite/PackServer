import type { Mail } from "@packserver/ports";
import type { ReportPorts } from "../ports.ts";

// REQ-MOD-001: nothing is written to GitHub. The ports the reports code receives hold no GitHub client and no
// mail port, so adding a call that writes to either is a type error here, not a review finding.
type Keys = keyof ReportPorts;
const allowed: Record<Keys, true> = { clock: true, rng: true, d1: true, siteOrigin: true };
void allowed;

// @ts-expect-error a GitHub client is not among the reports ports
const github: ReportPorts["github"] = undefined;
// @ts-expect-error a mail port is not among the reports ports
const mail: ReportPorts["mail"] = undefined as unknown as Mail;
void github;
void mail;
