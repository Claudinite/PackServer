import { PACK_CODE_JOB } from "@packserver/core/publishing";

/** The job that holds `id-token: write`; the registry reads its name from `$GITHUB_JOB` (REQ-PUB-003). */
export const OIDC_JOB = "publish";
export const ACTION_REPOSITORY = "claudinite/publish-pack";

// Third-party actions the template uses, pinned by commit SHA.
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const UPLOAD = "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2";
const DOWNLOAD = "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2";

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
  /** Pack tasks (build, test) that run in the job without a token. */
  buildCommand?: string;
}

const PACK = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/;
const PATH = /^[A-Za-z0-9._/-]+$/;
const ENVIRONMENT = /^[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function require(ok: boolean, what: string): void {
  if (!ok) throw new Error(`template input ${what} is not valid`);
}

/** The workflow the dashboard hands a publisher; every interpolated value is validated because the result is pasted into a repository. */
export function publishWorkflowTemplate(input: TemplateInput): string {
  require(PACK.test(input.pack), "pack");
  require(PATH.test(input.path) && !input.path.split("/").includes(".."), "path");
  require(/^[0-9a-f]{40}$/.test(input.actionSha), "actionSha (a full commit SHA)");
  require(VERSION.test(input.cnVersion), "cnVersion");
  require(/^[0-9a-f]{64}$/.test(input.cnSha256), "cnSha256");
  require(input.environment === undefined || ENVIRONMENT.test(input.environment), "environment");
  require(input.buildCommand === undefined || !/[\r\n]/.test(input.buildCommand), "buildCommand (one line)");

  const name = input.pack.split("/")[1]!;
  const build = input.buildCommand ? `      - name: Build\n        run: ${JSON.stringify(input.buildCommand)}\n` : "";
  const environment = input.environment ? `    environment: ${input.environment}\n` : "";
  return `# Publishes ${input.pack} to the Claudinite registry when a tag ${name}/<version> is pushed.
# The "${PACK_CODE_JOB}" job runs your pack's own code with no token and no secrets available. The "${OIDC_JOB}"
# job holds the OIDC permission and runs none of it; the registry refuses a token from the "${PACK_CODE_JOB}" job.
name: Publish ${name}

on:
  push:
    tags:
      - "${name}/*"

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
${build}      - uses: ${UPLOAD}
        with:
          name: pack
          path: ${input.path}
          include-hidden-files: true
          if-no-files-found: error

  ${OIDC_JOB}:
    needs: ${PACK_CODE_JOB}
    runs-on: ubuntu-24.04
${environment}    permissions:
      id-token: write
    steps:
      - uses: ${DOWNLOAD}
        with:
          name: pack
          path: pack
      - name: Read the version from the tag
        id: version
        env:
          TAG: \${{ github.ref_name }}
        run: echo "value=\${TAG#${name}/}" >> "$GITHUB_OUTPUT"
      - uses: ${ACTION_REPOSITORY}@${input.actionSha}
        with:
          pack: "${input.pack}"
          version: \${{ steps.version.outputs.value }}
          path: pack
          cn-version: "${input.cnVersion}"
          cn-sha256: "${input.cnSha256}"
`;
}
