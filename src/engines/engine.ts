// Internal engine adapter contract. Engines are pinned, unmodified upstream
// services. Authorization never moves into an engine: the adapter only ever
// receives areas the SDK authorization function already allowed.

export type EngineId = "gbrain" | "hindsight";

export type ToolEffect = "read" | "write" | "destructive";

export interface EngineTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
}

/** An authorized area binding: one write area, a read set that contains it. */
export interface AreaBinding {
  write: string;
  read: readonly string[];
}

export interface RecallRow {
  area: string;
  kind: string;
  id: string;
  text: string;
  source?: string;
  time?: string;
}

export interface EngineReadiness {
  engine: EngineId;
  state: "available" | "needs_model_key" | "needs_embeddings" | "unavailable";
}

export interface Engine {
  readonly id: EngineId;
  readiness(): Promise<EngineReadiness>;
  /** Ensure the engine-side store for an area exists (GBrain source, Hindsight bank). */
  ensureArea(area: string): Promise<void>;
  recall(binding: AreaBinding, query: string, limit: number): Promise<RecallRow[]>;
  /** Project a canonical document body into one area (idempotent by documentId + content hash). */
  projectDocument(area: string, documentId: string, markdown: string): Promise<void>;
  removeDocument(area: string, documentId: string): Promise<void>;
  tools(): Promise<EngineTool[]>;
  callTool(binding: AreaBinding, name: string, args: Record<string, unknown>): Promise<unknown>;
}
