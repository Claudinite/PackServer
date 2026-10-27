import type { VersionStatus, VersionsDocument } from "@packserver/schema";
import { Drawer, FileText, HoverCard, ManifestLine, PublisherMark, Readme, ScoreRing, ShapeGlyph, type PublisherProof } from "@packserver/ui";
import { ADOPTION_LABEL } from "@packserver/core/github";
import { loadRules } from "@packserver/rules";
import type { VersionView } from "@packserver/core/catalog";
import { CONTENT_PARTS, type PackContents } from "../../routes/packs/contents";
import type { PackData } from "./data";
import { fetchesLine, titleCase } from "../browse/format";
import { dayOf, plural, points } from "./figures";
import { SectionComments } from "./comments";
import { fileAnchor, sectionsOf } from "./sections";

export const TRUST_ID = "trust";

const STATUS_WORD: Record<VersionStatus, string> = {
  active: "Active",
  deprecated: "Deprecated",
  yanked: "Yanked",
  quarantined: "Quarantined",
  revoked: "Revoked",
  removed: "Removed",
};

export const statusWord = (status: VersionStatus): string => STATUS_WORD[status];

export interface Lead {
  tone: "fail" | "warn";
  text: string;
  /** Where an advisory naming the held version is read. */
  advisory?: { href: string };
}

/** The one line that leads when the newest version is revoked or quarantined, or the pack is reported. */
export function leadOf(data: PackData): Lead | null {
  const newest = data.listing.versions.find((v) => v.status !== "removed");
  if (newest && (newest.status === "revoked" || newest.status === "quarantined")) {
    const advisory = data.advisories.find((a) => a.affected_versions.includes(newest.version));
    const what = newest.status === "revoked" ? "Revoked" : "Quarantined";
    const why = newest.reason !== undefined && newest.reason !== newest.status ? `: ${newest.reason}` : ` ${newest.version}`;
    return {
      tone: newest.status === "revoked" ? "fail" : "warn",
      text: `${what}${why}`,
      ...(advisory ? { advisory: { href: `/packs/${data.name}/versions#advisory-${advisory.id}` } } : {}),
    };
  }
  if (newest && data.listing.latest_eligible === null) {
    const reasons = [...new Set(data.listing.versions.flatMap((v) => (v.status !== "removed" && v.reason !== undefined ? [v.reason] : [])))];
    return { tone: "warn", text: reasons.length > 0 ? `Unavailable. No available versions: ${reasons.join("; ")}` : "Unavailable. No available versions" };
  }
  if (data.reported === true) return { tone: "warn", text: "Reported, under review" };
  return null;
}

export function StatusLine(props: { lead: Lead }) {
  return (
    <p class={props.lead.tone === "fail" ? "status-line fail" : "status-line"} role="status">
      {props.lead.text}
      {props.lead.advisory ? <a href={props.lead.advisory.href}>Advisory ›</a> : null}
    </p>
  );
}

function Lock() {
  return (
    <svg class="lock" viewBox="0 0 12 12" role="img" aria-label="Private">
      <rect x="2" y="5" width="8" height="6" rx="1" fill="currentColor" />
      <path d="M4 5V3.5a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" stroke-width="1.2" />
    </svg>
  );
}

export function proofsOf(data: PackData): PublisherProof[] {
  return [
    ...(data.profile.verified_domain ? [{ kind: "domain" as const, label: data.profile.verified_domain }] : []),
    ...(data.profile.verified_github_org ? [{ kind: "github" as const, label: `github.com/${data.profile.verified_github_org}` }] : []),
  ];
}

const TABS = [
  { key: "overview", label: "Overview", path: "" },
  { key: "contents", label: "Contents", path: "/contents" },
  { key: "versions", label: "Versions", path: "/versions" },
  { key: "reviews", label: "Reviews", path: "/reviews" },
] as const;
export type Tab = (typeof TABS)[number]["key"];

export function Tabs(props: { name: string; current: Tab; version?: string | undefined }) {
  const query = props.version === undefined ? "" : `?version=${encodeURIComponent(props.version)}`;
  return (
    <nav class="tabs" aria-label="Pack sections">
      {TABS.map((t) => <a href={`/packs/${props.name}${t.path}${t.key === "versions" ? "" : query}`} aria-current={t.key === props.current ? "page" : undefined}>{t.label}</a>)}
    </nav>
  );
}

