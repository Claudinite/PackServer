import { HoverCard } from "./hover";

export interface ManifestCounts {
  guards: number;
  tasks: number;
  checks: number;
  skills: number;
  githubActions: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface LineProps {
  counts: ManifestCounts;
  /** The version that widened what adopting does; shown in the warn tone. */
  newIn?: string;
  drawerId?: string;
}

/** The line's text and optional drawer link, as phrasing content so it fits inside a paragraph or a hover label. */
function ManifestText(props: LineProps) {
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
  return props.drawerId ? <a href={`#${props.drawerId}`}>{line}</a> : line;
}

/** The pre-install manifest line: secondary type, never a heading. */
export function ManifestLine(props: LineProps) {
  return (
    <p class="manifest">
      <ManifestText {...props} />
    </p>
  );
}

/** The same line with each count itemised in a hover, for places shown without the drawer. */
export function ManifestHover(props: LineProps) {
  const c = props.counts;
  return (
    <p class="manifest">
      <HoverCard label={<ManifestText {...props} />} focusable={!props.drawerId}>
        <ul>
          <li>{plural(c.guards, "guard")}</li>
          <li>{plural(c.tasks, "scheduled task")}</li>
          <li>{plural(c.checks, "check")}</li>
          <li>{plural(c.skills, "skill")}</li>
        </ul>
      </HoverCard>
    </p>
  );
}
