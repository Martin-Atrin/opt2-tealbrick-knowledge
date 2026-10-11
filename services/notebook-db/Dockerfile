# SurrealDB for Open Notebook: the unmodified upstream binary on node:24-slim (the upstream image is
# distroless, so tb-exec could not run there).
ARG TB_SDK_URL=https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/miniapp-sdk-v0.1.0/opt2-tealbrick-miniapp-sdk-0.1.0.tgz
FROM surrealdb/surrealdb:v2.6.5@sha256:7db835aab6355b66e2b5779a3cddae811f201c417adadb4413310ae7f925110e AS surreal

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG TB_SDK_URL
RUN npm install --prefix /opt/tb --omit=dev --no-audit --no-fund "$TB_SDK_URL" && npm cache clean --force \
  && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=surreal /surreal /surreal
RUN mkdir -p /mydata
ENTRYPOINT ["node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/server/tb-exec-cli.js", "--"]
CMD ["sh", "-c", "exec /surreal start --bind 0.0.0.0:8000 --user \"$SURREAL_USER\" --pass \"$SURREAL_PASS\" rocksdb:/mydata/knowledge.db"]
