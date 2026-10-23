import { HoverCard } from "./hover";

export interface ManifestCounts {
  guards: number;
  tasks: number;
  checks: number;
  skills: number;
  githubActions: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The pre-install manifest line: secondary type, never a heading. `newIn` marks a version that widened. */
export function ManifestLine(props: { counts: ManifestCounts; newIn?: string; drawerId?: string }) {
  const c = props.counts;
  const parts = [
    c.guards > 0 ? plural(c.guards, "guard") : null,
    c.tasks > 0 ? plural(c.tasks, "scheduled task") : null,
    c.checks > 0 ? plural(c.checks, "check") : null,
    c.skills > 0 ? plural(c.skills, "skill") : null,
    c.githubActions ? "GitHub actions" : null,
  ].filter((p): p is string => p !== null);
  const body = parts.length === 0 ? "Adds nothing to a repo" : `Adds ${parts.join(" · ")}`;
  const line = (
    <>
      <span class="lead">{body}</span>
      {props.newIn ? <span class="flag"> · new in {props.newIn}</span> : null}
      {props.drawerId ? " ›" : null}
    </>
  );
  return (
    <p class="manifest">
      {props.drawerId ? <a href={`#${props.drawerId}`}>{line}</a> : line}
    </p>
  );
}

/** Hover variant listing what each count is, for places the line is shown without its drawer. */
export function ManifestHover(props: { counts: ManifestCounts; newIn?: string }) {
  return (
    <HoverCard label={<ManifestLine counts={props.counts} newIn={props.newIn} />}>
      <ul>
        <li>{plural(props.counts.guards, "guard")}</li>
        <li>{plural(props.counts.tasks, "scheduled task")}</li>
        <li>{plural(props.counts.checks, "check")}</li>
        <li>{plural(props.counts.skills, "skill")}</li>
      </ul>
    </HoverCard>
  );
}
