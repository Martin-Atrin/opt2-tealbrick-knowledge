// Conformance harness (CONFORMANCE §2, app target): `tb-conformance app --start conformance.start.ts` boots Knowledge
// with the suite's env (fake bridge, enrolment code, TB_KEK, data dir) plus the deploy-time settings env. No engine
// services run here: recall answers from keyword search (`degraded: true`), engine-backed ops answer `area_not_ready`.
import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { knowledgeDefinition, manifest } from "./src/app.ts";

const SETTINGS = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_RESEARCH: "false", KNOWLEDGE_MODEL_PROVIDER: "openai" };

export default async function start(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void>; backupNow(): Promise<void> }> {
  const full = { ...SETTINGS, ...env };
  const { definition, knowledge } = knowledgeDefinition(full, TbError);
  // Test roots (C63; suite default since spec 0.1.12): the suite passes TEST Portal Root Keys in TBCONF_PORTAL_ROOT_KEYS;
  // only this harness reads it and hands them to startApp. Production never reads that variable.
  const harness = env.TBCONF_PORTAL_ROOT_KEYS ? ({ portalRootKeys: JSON.parse(env.TBCONF_PORTAL_ROOT_KEYS) } as Parameters<typeof startApp>[2]) : undefined;
  const running = await startApp(defineApp(definition), full, harness);
  return {
    url: `http://127.0.0.1:${manifest.runtime.port}`,
    stop: async () => {
      knowledge.stop();
      await running.stop();
    },
    backupNow: async () => {
      await running.backups.runNow();
    },
  };
}
