# Design principles

The site shows the verdict and keeps the evidence one gesture away. The visual direction was
settled in PR #4 (`design-direction.md` v2 and the `wireframes-v2.html` prototype); this page keeps
what is still true after the decisions of 2026-10-22. The prototype's stale labels ("Signed
(Sigstore)", "6/6 tests", GitHub orgs on Team allowlists) are not carried.

## Rules

1. **Verdict first, evidence second.** Every object (pack, version, publisher, review, validation
   run) has one bottom-line signal; the facts behind it live in the hover and click layers.
2. **Three things per view.** A screen leads with at most three primary elements. On the pack page:
   name and pitch, the publisher mark with its verification source, the pre-install manifest; then
   the adopt block.
3. **Colour means something or is absent.** One accent for interactive elements, a three-step
   semantic scale used only inside the trust and status marks and the severity glyph. No coloured
   pills, boxes or tinted panels; about 95% of pixels neutral.
4. **One alert per screen, only if the viewer must act.** Informational events go to a plain
   activity list.
5. **Card budget:** name, publisher mark with its source, one line of pitch, shape glyph, score,
   rating number, "No public source" when it applies. Nothing else.
6. **Hover tells, click opens.** Hover is a tooltip-sized breakdown of at most five lines with no
   actions; click is a drawer with the full record and actions. Never a navigation just to see a
   breakdown.
7. **Structure felt, not seen.** Spacing and one hairline weight; no nested boxes, no caps labels.
8. **Glanceable, then data-dense.** A number comes with a word-sized graphic (sparkline, segment
   bar, distribution strip), not a second number.

## Bottom-line signals

| Signal | Encodes | Default | Hover | Click |
|---|---|---|---|---|
| Publisher mark | Who stands behind it and by what proof | `●` Verified publisher · google.com, or `○` Not verified; the source is always shown | Proofs (DNS, GitHub org), pack count | Publisher page |
| Pre-install manifest line | What adopting does to a repo, derived by validation | One line of secondary type under the mark: `Adds 1 guard · 4 scheduled tasks · 3 checks · 6 skills · GitHub actions ›`; a version that widened ends with `· new in 1.61021.1` in the warn tone | — | Drawer with every guard and the tool calls it judges, tasks and cadence, forced skills, actions, `minEngineVersion`, `requires`, and what the widening added |
| Pack score | 0–100 ring | Number with the single largest improvement | Five parts | Breakdown with rule, file, fix; the cap reason when capped |
| Shape glyph | Mix of rules, skills, checks, guards, tasks | 48×8 px segmented bar plus the inventory line | Counts per part | Contents tab |
| Rating | Mean and count | `4.6 · 212`; `—` under 5 ratings | Distribution strip | Reviews tab |
| Pulse | 30-day fetches by member repositories | 64×14 px sparkline beside "fetched by 9.3k repos" and "declared in 1,240 public repos" | Total and delta | — |
| Status (publisher only) | Does this pack need me? | Live (plain), Working (spinner), Needs you (amber dot); private is a lock glyph, draft sorts last | One line, e.g. `1.61020.1 awaiting approval · waiting for an owner` | Action sheet: approve with passkey, report, retry, delete draft |
| Needs-you queue | Everything blocked on the publisher | Heading with count and rows with one action each; "Nothing needs you" when empty | — | — |
| Severity | Worst open report | `▲` filled high, outline medium, none low | Counts | Issues tab |
| Trust drawer | The evidence | Opened from the publisher mark or the status chip | — | Validation report, upload and canonical SHA-256, attestation and key id, repository, proofs and dates, "what this does not prove" |

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

A person is signed in; a member is a repository. "Adopt", "declare", "vendor"; never "install".
The adopt block reads `cn adopt @scope/name` and the `packs.declared` entry with an optional
`version:` freeze, under the line "Lands as a pull request; updates arrive the same way." Validation
findings are sentences with file and line; the verdict is one sentence and "Show report" opens the
list.
