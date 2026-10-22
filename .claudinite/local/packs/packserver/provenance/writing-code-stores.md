## 2026-10-22 · born · data a release writes must stay readable by the release before it
- **Source:** Ariel, on automatic rollback at any stage (release plan, PR #8).
- **Reason:** with unattended rollback up to 50%, V1 code reads what V2 wrote; the canon's
  three-merge migration rule covers schema in the deploy window, not data across a rollback.
- **Actor:** @missingbulb (owner).
- **Model:** claude-opus-5-5
- **Mechanism:** prose in RULES.md; whether a shape is readable by the old code has no checkable
  signature yet.
- **Retire when:** rollback stops being automatic, or a check proves N-1 readers accept N's writes.

## 2026-10-22 · reworded · rollback is no longer tied to a staged rollout
- **Reason:** Ariel chose a simple pre-launch release mode with the gradual ladder deferred;
  rollback after any deploy still applies.
- **Actor:** @missingbulb (owner).
