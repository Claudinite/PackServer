# Design principles

The site shows the verdict and keeps the evidence one gesture away. The visual direction was
settled in PR #4 (`design-direction.md` v2 and the `wireframes-v2.html` prototype); this page keeps
what is still true after the decisions of 2026-10-22. The prototype's stale labels ("Signed
(Sigstore)", "6/6 tests") are not carried.

## Rules

1. **Verdict first, evidence second.** Every object (pack, version, publisher, review, validation
   run) has one bottom-line signal; the facts behind it live in the hover and click layers.
2. **Four things per view, the rest one gesture away.** On the pack page: name and pitch, the
   publisher mark with its proof, the pre-install manifest line, the adopt block (REQ-SEARCH-014).
   Everything else is a hover, a drawer or a tab.
3. **Colour means something or is absent.** One accent for interactive elements, a three-step
   semantic scale used only inside the trust and status marks and the severity glyph. No coloured
   pills, boxes or tinted panels; about 95% of pixels neutral.
4. **One alert per screen, only if the viewer must act.** Informational events go to a plain
   activity list.
5. **Card budget:** name, publisher mark with its proof, one line of pitch, shape glyph, score,
   rating number, "No public repo" when it applies. Nothing else.
6. **Hover tells, click opens.** Hover is a tooltip-sized breakdown of at most five lines with no
   actions; click is a drawer with the full record and actions. Never a navigation just to see a
   breakdown.
7. **Structure felt, not seen.** Spacing and one hairline weight; no nested boxes, no caps labels.
   The pre-install manifest line is secondary type, never a heading (PD-REV L10).
8. **Glanceable, then precise.** A number comes with a word-sized graphic (sparkline, segment bar,
   distribution strip), not a second number; the exact figure is in the hover (PD-REV L4).
9. **Empty states say what comes next.** A first dashboard shows the New pack action alone; a
   Pulse with no data says "No fetches yet"; a Trending rail is absent until a pack qualifies
   (PD-REV M1).

## Bottom-line signals

| Signal | Encodes | Default | Hover | Click |
|---|---|---|---|---|
| Publisher mark | Who stands behind it and by what proof | `●` acme.com (the proven domain) or `●` github.com/acme (the proven org); `○` Unproven when there is none; the proof itself is always the label (Ariel B4 2026-10-22) | Every proof with its date, "Verified Publisher" when the review passed, pack count | Publisher page |
| Pre-install manifest line | What adopting does to a repo, derived by validation | One line of secondary type under the mark: `Adds 1 guard · 4 scheduled tasks · 3 checks · 6 skills · GitHub actions ›`; a version that widened ends with `· new in 1.61021.1` in the warn tone | — | Drawer with every guard and the tool calls it judges, tasks and cadence, forced skills, actions, `minEngineVersion`, `requires`, and what the widening added |
| Adopt block | How to take it | `cn adopt @scope/name` and the `packs.declared` entry under "Lands as a pull request; updates arrive the same way."; until the engine release in `cn_min_adopt_version` exists, "Preview: adoptable with cn ≥ <version>" and no entry | — | Copy |
| Pack score | 0–100 ring | Number with the single largest improvement | Five parts (Context cost, Skill structure, Checks, Source, Footprint) | Breakdown with rule, file, fix; the cap reason when capped |
| Shape glyph | Mix of rules, skills, checks, guards, tasks | 48×8 px segmented bar plus the inventory line | Counts per part | Contents tab |
| Rating | Mean and count | `4.6 · 212`; `—` under 5 ratings | Distribution strip | Reviews tab |
| Pulse | 30-day fetches by member repositories | 64×14 px sparkline beside "fetched by about 9.3k networks" and "declared in about 1,240 public repos (weekly)" (PD-REV M4) | Total and delta | — |
| Status (publisher only) | Does this pack need me? | Live (plain), Working (spinner), Needs you (amber dot); private is a lock glyph, draft sorts last | One line, e.g. `1.61020.1 awaiting approval · waiting for an owner` | Action sheet: approve with passkey, report, retry, delete draft |
| Needs-you queue | Everything blocked on the publisher | Heading with count and rows with one action each; "Nothing needs you" when empty | — | — |
| Severity | Worst open report | `▲` filled high, outline medium, none low | Counts | Issues tab |
| Status line (when it applies) | A version or pack that must not be adopted blindly | One line above everything: "Revoked: <reason>", "Quarantined: <reason>", "Reported, under review", with the advisory link | — | Advisory |
| Trust drawer | The evidence | Opened from the publisher mark or the status chip | — | Validation report with warnings by category, upload and canonical SHA-256, attestation and key id, repository with "source verified" or not, proofs and dates, "what this does not prove" |

The approval state is called "awaiting approval", never "staged". Versions show `revoked`,
`yanked`, `deprecated` or `quarantined` from the signed index on their own rows; there is no
"latest" label, only the newest eligible version.

## Visual language

Neutral scale on Claudinite's tokens: paper `#faf8f4`, ink `#16180f`, five warm low-chroma greys;
accent malachite `#0e7c52` for interactive elements only; semantic trio for marks only (ok, warn,
fail). One humanist sans with tabular figures (Source Sans 3 or IBM Plex Sans), IBM Plex Mono for
pack ids, commands and hashes; scale 13 / 14 / 16 / 20 / 28; weight does hierarchy. 8-pt grid,
content column 760 px, README 680 px; rows separated by space, hairlines at 8% ink between sections.
Monochrome 28 px pack glyphs on cards; sparklines and segment bars only, single ink, no axes.
Motion 120 ms for hovers, 200 ms drawers, no shimmer; the Working spinner is the only loop. The site
header says "Claudinite Packs" with the Claudinite crystal glyph, and the home page admits "Claude
Code only" plainly.

## Copy

A person is signed in; a member is a repository; the people of an organisation are its owners and
maintainers. "Adopt", "declare", "vendor"; never "install". Prices appear once, struck through with
"free through 2026" beside them (REQ-PAY-017). Validation findings are sentences with file and
line; the verdict is one sentence and "Show report" opens the list. Counts from the weekly scan
and the request logs say "about".
