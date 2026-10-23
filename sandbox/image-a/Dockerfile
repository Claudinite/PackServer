# Sandbox A: bounded extractor, static inspectors and canonical re-packer (validation-pipeline.md
# steps 3 to 7). It reads bytes and text and never loads, compiles or runs pack content, so the
# image holds Node only to run this runner: no Go, no package manager, no shell tooling beyond the
# base. Build from the repository root: docker build -f sandbox/image-a/Dockerfile .
#
# The base is node:22-bookworm-slim, resolved from the registry on 2026-10-23. Renovate keeps the
# digest current; the tag is only a label for the humans reading this file.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @packserver/sandbox-runner... \
 && pnpm --filter @packserver/sandbox-runner build /out

FROM ${NODE_IMAGE}
# Nothing in the final image installs or fetches anything.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn* \
 && mkdir /in /out && chown 1000:1000 /out
COPY --from=build /out/a-main.mjs /out/a-worker.mjs /opt/runner/
USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["node", "--disallow-code-generation-from-strings", "/opt/runner/a-main.mjs"]
