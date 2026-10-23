import type { Child } from "hono/jsx";

let nextId = 0;

/** Script for the one thing CSS cannot do: Escape dismisses an open hover card until the pointer or focus moves (WCAG 1.4.13). */
export const HOVER_DISMISS_SCRIPT =
  `document.addEventListener("keydown",function(e){if(e.key==="Escape")document.documentElement.classList.add("esc")});` +
  `["mousemove","focusin"].forEach(function(t){document.addEventListener(t,function(){document.documentElement.classList.remove("esc")})});`;

/**
 * Hover tells: a tooltip-sized breakdown, no actions. Opens on hover and keyboard focus.
 * The popup is block-level content (lists): never place a HoverCard inside a `<p>`, whose parser closes it before the list. Use a `div`.
 * A label that already holds a link or button passes `focusable={false}` so it is one tab stop, not two.
 */
export function HoverCard(props: { label: Child; children: Child; align?: "left" | "right"; focusable?: boolean }) {
  const id = `hc-${++nextId}`;
  const focusable = props.focusable !== false;
  return (
    <span class="hc">
      <span class="trigger" tabindex={focusable ? 0 : undefined} aria-describedby={focusable ? id : undefined}>{props.label}</span>
      <span class={props.align === "right" ? "pop right" : "pop"} role="tooltip" id={id}>{props.children}</span>
    </span>
  );
}

/** Click opens: a right-hand drawer addressed by `#id`, so it needs no script. Open it with `<a href="#id">`. */
export function Drawer(props: { id: string; title: string; children: Child }) {
  return (
    <aside class="drawer" id={props.id} aria-label={props.title}>
      {/* A fragment with no matching element clears :target without scrolling, unlike "#". */}
      <a class="close" href="#_" aria-label="Close">✕</a>
      <h2>{props.title}</h2>
      {props.children}
    </aside>
  );
}
