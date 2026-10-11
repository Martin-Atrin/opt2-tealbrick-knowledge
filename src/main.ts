// Knowledge service entry: Miniapp SDK runtime over the Knowledge app definition.
import { chownSync, existsSync } from "node:fs";
import { knowledgeDefinition } from "./app.ts";

/** Railway volumes are root-owned: take ownership of the mount roots, then run as the unprivileged node user. */
function dropPrivileges() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  for (const dir of [process.env.TB_DATA_DIR, process.env.TB_BACKUP_DIR]) if (dir && existsSync(dir)) chownSync(dir, 1000, 1000);
  process.setgid?.(1000);
  process.setuid?.(1000);
}

dropPrivileges();
// The SDK release is resolved at run time until its tarball is pinned in package.json (RELEASES.md).
const sdkName = "@opt2-tealbrick/miniapp-sdk";
const sdk = (await import(sdkName)) as {
  defineApp: (def: unknown) => unknown;
  startApp: (app: unknown, env: Record<string, string | undefined>) => Promise<{ stop(): Promise<void> }>;
  TbError: new (code: string, message: string, httpStatus?: number) => Error;
};
const { definition, knowledge } = knowledgeDefinition(process.env, sdk.TbError);
const running = await sdk.startApp(sdk.defineApp(definition), process.env);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    knowledge.stop();
    void running.stop().finally(() => process.exit(0));
  });
}
