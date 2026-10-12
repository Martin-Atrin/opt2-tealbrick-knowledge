# Postgres + pgvector for GBrain (upstream unmodified) + tb-exec for the SDK backup runner.
# Build context: repository root.
ARG TB_SDK_URL=https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/miniapp-sdk-v0.1.6/opt2-tealbrick-miniapp-sdk-0.1.6.tgz
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tb
ARG TB_SDK_URL
RUN npm install --prefix /opt/tb --omit=dev --no-audit --no-fund "$TB_SDK_URL" && npm cache clean --force
# tb-exec reads the app manifest (claim digest, helper, backup) from its default path.
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json

FROM pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=tb /usr/local/bin/node /usr/local/bin/node
COPY --from=tb /opt/tb /opt/tb
COPY services/gbrain-db/gbrain-db-dump services/gbrain-db/gbrain-db-restore /usr/local/bin/
RUN chmod 0755 /usr/local/bin/gbrain-db-dump /usr/local/bin/gbrain-db-restore
ENTRYPOINT ["node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--", "docker-entrypoint.sh"]
CMD ["postgres"]
