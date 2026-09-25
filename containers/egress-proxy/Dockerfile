# The forward proxy an isolated agent session reaches the network through
# (docs/decisions/0061-an-agent-session-in-a-container.md). Node's standard library and one
# file; the base image is the agent image's, pinned by digest, so the two share their layers.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
COPY proxy.mjs /opt/egress-proxy/proxy.mjs
USER node
EXPOSE 3128
CMD ["node", "/opt/egress-proxy/proxy.mjs"]
