# ── Stage 1: Build ──────────────────────────────────────────────────────────
# Build context must be the monorepo ROOT (not packages/ws-server).
# Run: gcloud run deploy --source . --dockerfile packages/ws-server/Dockerfile
FROM node:20-slim AS builder

WORKDIR /repo

RUN npm install -g pnpm

# Copy workspace manifests first — Docker caches this layer until they change.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY shared/package.json          ./shared/
COPY packages/ws-server/package.json ./packages/ws-server/

# Install all workspace dependencies (resolves @voiceflow/shared: workspace:*)
RUN pnpm install --frozen-lockfile

# Copy source after deps are installed (faster cache on source-only changes)
COPY shared/                      ./shared/
COPY packages/ws-server/src/      ./packages/ws-server/src/
COPY packages/ws-server/tsconfig.json ./packages/ws-server/

# Compile TypeScript → dist/
RUN pnpm --filter @voiceflow/ws-server build

# pnpm deploy creates an isolated production bundle with node_modules
# and all workspace packages (shared/) inlined — no dangling workspace: refs.
RUN pnpm deploy --filter @voiceflow/ws-server --prod /app/deploy

# pnpm deploy doesn't include the compiled dist/ — copy it manually
RUN cp -r packages/ws-server/dist /app/deploy/dist


# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/deploy ./

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
