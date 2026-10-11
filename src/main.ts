// Knowledge service entry: Miniapp SDK runtime over the Knowledge app definition.
import { chownSync, existsSync, mkdirSync } from "node:fs";
import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { knowledgeDefinition } from "./app.ts";

/** Railway volumes are root-owned: take ownership of the mount roots, then run as the unprivileged node user. */
function dropPrivileges() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  for (const dir of [process.env.TB_DATA_DIR, process.env.TB_BACKUP_DIR]) {
    if (!dir) continue;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    chownSync(dir, 1000, 1000);
  }
  process.setgid?.(1000);
  process.setuid?.(1000);
}

dropPrivileges();
const { definition, knowledge } = knowledgeDefinition(process.env, TbError);
const running = await startApp(defineApp(definition), process.env);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    knowledge.stop();
    void running.stop().finally(() => process.exit(0));
  });
}