/** Name and pitch, the publisher's mark, and the status line when one applies. */
export function Head(props: { data: PackData }) {
  const { data } = props;
  const proofs = proofsOf(data);
  const lead = leadOf(data);
  return (
    <>
      {lead ? <StatusLine lead={lead} /> : null}
      <div class="pk-head">
        <h1 class="mono">{data.name}</h1>
        {data.visibility === "private" ? <Lock /> : null}
        <a href={`#${TRUST_ID}`} class="plain"><PublisherMark proof={proofs[0]} proofs={proofs} verifiedPublisher={data.profile.verified_publisher} /></a>
      </div>
      <p class="pk-pitch">{data.pitch}</p>
    </>
  );
}

/** The single lost-point rule that would raise the score most, in the rule's own words. */
export function improvementOf(version: VersionView): string | undefined {
  let best: { rule: string; lost: number } | undefined;
  for (const part of version.score.parts) {
    for (const r of part.rules) {
      const lost = r.max - r.points;
      if (lost > 0 && (best === undefined || lost > best.lost)) best = { rule: r.rule, lost };
    }
  }
  if (!best) return undefined;
  let fix: string | undefined;
  try {
    fix = loadRules(version.rules_version).score.rules.find((r) => r.id === best.rule)?.fix;
  } catch {
    // Rules this registry no longer ships: the rule id stands in for its fix.
  }
  return `+${points(best.lost)} ${fix?.split(", ")[0]?.replace(/\.$/, "") ?? best.rule}`;
}

const SHAPE_PARTS = ["rules", "skills", "checks", "guards", "tasks"] as const;

/** The inventory by part, nonzero parts only: `2 skills · 1 guard`. */
export function contentsSummary(version: VersionView): string {
  const nouns: Record<string, [string, string]> = {
    skills: ["skill", "skills"],
    rules: ["rules file", "rules files"],
    checks: ["check", "checks"],
    guards: ["guard", "guards"],
    tasks: ["task", "tasks"],
    "env-setup": ["env setup", "env setups"],
    "forced-skills": ["forced skill", "forced skills"],
    "github-actions": ["GitHub action", "GitHub actions"],
  };
  const parts = Object.entries(version.inventory)
    .filter(([, v]) => v.count > 0)
    .map(([k, v]) => plural(v.count, nouns[k]?.[0] ?? k, nouns[k]?.[1] ?? `${k}s`));
  return parts.length === 0 ? "Nothing yet" : parts.join(" · ");
}

export function Glance(props: { data: PackData; version: VersionView }) {
  const { data, version } = props;
  const s = data.signals;
  const counts = Object.fromEntries(SHAPE_PARTS.map((p) => [p, version.inventory[p].count])) as Record<(typeof SHAPE_PARTS)[number], number>;
  const improvement = improvementOf(version);
  return (
    <div class="pk-glance">
      <ScoreRing
        score={version.score.total}
        {...(improvement ? { improvement } : {})}
        parts={version.score.parts.map((p) => ({ name: titleCase(p.part), score: p.points, max: p.weight }))}
        {...(version.score.cap ? { capReason: version.score.cap.reason } : {})}
      />
      <ShapeGlyph counts={counts} />
      {s.rating === null ? <span class="rating muted">—</span> : <span class="rating" title="Rating"><b>{s.rating.toFixed(1)}</b> <span class="muted">{s.ratingCount === null ? "rating" : `(${s.ratingCount}) rating`}</span></span>}
      <a class="plain" href={`/packs/${data.name}/star`} rel="nofollow">Star</a>
      {s.fetches30d === null ? null : (
        <HoverCard label={<span class="pulse">{fetchesLine(s.fetches30d)}</span>}>
          <ul>
            {s.fetches7d === null ? null : <li>{fetchesLine(s.fetches7d).replace("in 30 days", "in 7 days")}</li>}
            {s.stars === null ? null : <li class="muted">{plural(s.stars, "star")}</li>}
          </ul>
        </HoverCard>
      )}
      {data.repository === null ? <span class="muted">No public repo</span> : <a href={`https://${data.repository}`} rel="nofollow ugc">{data.repository}</a>}
    </div>
  );
}

