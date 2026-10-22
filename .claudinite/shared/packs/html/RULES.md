# HTML

- **Injected block markup inside a `<p>` silently empties it — read the sibling, not the tag.**
  A block element (a `<div>`, etc.) inside a `<p>` is disallowed by the HTML content model, so
  wherever the two are parsed **together** — document parsing, `DOMParser`, or `innerHTML` on an
  *ancestor* — the parser (browser or jsdom, same rule) auto-closes the `<p>` right before the
  block, which lands as the `<p>`'s **next sibling** and leaves the tag empty when nothing else
  was in it. Read `element.nextElementSibling`. Writing *into* an already-parsed `<p>`
  (`p.innerHTML`, `p.insertAdjacentHTML`) is the exception — it is the fragment's context
  element, never in button scope, so the block stays nested instead. (injected-block-markup)

- **An ambiguous numeric slash date can't be resolved from its digits — infer the document's
  convention once, don't guess per-field.** When both parts are ≤ 12 (e.g. `05/07/2026`), resolve
  the order once per document — never per source or per field — in this order. (1) **An
  unambiguous sibling date fixes the page's convention**: a slash date elsewhere on the same page
  with a part > 12 (e.g. `24/07/2026`) parses only one way, and a page is almost always internally
  consistent — read that date's order and apply it to every other slash date on the page. (2)
  Failing that, **read the declared locale** (`<html lang>`, `og:locale`): default **month-first**
  (the order `Date` and most JS parsers assume) and flip to day-first only on a *positive* non-US
  signal — a non-US region in `lang` / `og:locale`, or a non-English language; a bare `en` with
  unknown region stays month-first. The `.` / `-` separators are day-first regardless.
  (ambiguous-numeric-slash)

- **When code must react to how a real page actually behaves, investigate it live before you ship
  — don't deploy a hypothesis you can only test after release.** If a change hinges on the real
  DOM, computed styles, or runtime state of a page you can't see, hand the user one JavaScript
  snippet to run in the browser DevTools console and read its output back. Reserve "test it after
  it's deployed" for behavior you've verified genuinely can't be observed now. (code-must-react)

- **Make that console request a snippet, not an essay.** Send exactly one code block to paste into
  the console and ask the user to paste its output back. Skip the prose explaining what you're
  hoping to learn. (make-console-request)
