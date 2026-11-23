// Utilitaires asynchrones sans dépendance externe.

/**
 * Exécute `fn` sur chaque élément avec une concurrence bornée, tout en
 * préservant exactement l'ordre du tableau d'entrée.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const workersCount = Math.max(1, Math.min(limit || 1, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) break;
      results[index] = await fn(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: workersCount }, worker));
  return results;
}
