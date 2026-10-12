# Open Notebook research engine (upstream unmodified) + tb-exec wrapper.
# Build context: repository root.
ARG TB_SDK_URL=https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/miniapp-sdk-v0.1.5/opt2-tealbrick-miniapp-sdk-0.1.5.tgz
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tb
ARG TB_SDK_URL
RUN npm install --prefix /opt/tb --omit=dev --no-audit --no-fund "$TB_SDK_URL" && npm cache clean --force
# tb-exec reads the app manifest (claim digest, helper, backup) from its default path.
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json

FROM lfnovo/open_notebook:1.14.0@sha256:6c5fb35b6c60549e4c2dc7617d1f07aaf0a67c4954564a73498d536b8186e879
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=tb /usr/local/bin/node /usr/local/bin/node
COPY --from=tb /opt/tb /opt/tb
COPY services/notebook/entrypoint.sh /opt/knowledge/entrypoint.sh
RUN chmod 0755 /opt/knowledge/entrypoint.sh
ENTRYPOINT ["node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--", "/opt/knowledge/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
