# Single-stage, no build step.
#
# The stack decision (docs/STACK-DECISION.md) is partly that there is nothing to
# build: the server is plain CommonJS. So the image copies sources and runs
# node, and a compile error can never stop the portal from booting.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DOGFOOD_DB=/data/dogfood.db \
    DOGFOOD_FIXTURES=/app/official/fixtures.json

WORKDIR /app

# better-sqlite3 is a native module, so its prebuild is fetched in a layer that
# is only invalidated when package.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY official ./official

# Fixtures are mounted read-only and the database lives on a volume, so the
# image itself stays immutable.
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
