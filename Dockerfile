# Teal Brick Knowledge app service (TypeScript run directly by Node 24 type stripping).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tealbrick.manifest.json ./
COPY migrations ./migrations
COPY skills ./skills
COPY src ./src
EXPOSE 8080
# Starts as root only to take ownership of the Railway volume mounts, then drops to uid 1000 (src/main.ts).
CMD ["node", "src/main.ts"]
