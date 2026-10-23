import { HoverCard } from "./hover";

export type SeverityLevel = "high" | "medium" | "low";

/** `▲` filled for high, outline for medium, nothing for low or none. */
export function Severity(props: { level: SeverityLevel | null; counts?: { high: number; medium: number; low: number } }) {
  if (props.level === null || props.level === "low") return null;
  const filled = props.level === "high";
  const glyph = (
    <span class="sev">
      <svg viewBox="0 0 14 14" role="img" aria-label={`${props.level} severity`}>
        <path d="M7 2 13 12H1Z" fill={filled ? "var(--fail)" : "none"} stroke="var(--fail)" stroke-width="1.4" stroke-linejoin="round" />
      </svg>
    </span>
  );
  const c = props.counts;
  return c ? <HoverCard label={glyph}>{c.high} high · {c.medium} medium · {c.low} low</HoverCard> : glyph;
}
