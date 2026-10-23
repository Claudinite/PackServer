import { HoverCard } from "./hover";

const W = 64;
const H = 14;

export function sparkPath(series: readonly number[]): string {
  const max = Math.max(...series, 1);
  const step = series.length > 1 ? W / (series.length - 1) : 0;
  return series.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(H - 1 - (v / max) * (H - 2)).toFixed(1)}`).join(" ");
}

/** A 64 by 14 px single-ink sparkline of the last 30 days; no axes. An empty series says so in words. */
export function Pulse(props: { series: readonly number[]; fetchedBy?: string; declaredIn?: string; delta?: string }) {
  const total = props.series.reduce((a, b) => a + b, 0);
  if (props.series.length === 0 || total === 0) return <span class="pulse muted">No fetches yet</span>;
  return (
    <HoverCard
      label={
        <span class="pulse">
          <svg class="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fetches over 30 days">
            <path d={sparkPath(props.series)} fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" />
          </svg>
          {props.fetchedBy ? <span>fetched by {props.fetchedBy}</span> : null}
        </span>
      }
    >
      <ul>
        <li>{total} fetches in 30 days{props.delta ? ` · ${props.delta}` : ""}</li>
        {props.declaredIn ? <li class="muted">declared in {props.declaredIn}</li> : null}
      </ul>
    </HoverCard>
  );
}
