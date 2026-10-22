# improve-comments

## Why the declaration reads as it does

Carried over from the declaration's comments when it became `task.json`.

basics task: improve-comments — the one scheduled task whose subject is the repo's
own source. It reads a slice of the code AS COMMENTS and fixes what it finds there.
Worker: task.md, which runs the improve-comments skill and nothing else.

WHY IT IS A TASK AT ALL: a comment decays as the code around it changes and
nothing makes it fail. No test goes red, no check fires, and no session working on
something else will stop to fix one. The only way a repo's comments get read as
comments is a pass whose whole job that is.

WEEKLY. Comment drift is not latency-sensitive — a stale comment costs the next
reader, whenever that is — and the window's commits are what name the files whose
comments are likeliest wrong, so a weekly window is a bigger and better-targeted
scope than a daily one for the same session cost.

Something moved, and some of it in this repo's OWN source. Never gate on the
previous round still being open — the round runs and appends to that PR, which
is what makes one review cover several weeks of comment work.

`.claudinite/shared/` is the vendored mount, not the repo's source: the next
update replaces it whole, so a comment improved there is gone by morning.
`.claudinite/local/` is the repo's own and stays in scope. The same prefix gates
the WRITE in this pack's `improve-comments-scope` check, and the test beside
that check pins the two together — a scope this declaration hands out but the
gate then refuses is the failure the pin exists for.
A ceiling, not a plan: the repo's own delivery setting decides whether the
PR lands unreviewed, and a `review` member still gets it left open. The
policy states in the contract what makes the pass safe to land unattended —
the diff can only ever be comment text and README content — and the pass's
own scope gate (the skill's `improve-comments-scope` check) reds the same
boundary on every branch wearing its title, armed or not.