/** The adopt command and the `packs.declared` entry; until the flag names an engine, only the Preview line. */
export function Adopt(props: { data: PackData; version: VersionView | null }) {
  const { data, version } = props;
  if (data.adoptVersion === null) {
    const engine = version?.min_engine_version ?? "the engine release that ships adoption";
    return <div class="adopt"><p class="preview">Preview: adoptable with cn ≥ {engine}</p></div>;
  }
  return (
    <div class="adopt">
      <pre><code>cn adopt {data.name}</code></pre>
      <pre><code>packs.declared: ["{data.name}"]</code></pre>
    </div>
  );
}

export function manifestCounts(version: VersionView) {
  const p = version.preinstall;
  return {
    guards: p.guards.length,
    tasks: p.tasks.length,
    skills: p.forced_skills.length,
    checks: version.capabilities.includes("coded-check") ? version.inventory.checks.count : 0,
    githubActions: p.github_actions.length > 0,
  };
}

export function Manifest(props: { version: VersionView }) {
  const { version } = props;
  return <ManifestLine counts={manifestCounts(version)} drawerId={TRUST_ID} {...(version.preinstall.new.length > 0 ? { newIn: version.version } : {})} />;
}

/** Newest version, status, contents and hashes: present on the page, folded until asked for. */
export function Facts(props: { data: PackData; version: VersionView }) {
  const { data, version } = props;
  return (
    <details class="facts">
      <summary>Details</summary>
      <dl>
        <dt>Newest version</dt>
        <dd>{version.version} · published <time datetime={version.published_at ?? undefined} title={version.published_at ?? undefined}>{dayOf(version.published_at)}</time></dd>
        <dt>Status</dt>
        <dd>{statusWord(version.status)}</dd>
        <dt>Score</dt>
        <dd>{version.score.total} of 100</dd>
        {data.declaringRepositories === null ? null : (
          <>
            <dt>Declared by</dt>
            <dd>{plural(data.declaringRepositories, "repository", "repositories")} ({ADOPTION_LABEL})</dd>
          </>
        )}
        <dt>Contents</dt>
        <dd>{contentsSummary(version)}</dd>
        <dt>Hash</dt>
        <dd class="hash">{version.hashes.canonical_sha256}</dd>
      </dl>
    </details>
  );
}

function warningLine(data: PackData): string {
  if (data.report.kind === "unavailable") return "Warnings are unavailable right now";
  const entries = Object.entries(data.report.warnings);
  return entries.length === 0 ? "No warnings" : entries.map(([category, n]) => `${titleCase(category)} ${n}`).join(" · ");
}

export function TrustDrawer(props: { data: PackData; version: VersionView | null }) {
  const { data, version } = props;
  if (!version) {
    return <Drawer id={TRUST_ID} title="Trust"><p class="muted">No version can be shown for this pack.</p></Drawer>;
  }
  const v = version.verification;
  const prov = version.provenance;
  return (
    <Drawer id={TRUST_ID} title="Trust">
      <h3>Publisher</h3>
      <ul>
        {v.verified_domain ? <li>Domain proven: {v.verified_domain}</li> : null}
        {v.verified_github_org ? <li>GitHub organisation proven: github.com/{v.verified_github_org}</li> : null}
        {!v.verified_domain && !v.verified_github_org ? <li>No domain or GitHub organisation proven</li> : null}
      </ul>
      <h3>Source</h3>
      {prov.source === "oidc" ? (
        <ul>
          <li>Repository {prov.repository}, commit <span class="hash">{prov.commit}</span></li>
          <li>Published with trusted publishing</li>
          <li>{v.source_verified ? "The source tree was verified against the archive" : "The source tree was not verified"}</li>
        </ul>
      ) : (
        <ul><li>Published by upload; no source was verified</li></ul>
      )}
      <h3>Hashes</h3>
      <ul>
        <li>Canonical <span class="hash">{version.hashes.canonical_sha256}</span></li>
        <li>Upload {version.hashes.upload_sha256 === null ? "unknown" : <span class="hash">{version.hashes.upload_sha256}</span>}</li>
      </ul>
      <h3>Attestation</h3>
      <ul>
        <li>{version.urls ? <a href={version.urls.attestation}>Attestation</a> : "Attestation not served for this status"}</li>
        <li>Signing key {data.kid ?? "unavailable"}</li>
      </ul>
      <h3>Validation</h3>
      <ul>
        <li>Validated {dayOf(version.validated_at)}, rules <a href="/rules">{version.rules_version}</a></li>
        <li>{warningLine(data)}</li>
        {data.changedDomains.map((domain) => <li>A linked domain now resolves differently: {domain}</li>)}
        {data.report.kind === "found" && data.report.runId !== null ? <li><a href={`/validation/${data.report.runId}`}>Full report</a></li> : null}
      </ul>
      <h3>What adopting adds</h3>
      <ul>
        {version.preinstall.new.length === 0 ? <li>Nothing new in this version</li> : version.preinstall.new.map((entry) => <li>New: {entry}</li>)}
      </ul>
    </Drawer>
  );
}

