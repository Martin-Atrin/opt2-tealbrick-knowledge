// Argument guard applied before any upstream GBrain call; returns a refusal reason or null.
const RESERVED_PAGE_PREFIXES = ["knowledge-docs/"];
const PAGE_CONTENT_WRITES = new Set(["put_page", "delete_page", "restore_page", "edit_page", "revert_version", "capture", "put_raw_data"]);
const FORCE_WRITES = new Set(["put_page", "remember", "capture", "edit_page", "revert_version"]);

function hasControlOrSpace(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(ch)) return true;
  }
  return false;
}

export function argumentRefusal(operation: string, args: Record<string, unknown>): string | null {
  const present = (key: string) => Object.hasOwn(args, key) && args[key] !== undefined && args[key] !== null;
  if (Object.hasOwn(args, "source_id") || Object.hasOwn(args, "source_ids")) return "source_id is selected by Knowledge from the area";
  if (["remember", "extract_facts", "ontology_propose"].includes(operation) && args.visibility === "private") {
    return "private visibility is not available; memory in an area is shared by everyone who may read the area";
  }
  if (operation === "capture" && Object.hasOwn(args, "local_file")) return "local_file reads the engine host filesystem";
  if (operation === "extract_entities" && args.trusted_extraction === true) return "trusted_extraction bypasses upstream review";
  if (present("image_path")) return "image_path reads the engine host filesystem";
  if (present("local_dir")) return "local_dir reads the engine host filesystem";
  if (operation.startsWith("takes_") && present("holder") && args.holder !== "world") return "only the world holder is available";
  if (FORCE_WRITES.has(operation) && present("force") && args.force !== false) return "force bypasses revision checks";
  if (present("image_url")) {
    const raw = args.image_url;
    let parsed: URL | null = null;
    try {
      parsed = typeof raw === "string" ? new URL(raw) : null;
    } catch {
      parsed = null;
    }
    // Upstream reads the host filesystem for file:// and absolute paths: require an exact lowercase http(s) prefix.
    if (typeof raw !== "string" || !/^https?:\/\/[^\s/?#\\]/u.test(raw) || hasControlOrSpace(raw) || !parsed || !parsed.hostname) {
      return "image_url must be an http(s) URL";
    }
  }
  if ((operation === "think" || operation === "synthesize") && present("model")) return "model selection belongs to the deployment settings";
  if (operation === "think" && ((present("save") && args.save !== false) || (present("take") && args.take !== false))) return "think may not persist takes or pages";
  if (operation === "get_calibration_profile" && present("holder")) return "only the default calibration holder is available";
  if (PAGE_CONTENT_WRITES.has(operation) && typeof args.slug === "string" && RESERVED_PAGE_PREFIXES.some((prefix) => String(args.slug).toLowerCase().startsWith(prefix))) {
    return "pages under knowledge-docs/ mirror Knowledge documents; change the document instead";
  }
  return null;
}
