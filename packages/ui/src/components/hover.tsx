import type { Child } from "hono/jsx";

/** Hover tells: a tooltip-sized breakdown, no actions. Opens on hover and keyboard focus. */
export function HoverCard(props: { label: Child; children: Child; align?: "left" | "right" }) {
  return (
    <span class="hc">
      <span class="trigger" tabindex={0}>{props.label}</span>
      <span class={props.align === "right" ? "pop right" : "pop"} role="tooltip">{props.children}</span>
    </span>
  );
}

/** Click opens: a right-hand drawer addressed by `#id`, so it needs no script. Open it with `<a href="#id">`. */
export function Drawer(props: { id: string; title: string; children: Child }) {
  return (
    <aside class="drawer" id={props.id} aria-label={props.title}>
      <a class="close" href="#" aria-label="Close">✕</a>
      <h2>{props.title}</h2>
      {props.children}
    </aside>
  );
}
