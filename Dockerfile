# Teal Brick Knowledge app service (TypeScript run directly by Node 24 type stripping).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS ui
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tealbrick.manifest.json ./
COPY migrations ./migrations
COPY skills ./skills
COPY src ./src
COPY --from=ui /build/dist/ui ./dist/ui
EXPOSE 5310
# Railway runs volume services as root (C38, RAILWAY_RUN_UID=0); src/main.ts takes ownership of the
# volume mounts and drops to uid 1000.
CMD ["node", "src/main.ts"]
