// Wiring of Knowledge's domain services onto the SDK-provided database and context.
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { type AreaProvisioner, Areas } from "./areas.ts";
import { type KnowledgeConfig, PROVIDER_KEY, PROVIDER_MODELS } from "./config.ts";
import { type ClientStore, GBrainClient, type StoredClient } from "./engines/gbrain/client.ts";
import { GBrainEngine } from "./engines/gbrain/engine.ts";
import { NotebookClient } from "./engines/notebook/client.ts";
import { areaSourceId, SHARED_AREA_ID } from "./ids.ts";
import { Projector } from "./projection.ts";
import { DocumentStore } from "./store/documents.ts";

/** What provisioning needs from an SDK context (OpContext has both). */
export interface ServiceAccess {
  getKey(name: string): Promise<string | null>;
  callServiceHelper<O = unknown>(serviceId: string, path: string, body: never): Promise<O>;
}

export interface Services {
  db: Db;
  store: DocumentStore;
  areas: Areas;
  engine: GBrainEngine | null;
  notebook: NotebookClient | null;
  projector: Projector | null;
  config: KnowledgeConfig;
}

/** SDK app secrets (C31): sealed under TB_KEK, excluded from export. */
export interface AppSecrets {
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

/** GBrain OAuth client credentials kept as app secrets (a restore into another deployment simply re-registers). */
class SecretClientStore implements ClientStore {
  private readonly secrets: AppSecrets;
  constructor(secrets: AppSecrets) {
    this.secrets = secrets;
  }
  private name(key: string) {
    return `gbrain-client:${key}`;
  }
  async get(key: string): Promise<StoredClient | null> {
    const raw = await this.secrets.get(this.name(key));
    return raw ? (JSON.parse(raw) as StoredClient) : null;
  }
  async set(key: string, client: StoredClient): Promise<void> {
    await this.secrets.put(this.name(key), JSON.stringify(client));
  }
  async delete(key: string): Promise<void> {
    await this.secrets.delete(this.name(key));
  }
}

export interface KnowledgeOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** projection drain interval; 0 disables the timer (tests drive drains explicitly) */
  drainIntervalMs?: number;
}

export class Knowledge {
  readonly config: KnowledgeConfig;
  private readonly opts: KnowledgeOptions;
  private services: Services | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private provisioning: Promise<void> | null = null;
  private secrets: AppSecrets = memorySecrets();

  constructor(config: KnowledgeConfig, opts: KnowledgeOptions = {}) {
    this.config = config;
    this.opts = opts;
  }

  /** Services over the SDK database (the same handle for the whole process). */
  /** `secrets` is the SDK app-secret store (every SDK context carries the same one). */
  bind(db: Db, secrets?: AppSecrets): Services {
    if (secrets && secrets !== this.secrets) {
      // First context that carries the SDK secret store: rebuild so engine clients use it.
      this.secrets = secrets;
      this.services = null;
    }
    if (this.services && this.services.db === db) return this.services;
    const now = this.opts.now ?? Date.now;
    const store = new DocumentStore(db, now);
    const areas = new Areas(db, now);
    let engine: GBrainEngine | null = null;
    if (this.config.engine === "gbrain" && this.config.gbrainUrl && this.config.gbrainAdminToken) {
      const client = new GBrainClient({ baseUrl: this.config.gbrainUrl, adminToken: this.config.gbrainAdminToken, store: new SecretClientStore(this.secrets), fetch: this.opts.fetch, now });
      engine = new GBrainEngine(client, areaSourceId(SHARED_AREA_ID));
    }
    const notebook =
      this.config.research && this.config.notebookUrl && this.config.notebookPassword
        ? new NotebookClient({ baseUrl: this.config.notebookUrl, password: this.config.notebookPassword, fetch: this.opts.fetch })
        : null;
    const projector = engine ? new Projector(db, store, areas, engine, now) : null;
    this.services = { db, store, areas, engine, notebook, projector, config: this.config };
    const interval = this.opts.drainIntervalMs ?? 30_000;
    if (projector && interval > 0 && !this.timer) {
      this.timer = setInterval(() => void this.services?.projector?.drain().catch(() => undefined), interval);
      this.timer.unref();
    }
    return this.services;
  }

  /** Services already bound (null before the first call or event). */
  current(): Services | null {
    return this.services;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Kick the projection outbox without waiting (called after every document write). */
  kick(services: Services) {
    void services.projector?.drain().catch(() => undefined);
  }

  /** Provision engine resources for areas that lack them (shared by concurrent callers). */
  provision(services: Services, access: ServiceAccess): Promise<void> {
    if (!this.provisioning) {
      this.provisioning = services.areas.provisionPending(this.provisioner(services, access)).finally(() => (this.provisioning = null));
    }
    return this.provisioning;
  }

  private provisioner(services: Services, access: ServiceAccess): AreaProvisioner {
    const provisioner: AreaProvisioner = {};
    if (services.engine) {
      // C6: the GBrain companion image carries a helper that runs upstream's trusted `gbrain sources add`.
      provisioner.createSource = async (sourceId, label) => {
        await access.callServiceHelper("gbrain", "/sources", GBrainEngine.sourceRequest(sourceId, label) as never);
      };
    }
    if (services.notebook) {
      const notebook = services.notebook;
      provisioner.ensureNotebook = (areaId, label) => notebook.ensureNotebook(`knowledge-${areaId}`, label);
    }
    return provisioner;
  }

  /** Research chat model in Open Notebook, provisioned once from the bridge-held keys (C2). */
  async researchModel(services: Services, access: ServiceAccess): Promise<string> {
    const cached = services.db.prepare("SELECT value FROM kn_state WHERE key = 'notebook_model'").get();
    if (cached) return String(cached.value);
    if (!services.notebook) throw new Error("research disabled");
    const provider = this.config.modelProvider;
    const models = PROVIDER_MODELS[provider];
    const apiKey = await access.getKey(PROVIDER_KEY[provider]);
    const embeddingApiKey = await access.getKey(PROVIDER_KEY[models.embeddingProvider]);
    if (!apiKey || !embeddingApiKey) throw Object.assign(new Error("model keys are missing"), { code: "key_missing" });
    const modelId = await services.notebook.provisionModels({
      provider,
      apiKey,
      chatModel: models.chatModel,
      embeddingProvider: models.embeddingProvider,
      embeddingApiKey,
      embeddingModel: models.embeddingModel,
    });
    services.db.prepare("INSERT INTO kn_state (key, value) VALUES ('notebook_model', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(modelId);
    return modelId;
  }

  /** After a key change the research engine must be re-provisioned with the new value. */
  forgetResearchModel(services: Services) {
    services.db.prepare("DELETE FROM kn_state WHERE key = 'notebook_model'").run();
  }
}

/** Fallback before the SDK hands over its secret store (only reached in tests). */
export function memorySecrets(): AppSecrets {
  const values = new Map<string, string>();
  return {
    put: async (name, value) => void values.set(name, value),
    get: async (name) => values.get(name) ?? null,
    delete: async (name) => void values.delete(name),
  };
}
