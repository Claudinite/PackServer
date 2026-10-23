# Sandbox B: load-and-run (validation-pipeline.md step 8). It re-extracts the canonical archive, loads
# the pack with the cn releases it is handed, compiles its checks and runs its task workers and
# env setup once, offline. Go 1.24 with GOPROXY=off compiles; Node 22 runs the runner and the
# workers. It holds no package manager, and nothing in it installs or fetches anything.
# Build from the repository root: docker build -f sandbox/image-b/Dockerfile .
#
# Both bases were resolved from the registry on 2026-10-23. Renovate keeps the digests current; the
# tags are only labels for the humans reading this file.
ARG GO_IMAGE=golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @packserver/sandbox-runner... \
 && pnpm --filter @packserver/sandbox-runner build /out

FROM ${NODE_IMAGE} AS node

FROM ${GO_IMAGE}
# Only the node binary comes across: no npm, npx, corepack or yarn.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN mkdir /in /out && chown 1000:1000 /out
COPY --from=build /out/b-main.mjs /out/b-worker.mjs /out/b-preload.mjs /opt/runner/
USER 1000:1000
ENV NODE_ENV=production GOPROXY=off GOTOOLCHAIN=local GOFLAGS=-mod=mod CGO_ENABLED=0 SANDBOX_REAP_ALL=1
ENTRYPOINT ["node", "--disallow-code-generation-from-strings", "/opt/runner/b-main.mjs"]
