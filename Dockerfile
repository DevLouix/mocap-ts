# mocap-ts — self-hosted motion capture workspace
#
# Multi-stage build. The runtime image contains everything the pipeline
# shells out to: ffmpeg (frame extraction — required by ALL jobs) and
# yt-dlp (URL jobs). @tensorflow/tfjs-node's native binding is compiled
# during `pnpm install` (onlyBuiltDependencies in package.json).
#
# Build:  docker build -t mocap-ts .
# Run:    docker run -p 3000:3000 -v mocap-data:/data mocap-ts
# Or:     docker compose up
#
# URL jobs failing with a bot check? Mount cookies and point
# YTDLP_COOKIES_FILE at them (see docker-compose.yml).

########## Stage 1: deps + build ##########
FROM node:22-bookworm-slim AS build

# ffmpeg/yt-dlp are only needed at runtime, but installing them here too
# means the same image can run `pnpm test` without a separate deps step.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      python3-minimal \
      python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp

# Enable corepack-managed pnpm (package.json pins pnpm@9).
RUN corepack enable

WORKDIR /app

# Install workspace deps first (better layer caching).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/tailwind-config/package.json packages/tailwind-config/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile

# Copy sources and build both packages.
COPY tsconfig.base.json tsconfig.base.json
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @mocap-ts/core build \
 && pnpm --filter @mocap-ts/db build \
 && pnpm --filter @mocap-ts/storage build \
 && pnpm --filter @mocap-ts/queue build \
 && pnpm --filter @mocap-ts/web build \
 && pnpm --filter @mocap-ts/worker build

########## Stage 2: runtime ##########
FROM node:22-bookworm-slim AS runtime

# Runtime external binaries: ffmpeg (ALL jobs) + yt-dlp (URL jobs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      python3-minimal \
      python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp
# Run as the image's built-in `node` user (UID 1000) — creating a new user
# with that UID collides ("UID 1000 is not unique").

WORKDIR /app

# Copy the whole built workspace (node_modules incl. the tfjs-node native
# binding, core dist, web .next). We deliberately do NOT prune dev deps or
# use `pnpm deploy` here: pnpm deploy drops the Next build output, and a
# lean-but-broken image is worse than a full-but-working one. Revisit with
# Next standalone output if image size matters.
COPY --from=build --chown=node:node /app /app

# The instrumentation bundle externalizes the TF stack (it must not be
# webpack'd), so at runtime Next requires '@tensorflow/*' from the compiled
# server chunk under /app/apps/web/. pnpm nests those packages in its
# virtual store, off that chunk's walk-up path — so surface every scoped
# TF package onto /app/node_modules (first occurrence wins).
RUN mkdir -p /app/node_modules/@tensorflow /app/node_modules/@tensorflow-models \
 && for d in /app/node_modules/.pnpm/*/node_modules/@tensorflow/*; do \
      b=$(basename "$d"); [ -e "$d" ] && [ ! -e "/app/node_modules/@tensorflow/$b" ] && ln -s "$d" "/app/node_modules/@tensorflow/$b"; \
    done; \
    for d in /app/node_modules/.pnpm/*/node_modules/@tensorflow-models/*; do \
      b=$(basename "$d"); [ -e "$d" ] && [ ! -e "/app/node_modules/@tensorflow-models/$b" ] && ln -s "$d" "/app/node_modules/@tensorflow-models/$b"; \
    done; true

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # Single-workspace container mode. Set MOCAP_AUTH_MODE=header behind an
    # identity-aware reverse proxy for multi-user deployments.
    MOCAP_AUTH_MODE=local \
    MOCAP_PERSISTENCE=durable \
    MOCAP_WORKER_MODE=durable \
    # Persist jobs/uploads/outputs (and optional cookies.txt) here.
    MOCAP_DATA_DIR=/data

RUN mkdir -p /data /app/apps/web/public/assets/characters && chown -R node:node /data

USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `next start` from the web workspace — node_modules symlinks resolve.
WORKDIR /app/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start"]
