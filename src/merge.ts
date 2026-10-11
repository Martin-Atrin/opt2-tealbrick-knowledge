// Cross-area reads: bounded fan-out, then one merged answer with a per-area status (never a silent drop).

export interface AreaOutcome<T> {
  area: string;
  ok: boolean;
  value?: T;
  error?: string;
}

/** Run `fn` for every area, at most `limit` at once, keeping area order. Errors are reported, not thrown. */
export async function fanOut<T>(areas: readonly string[], limit: number, fn: (area: string) => Promise<T>): Promise<AreaOutcome<T>[]> {
  const outcomes: AreaOutcome<T>[] = new Array(areas.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= areas.length) return;
      const area = areas[index] as string;
      try {
        outcomes[index] = { area, ok: true, value: await fn(area) };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "failed";
        outcomes[index] = { area, ok: false, error: code.slice(0, 80) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, areas.length) }, worker));
  return outcomes;
}

/**
 * Reciprocal rank fusion over per-area ranked lists (raw scores are not comparable across stores).
 * `key` deduplicates (same document in two lists shows once); ties keep area order.
 */
export function mergeRanked<T>(lists: readonly { area: string; rows: readonly T[] }[], key: (row: T) => string, limit: number, k = 60): (T & { areas: string[] })[] {
  const merged = new Map<string, { row: T; score: number; areas: string[]; first: number }>();
  let order = 0;
  for (const list of lists) {
    list.rows.forEach((row, rank) => {
      const id = key(row);
      const entry = merged.get(id);
      const score = 1 / (k + rank + 1);
      if (entry) {
        entry.score += score;
        if (!entry.areas.includes(list.area)) entry.areas.push(list.area);
      } else {
        merged.set(id, { row, score, areas: [list.area], first: order++ });
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, limit)
    .map((entry) => ({ ...entry.row, areas: entry.areas }));
}
