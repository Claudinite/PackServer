# Sandbox B: load-and-run (validation-pipeline.md step 8). It re-extracts the canonical archive, loads
# the pack with the cn releases it is handed, compiles its checks and runs its task workers and
# env setup once, offline. Go 1.24 with GOPROXY=off compiles; Node 22 runs the runner and the
# workers. The final stage is Debian slim with Node, plus the Go toolchain copied in: no
# compiler, no curl, wget or git, no apt or dpkg, no npm. Build from the repository root:
# docker build -f sandbox/image-b/Dockerfile .
#
# Run it as root with every capability dropped except SETUID, SETGID, KILL, CHOWN and FOWNER, and
# no new privileges (the corpus does exactly that). The runner uses them for three things only:
# to run pack content as uid SANDBOX_PACK_UID, to keep that identity out of the output directory
# and the engine releases, and to kill what that identity leaves running. It refuses to start
# pack content without them. Pack content gets no capability: its identity is not root.
#
# Known limit: the egress record covers Node processes (the preload module) and dynamically
# linked programs (the LD_PRELOAD shim). A statically linked program, such as cn or the go tool
# themselves, is not recorded; the container has no network either way, so such an attempt
# fails but leaves no record.
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

# The toolchain and the compiler for the shim come from the Go image; only the toolchain and the shim cross over.
FROM ${GO_IMAGE} AS go
COPY sandbox/image-b/egress-shim.c /src/egress-shim.c
RUN gcc -O2 -Wall -Wextra -Werror -shared -fPIC -o /libegress.so /src/egress-shim.c

FROM ${NODE_IMAGE}
COPY --from=go /usr/local/go /usr/local/go
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn* \
 && rm -f /usr/bin/apt* /usr/bin/dpkg* /usr/bin/curl /usr/bin/wget /usr/bin/git \
 && rm -rf /usr/lib/apt /var/lib/apt /var/lib/dpkg/info /var/cache/apt \
 && mkdir /in /out
COPY --from=build /out/b-main.mjs /out/b-worker.mjs /out/b-preload.mjs /opt/runner/
COPY --from=go /libegress.so /opt/runner/libegress.so
ENV NODE_ENV=production GOPROXY=off GOTOOLCHAIN=local CGO_ENABLED=0 SANDBOX_PACK_UID=10001 SANDBOX_EGRESS_SHIM=/opt/runner/libegress.so
ENTRYPOINT ["node", "--disallow-code-generation-from-strings", "/opt/runner/b-main.mjs"]
