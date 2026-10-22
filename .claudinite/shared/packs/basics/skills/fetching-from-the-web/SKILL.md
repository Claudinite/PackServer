---
name: fetching-from-the-web
description: Reading a page or file from the web: exact bytes over a summary, and what a 403 or egress block means. Use before any WebFetch or curl.
metadata:
  body: guidelines
  usage:
    expect: triggered
  force-load-on-tool-calls:
    - 'WebFetch'
    - 'Bash.command /(^|[;&|]\s*|\n\s*)(curl|wget)\b/'
  force-load-on-tool-results-matching:
    - 'WebFetch /EGRESS_BLOCKED|\b403\b/'
    - 'Bash /EGRESS_BLOCKED|HTTP\/[\d.]+ 403\b|\b403 Forbidden\b|status(?: code)?:? 403\b/'
---

# Fetching from the web

- **Needing exact text** — a summarizing fetch tool is not a source; when the bytes matter, `curl`
  into the scratchpad and read from disk. (needing-exact-text)
- **A `403`** — don't retry and don't try a sibling URL; attribute the search snippet to the
  publisher instead of asserting it, and mark it for re-verification. (a-rule)
- **A sandbox or proxy denial is a policy boundary, not an obstacle to route around** — no
  open-network runner, no ad-hoc CI workflow, no push-triggered probe to make the request from
  somewhere the policy does not apply. Answer from committed reference material or ask the owner,
  and say plainly that anything unverifiable is unverified. (sandbox-proxy-denial)
- **An explicit egress block** (`EGRESS_BLOCKED`) is domain-wide, unlike a publisher's `403`:
  working down alternate sources for the same fact spends the same denial on each. Never file the
  gap as "re-verify next pass" — no later agent pass can cross a policy block either; mark it as
  needing a human or an unblocked environment. (explicit-egress-block)
