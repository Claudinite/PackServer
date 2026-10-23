import { HoverCard } from "./hover";

export type PackStatus = "live" | "working" | "needs-you";

/** Does this pack need me? Live is plain, Working is the one spinner, Needs you an amber dot. */
export function StatusChip(props: { status: PackStatus; visibility?: "public" | "private"; draft?: boolean; detail?: string; drawerId?: string }) {
  const text = props.draft ? "Draft" : props.status === "live" ? "Live" : props.status === "working" ? "Working" : "Needs you";
  const chip = (
    <span class={props.draft ? "chip draft" : "chip"}>
      {props.status === "working" && !props.draft ? (
        <svg class="spin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2a6 6 0 1 1-6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      ) : null}
      {props.status === "needs-you" && !props.draft ? <span class="dot" aria-hidden="true" /> : null}
      {text}
      {props.visibility === "private" ? (
        <svg class="lock" viewBox="0 0 12 12" role="img" aria-label="Private"><rect x="2" y="5" width="8" height="6" rx="1" fill="currentColor" /><path d="M4 5V3.5a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
      ) : null}
    </span>
  );
  const inner = props.drawerId ? <a href={`#${props.drawerId}`} class="plain">{chip}</a> : chip;
  return props.detail ? <HoverCard label={inner} focusable={!props.drawerId}>{props.detail}</HoverCard> : inner;
}

/** A row of the Needs-you queue: what is blocked and the one action that unblocks it. */
export function NeedsYouRow(props: { what: string; why?: string; action: { label: string; href: string } }) {
  return (
    <li>
      <span class="what">
        {props.what}
        {props.why ? <span class="why"> · {props.why}</span> : null}
      </span>
      <a href={props.action.href}>{props.action.label}</a>
    </li>
  );
}

/** Everything blocked on the publisher; says so plainly when nothing is. */
export function NeedsYouQueue(props: { rows: readonly { what: string; why?: string; action: { label: string; href: string } }[] }) {
  if (props.rows.length === 0) return <p class="muted">Nothing needs you</p>;
  return (
    <section class="needs">
      <h2>Needs you · {props.rows.length}</h2>
      <ul>{props.rows.map((r) => <NeedsYouRow {...r} />)}</ul>
    </section>
  );
}
