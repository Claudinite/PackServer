import { PACK_CODE_JOB } from "@packserver/core/publishing";

/** The job that holds `id-token: write`; the registry reads its name from `$GITHUB_JOB` (REQ-PUB-003). */
export const OIDC_JOB = "publish";
export const ACTION_REPOSITORY = "claudinite/publish-pack";

// Third-party actions the template uses, pinned by commit SHA.
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";

export interface TemplateInput {
  /** `@scope/name`. */
  pack: string;
  /** The pack's directory in the repository. */
  path: string;
  /** The publish-pack release, as the full commit SHA of its tag. */
  actionSha: string;
  cnVersion: string;
  cnSha256: string;
  /** The GitHub environment named in the trusted-publisher registration, when it has one. */
  environment?: string;
  /** The pack's tests, run in the job that has no token; the publish job waits for it. */
  testCommand?: string;
}

const PACK = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/;
const PATH = /^[A-Za-z0-9._/-]+$/;
const ENVIRONMENT = /^[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function require(ok: boolean, what: string): void {
  if (!ok) throw new Error(`template input ${what} is not valid`);
}

const q = (value: string) => JSON.stringify(value);

/** The workflow the dashboard hands a publisher; every interpolated value is validated and quoted because the result is pasted into a repository. */
export function publishWorkflowTemplate(input: TemplateInput): string {
  require(PACK.test(input.pack), "pack");
  require(PATH.test(input.path) && !input.path.startsWith("/") && !input.path.split("/").includes(".."), "path (relative, inside the repository)");
  require(/^[0-9a-f]{40}$/.test(input.actionSha), "actionSha (a full commit SHA)");
  require(VERSION.test(input.cnVersion), "cnVersion");
  require(/^[0-9a-f]{64}$/.test(input.cnSha256), "cnSha256");
  require(input.environment === undefined || ENVIRONMENT.test(input.environment), "environment");
  require(input.testCommand === undefined || (!/[\r\n]/.test(input.testCommand) && !input.testCommand.includes("${{")), "testCommand (one line, no expressions)");

  const name = input.pack.split("/")[1]!;
  const test = input.testCommand ? `      - name: Test\n        run: ${q(input.testCommand)}\n` : "";
  const environment = input.environment ? `    environment: ${q(input.environment)}\n` : "";
  return `# Publishes ${input.pack} to the Claudinite registry when a tag ${name}/<version> is pushed.
# The "${PACK_CODE_JOB}" job runs your pack's own tests with no token and no secrets available. The "${OIDC_JOB}"
# job holds the OIDC permission, runs none of your code, and starts only when "${PACK_CODE_JOB}" passed; the
# registry refuses a token from the "${PACK_CODE_JOB}" job.
name: ${q(`Publish ${name}`)}

on:
  push:
    tags:
      - ${q(`${name}/*`)}

permissions: {}

jobs:
  ${PACK_CODE_JOB}:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: none
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
${test}
  ${OIDC_JOB}:
    needs: ${PACK_CODE_JOB}
    runs-on: ubuntu-24.04
${environment}    permissions:
      contents: read
      id-token: write
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - name: Read the version from the tag
        id: version
        env:
          TAG: \${{ github.ref_name }}
        run: echo "value=\${TAG#${name}/}" >> "$GITHUB_OUTPUT"
      - uses: ${ACTION_REPOSITORY}@${input.actionSha}
        with:
          pack: ${q(input.pack)}
          version: \${{ steps.version.outputs.value }}
          path: ${q(input.path)}
          cn-version: ${q(input.cnVersion)}
          cn-sha256: ${q(input.cnSha256)}
`;
}
