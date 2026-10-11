// Knowledge app definition for the Miniapp SDK: manifest + handlers by operation id + dynamic engine
// tools + events. Routes, validation, receipts, holds, idempotency, scopes and backups are the SDK's.
import { readFileSync } from "node:fs";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { AppDefinition } from "@opt2-tealbrick/spec/sdk";
import { readConfig } from "./config.ts";
import { createHandlers, type ErrorFactory } from "./handlers.ts";
import { Knowledge, type KnowledgeOptions } from "./knowledge.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as Manifest;
export const migrationsDir = new URL("../migrations", import.meta.url).pathname;

export function knowledgeDefinition(env: Record<string, string | undefined>, TbError: ErrorFactory, opts: KnowledgeOptions = {}): { definition: AppDefinition; knowledge: Knowledge } {
  const knowledge = new Knowledge(readConfig(env), opts);
  const { handlers, dynamic, events } = createHandlers(knowledge, TbError);
  return {
    knowledge,
    definition: {
      manifest,
      handlers: handlers as AppDefinition["handlers"],
      dynamic,
      events,
      migrations: migrationsDir,
    },
  };
}
