# The image an isolated agent session runs in (docs/decisions/0061-an-agent-session-in-a-container.md):
# Node 24, the certificate store an agent CLI's TLS client reads, git for a ruling's read-only
# git commands, and one agent CLI at the version the pipeline pins in src/runner/container.mjs,
# passed in as build arguments. The base image is pinned by digest.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
ARG CLI_PACKAGE
ARG CLI_VERSION
RUN test -n "$CLI_PACKAGE" && test -n "$CLI_VERSION" \
 && npm install -g --no-audit --no-fund "${CLI_PACKAGE}@${CLI_VERSION}" \
 && npm cache clean --force
USER node
WORKDIR /workspace
