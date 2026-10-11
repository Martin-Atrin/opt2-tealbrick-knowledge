# Companion service images

Each image is a thin layer over a pinned, unmodified upstream image (or upstream source at a pinned commit),
plus the Miniapp SDK `tb-exec` wrapper entrypoint (C2: fetches the manifest-declared keys from the bridge with
the service's own instance key and execs the upstream command with them as env; runs `backup.dump`/`restore`;
starts the C6 helper). No upstream file is changed or vendored.

| Service | Upstream | Knowledge adds |
|---|---|---|
| `gbrain` | garrytan/gbrain at commit 99de5707 (v0.60.57.0), built on `oven/bun` | `entrypoint.sh` (init, migrations, serve), `helper.ts` (C6: `POST /sources` runs upstream's trusted `gbrain sources add`) |
| `gbrain-db` | `pgvector/pgvector:0.8.1-pg17` | dump/restore scripts for the SDK backup runner |
| `notebook` | `lfnovo/open_notebook:1.14.0` | `entrypoint.sh` (composes `SURREAL_URL` from the private host) |
| `notebook-db` | `surrealdb/surrealdb:v2.6.5` (binary copied onto node:24-slim so `tb-exec` can run) | nothing else |

`tb-exec` (`dist/exec/cli.js`) comes from the `@opt2-tealbrick/miniapp-sdk` release tarball (`TB_SDK_URL` build argument), run by a
Node 24 binary copied into the image.

All four images build with the repository root as context (they bake `tealbrick.manifest.json` into `/opt/tb/`, where tb-exec reads it).
