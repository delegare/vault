FROM node:24-alpine AS builder

WORKDIR /app

# Pin pnpm to avoid Corepack auto-upgrading to pnpm 11 which changed
# onlyBuiltDependencies handling and causes ERR_PNPM_IGNORED_BUILDS.
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
RUN pnpm config set store-dir /app/.pnpm-store
RUN pnpm config set fetch-retries 5 && pnpm config set network-concurrency 10

# Copy workspace configuration and lockfile first for better caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/mcp-server/package.json ./packages/mcp-server/

# Install all dependencies — ignore-scripts prevents esbuild postinstall errors,
# then run esbuild install explicitly so the binary is available for the build.
RUN --mount=type=cache,id=pnpm,target=/app/.pnpm-store \
    pnpm install --frozen-lockfile --prod=false --ignore-scripts \
    && node node_modules/esbuild/install.js 2>/dev/null || true

# Copy the rest of the source code
COPY . .

# Build the main vault backend
RUN pnpm build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
RUN pnpm config set store-dir /app/.pnpm-store
RUN pnpm config set fetch-retries 5 && pnpm config set network-concurrency 10

# Copy only what is needed for production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/mcp-server/package.json ./packages/mcp-server/

# Install ONLY production dependencies
RUN --mount=type=cache,id=pnpm,target=/app/.pnpm-store \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
    && node node_modules/esbuild/install.js 2>/dev/null || true

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/mcp-server/dist ./packages/mcp-server/dist

# Skybridge hardcodes the manifest path to <cwd>/dist/assets/.vite/manifest.json in production
RUN mkdir -p /app/dist/assets/.vite && \
    cp /app/packages/mcp-server/dist/web/.vite/manifest.json /app/dist/assets/.vite/manifest.json

# Drop privileges
RUN addgroup -S delegare && adduser -S delegare -G delegare
USER delegare

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/app.js"]
