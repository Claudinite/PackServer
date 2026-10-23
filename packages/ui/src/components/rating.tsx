import { HoverCard } from "./hover";

/** Fewer than this many ratings show a dash instead of a mean. */
export const MIN_RATINGS = 5;

/** `4.6 · 212`; `—` under 5 ratings. `distribution[0]` counts one-star ratings. */
export function Rating(props: { mean: number; count: number; distribution?: readonly [number, number, number, number, number] }) {
  if (props.count < MIN_RATINGS) return <span class="rating muted">—</span>;
  const dist = props.distribution;
  const peak = dist ? Math.max(1, ...dist) : 1;
  const label = (
    <span class="rating">
      <b>{props.mean.toFixed(1)}</b> <span class="n">· {props.count}</span>
    </span>
  );
  if (!dist) return label;
  return (
    <HoverCard label={label}>
      <div class="dist">
        {[5, 4, 3, 2, 1].flatMap((stars) => [
          <span>{stars}</span>,
          <svg viewBox="0 0 100 6" aria-hidden="true">
            <rect class="back" width="100" height="6" rx="2" />
            <rect class="fill" width={Math.round(((dist[stars - 1] ?? 0) / peak) * 100)} height="6" rx="2" />
          </svg>,
          <span class="muted">{dist[stars - 1] ?? 0}</span>,
        ])}
      </div>
    </HoverCard>
  );
}