export function ContentsView(props: { contents: PackContents; counts?: Record<string, number> }) {
  const { contents } = props;
  return (
    <>
      {CONTENT_PARTS.map((part) => {
        const files = contents.files.filter((f) => f.part === part);
        if (files.length === 0) return null;
        return (
          <section class="part">
            <h2>{part}</h2>
            {files.map((f) => (
              <div class="file" id={fileAnchor(f.path)}>
                <h3>{f.path}</h3>
                {sectionsOf(f.path, f.text).map((s) => (
                  <div class="sec" id={s.id} data-section={s.id}>
                    <FileText path={f.path} text={s.text} />
                    {props.counts ? <SectionComments pack={contents.pack} version={contents.version} section={s.id} count={props.counts[s.id] ?? 0} /> : null}
                  </div>
                ))}
              </div>
            ))}
          </section>
        );
      })}
      {contents.files.length === 0 ? <p class="muted">This version has no files.</p> : null}
    </>
  );
}

export function ReadmeView(props: { markdown: string | null | undefined }) {
  if (props.markdown === undefined) return <p class="pk-note">The README could not be loaded. Reload to try again.</p>;
  if (props.markdown === null) return <p class="pk-note muted">This pack has no README.</p>;
  return <Readme markdown={props.markdown} />;
}

export function VersionsView(props: { data: PackData; history: VersionsDocument; origin: string }) {
  const { data, history } = props;
  const records = new Map(history.versions.map((v) => [v.version, v]));
  return (
    <>
      <div class="vers-scroll">
        <table class="vers">
          <thead>
            <tr><th>Version</th><th>Published</th><th>Status</th><th>Score</th><th>Engine</th><th>Source</th><th>Hash</th><th /></tr>
          </thead>
          <tbody>
            {data.listing.versions.map((v) => {
              const record = records.get(v.version);
              const extra = data.versionExtras.get(v.version);
              const widening = record?.preinstall.new ?? [];
              const held = v.status === "revoked" || v.status === "quarantined";
              return (
                <tr>
                  <td><a href={`/packs/${data.name}?version=${encodeURIComponent(v.version)}`}>{v.version}</a></td>
                  <td><time datetime={v.published_at ?? undefined} title={v.published_at ?? undefined}>{dayOf(v.published_at)}</time></td>
                  <td class={held ? "held" : undefined}>
                    {v.reason !== undefined && v.status !== "active" ? <HoverCard label={statusWord(v.status)}>{v.reason}</HoverCard> : statusWord(v.status)}
                    {widening.length > 0 ? (
                      <>
                        {" "}
                        <HoverCard label={<span class="wide">widens</span>}>
                          <ul>{widening.map((entry) => <li>New: {entry}</li>)}</ul>
                        </HoverCard>
                      </>
                    ) : null}
                  </td>
                  <td>{extra?.score ?? "—"}</td>
                  <td class="mono">{record?.min_engine_version ?? "—"}{record && record.requires.length > 0 ? ` · ${record.requires.join(", ")}` : ""}</td>
                  <td>{record ? (record.source_verified ? "Verified" : "Not verified") : "—"}</td>
                  <td class="hash" title={v.sha256}>{v.sha256 === undefined ? "—" : v.sha256.slice(0, 12)}</td>
                  <td>
                    {v.status === "active" || v.status === "deprecated" || v.status === "yanked" ? <a href={`${props.origin}/${data.name}/${v.version}/.attestation.json`}>Attestation</a> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.advisories.length > 0 ? (
        <section class="part">
          <h2>Advisories</h2>
          {data.advisories.map((a) => (
            <p id={`advisory-${a.id}`} class="file">
              {titleCase(a.severity)}: {a.summary} <span class="muted">Affects {a.affected_versions.join(", ")}{a.fixed_in ? `, fixed in ${a.fixed_in}` : ""}</span>
            </p>
          ))}
        </section>
      ) : null}
    </>
  );
}
