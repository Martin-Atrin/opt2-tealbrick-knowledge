// Knowledge service entry: Miniapp SDK runtime over the Knowledge app definition. The SDK drops root privileges
// itself (BSA-05/C54: chown TB_DATA_DIR/TB_BACKUP_DIR, then uid/gid 1000).
import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { knowledgeDefinition } from "./app.ts";

const { definition, knowledge } = knowledgeDefinition(process.env, TbError);
const running = await startApp(defineApp(definition), process.env);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    knowledge.stop();
    void running.stop().finally(() => process.exit(0));
  });
}
