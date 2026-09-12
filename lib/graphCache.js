import { log } from "./log.js";
import { fetchCitationIds, fetchReferenceIdsFor } from "./semanticScholar.js";

/**
 * Remembers each paper's citation and reference edges between runs.
 *
 * Working out Recs needs two requests per paper in Core, so a 474-paper survey
 * is about 950 requests. Doing that every day is both slow and wasteful:
 * citation lists barely change overnight, and the API throttles hard enough
 * that the run is dominated by backoff. Benchmarking showed extra concurrency
 * does not help, because the limit is server-side rather than latency.
 *
 * So each run refreshes only what is new or stale, up to a budget, and reuses
 * the cache for everything else. A survey of any size then costs a bounded
 * amount per day, and the whole graph still comes round within `maxAgeDays`.
 */

const today = () => new Date().toISOString().slice(0, 10);

const ageInDays = (stamp) => {
  if (!stamp) return Infinity;
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / 86_400_000;
};

export const loadGraph = (stored) => {
  const graph = new Map();
  for (const [id, entry] of Object.entries(stored?.graph ?? {})) {
    graph.set(id, entry);
  }
  return graph;
};

export const saveGraph = (graph, keepIds) => {
  const out = {};
  for (const [id, entry] of graph) {
    if (keepIds.has(id)) out[id] = entry;
  }
  return { updatedAt: new Date().toISOString(), graph: out };
};

/**
 * Returns { citationEdges, referenceEdges } for every given paper, fetching
 * only those missing or past `maxAgeDays`, and never more than `budget` of
 * them in one run.
 */
export const refreshGraph = async ({ graph, paperIds, maxAgeDays = 7, budget = 150, concurrency }) => {
  const stale = paperIds.filter((id) => ageInDays(graph.get(id)?.fetchedAt) > maxAgeDays);

  // Oldest first, so nothing is starved and the whole survey comes round.
  stale.sort((a, b) => ageInDays(graph.get(b)?.fetchedAt) - ageInDays(graph.get(a)?.fetchedAt));
  const due = stale.slice(0, budget);

  if (!stale.length) {
    log.info(`Citation graph is current for all ${paperIds.length} paper(s); nothing to fetch.`);
  } else {
    log.info(
      `Citation graph: ${paperIds.length} paper(s), ${stale.length} stale, refreshing ${due.length} this run.`
    );
    if (due.length < stale.length) {
      log.info(`The remaining ${stale.length - due.length} will be picked up by later runs.`);
    }
  }

  if (due.length) {
    const citations = await fetchCitationIds(due, concurrency);
    const references = await fetchReferenceIdsFor(due, concurrency);
    const stamp = today();

    for (const id of due) {
      graph.set(id, {
        fetchedAt: stamp,
        citedBy: citations.get(id) ?? [],
        cites: references.edges.get(id) ?? [],
      });
    }
    // Global citation counts, used to discount ubiquitous papers, are only
    // returned by the reference pass, so cache them alongside.
    for (const [id, count] of references.citationCounts) {
      const existing = graph.get(`counts:${id}`) ?? {};
      graph.set(`counts:${id}`, { ...existing, citationCount: count, fetchedAt: stamp });
    }
  }

  const citationEdges = new Map();
  const referenceEdges = new Map();
  const citationCounts = new Map();

  for (const id of paperIds) {
    const entry = graph.get(id);
    if (!entry) continue;
    citationEdges.set(id, entry.citedBy ?? []);
    referenceEdges.set(id, entry.cites ?? []);
  }
  for (const [key, entry] of graph) {
    if (key.startsWith("counts:")) citationCounts.set(key.slice(7), entry.citationCount ?? 0);
  }

  const covered = paperIds.filter((id) => graph.has(id)).length;
  log.stat("papers with citation data", `${covered} of ${paperIds.length}`);

  return { citationEdges, referenceEdges, citationCounts };
};
