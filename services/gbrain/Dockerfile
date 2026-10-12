# GBrain memory engine: upstream source at a pinned commit, unmodified, + tb-exec wrapper + C6 source helper.
# Build context: repository root.
ARG TB_SDK_URL=https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/miniapp-sdk-v0.1.5/opt2-tealbrick-miniapp-sdk-0.1.5.tgz
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tb
ARG TB_SDK_URL
RUN npm install --prefix /opt/tb --omit=dev --no-audit --no-fund "$TB_SDK_URL" && npm cache clean --force
# tb-exec reads the app manifest (claim digest, helper, backup) from its default path.
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json

FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef
ARG GBRAIN_REPO=https://github.com/garrytan/gbrain.git
ARG GBRAIN_COMMIT=99de5707f6fc0916f43b4c167802a5f8d9ea0cf0
ARG GBRAIN_VERSION=0.60.57.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tini libstdc++6 && rm -rf /var/lib/apt/lists/* \
  && git init -q /opt/gbrain && cd /opt/gbrain && git remote add origin "$GBRAIN_REPO" \
  && git fetch -q --depth 1 origin "$GBRAIN_COMMIT" && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$GBRAIN_COMMIT" && test "$(cat VERSION)" = "$GBRAIN_VERSION" \
  && rm -rf .git && bun install --frozen-lockfile --production \
  && apt-get purge -y git && apt-get autoremove -y
COPY --from=tb /usr/local/bin/node /usr/local/bin/node
COPY --from=tb /opt/tb /opt/tb
COPY services/gbrain/entrypoint.sh services/gbrain/helper.ts /opt/knowledge/
RUN chmod 0755 /opt/knowledge/entrypoint.sh && mkdir -p /data
ENV GBRAIN_HOME=/data GBRAIN_ROOT=/opt/gbrain PORT=3131
EXPOSE 3131 3140
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--helper-cmd", "node /opt/knowledge/helper.ts", "--helper-target", "127.0.0.1:3141", "--"]
CMD ["/opt/knowledge/entrypoint.sh"]
