import { HoverCard } from "./hover";

export interface ShapeCounts {
  rules: number;
  skills: number;
  checks: number;
  guards: number;
  tasks: number;
}

const PARTS: readonly [keyof ShapeCounts, string][] = [
  ["rules", "rule"],
  ["skills", "skill"],
  ["checks", "check"],
  ["guards", "guard"],
  ["tasks", "task"],
];

const WIDTH = 48;
const GAP = 1;

const noun = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Segment widths in px: each part's width follows its count, none under 2 px. */
export function segmentWidths(counts: readonly number[]): number[] {
  const parts = counts.filter((n) => n > 0);
  const room = WIDTH - GAP * Math.max(0, parts.length - 1);
  const total = parts.reduce((a, b) => a + b, 0);
  return parts.map((n) => Math.max(2, (n / total) * room));
}

/** A 48 by 8 px segmented bar; the inventory is the hover. */
export function ShapeGlyph(props: { counts: ShapeCounts }) {
  const present = PARTS.filter(([k]) => props.counts[k] > 0);
  const widths = segmentWidths(present.map(([k]) => props.counts[k]));
  let x = 0;
  const label = present.map(([k, w]) => noun(props.counts[k], w)).join(", ") || "empty";
  return (
    <HoverCard
      label={
        <svg class="shape" viewBox={`0 0 ${WIDTH} 8`} role="img" aria-label={label}>
          {present.map((_, i) => {
            const w = widths[i] ?? 0;
            const rect = <rect class={i % 2 ? "dim" : ""} x={x.toFixed(2)} y="0" width={w.toFixed(2)} height="8" rx="1" />;
            x += w + GAP;
            return rect;
          })}
        </svg>
      }
    >
      <ul>{present.length === 0 ? <li>Nothing yet</li> : present.map(([k, w]) => <li>{noun(props.counts[k], w)}</li>)}</ul>
    </HoverCard>
  );
}
