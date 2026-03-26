# Official pnpm monorepo Docker pattern — source: https://pnpm.io/docker
# Build context: monorepo ROOT. Deploy with:
#   gcloud builds submit --config cloudbuild.yaml .

# ── Base: node + pnpm via corepack (official pnpm recommendation) ─────────────
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── Build stage ───────────────────────────────────────────────────────────────
FROM base AS build

# Copy ENTIRE monorepo (official pattern — selective COPY causes frozen-lockfile issues)
COPY . /usr/src/app
WORKDIR /usr/src/app

# Install all workspace deps with BuildKit cache mount for speed on rebuilds
RUN pnpm install --frozen-lockfile

# Compile ws-server TypeScript → dist/
RUN pnpm --filter @voiceflow/ws-server build

# pnpm deploy creates a fully self-contained package at /prod/ws-server:
#   - Resolves @voiceflow/shared (workspace:*) into node_modules
#   - Copies src/, dist/, package.json with all prod deps
#   - No dangling workspace: references in the output
RUN pnpm deploy --filter=@voiceflow/ws-server --legacy --prod /prod/ws-server


# ── Runtime stage (lean production image) ─────────────────────────────────────
FROM base AS runtime

COPY --from=build /prod/ws-server /app
WORKDIR /app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
