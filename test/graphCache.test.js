import test from "node:test";
import assert from "node:assert/strict";

import {
  loadGraph,
  saveGraph,
  keysWorthKeeping,
  refreshGraph,
  stalenessAllowance,
} from "../lib/graphCache.js";

const today = new Date().toISOString().slice(0, 10);

const cacheOf = (graph) => Object.keys(saveGraph(graph, keysWorthKeeping(graph, [...graph.keys()].filter((k) => !k.startsWith("counts:")))).graph);

test("a cache survives a save and load round trip", () => {
  const graph = new Map([["a", { fetchedAt: today, citedBy: ["x"], cites: ["y"] }]]);
  const reloaded = loadGraph(saveGraph(graph, new Set(["a"])));
  assert.deepEqual(reloaded.get("a"), graph.get("a"));
});

test("loading absent or malformed storage gives an empty graph", () => {
  assert.equal(loadGraph(null).size, 0);
  assert.equal(loadGraph({}).size, 0);
  assert.equal(loadGraph({ graph: {} }).size, 0);
});

/**
 * Counts are the denominator of the backward popularity penalty. A missing one
 * falls back to 1, which switches the penalty off for that paper and floats
 * exactly the ubiquitous works it exists to sink -- so a count that is still
 * needed must never be pruned, however old it is.
 */
test("a count still cited by Core is kept no matter how stale", () => {
  const graph = new Map([
    ["a", { fetchedAt: today, citedBy: [], cites: ["popular"] }],
    ["counts:popular", { citationCount: 90000, fetchedAt: "2020-01-01" }],
  ]);
  const keep = keysWorthKeeping(graph, ["a"]);
  assert.ok(keep.has("counts:popular"), "the penalty needs this denominator");
});

test("a count nothing in Core cites any more is dropped", () => {
  const graph = new Map([
    ["a", { fetchedAt: today, citedBy: [], cites: ["still-cited"] }],
    ["counts:still-cited", { citationCount: 10, fetchedAt: today }],
    // Left behind by a paper that has since been removed from Core.
    ["counts:orphan", { citationCount: 10, fetchedAt: today }],
  ]);
  const keep = keysWorthKeeping(graph, ["a"]);
  assert.ok(keep.has("counts:still-cited"));
  assert.ok(!keep.has("counts:orphan"), "an orphaned count is what used to accumulate for good");
});

test("a paper dropped from Core takes its edges with it", () => {
  const graph = new Map([
    ["a", { fetchedAt: today, citedBy: [], cites: [] }],
    ["gone", { fetchedAt: today, citedBy: [], cites: ["only-ref"] }],
    ["counts:only-ref", { citationCount: 5, fetchedAt: today }],
  ]);
  const kept = Object.keys(saveGraph(graph, keysWorthKeeping(graph, ["a"])).graph);
  assert.deepEqual(kept, ["a"]);
});

test("pruning keeps everything a real survey still needs", () => {
  // Two papers, each citing one work; nothing here is orphaned.
  const graph = new Map([
    ["a", { fetchedAt: today, citedBy: ["x"], cites: ["r1"] }],
    ["b", { fetchedAt: today, citedBy: ["y"], cites: ["r2"] }],
    ["counts:r1", { citationCount: 3, fetchedAt: today }],
    ["counts:r2", { citationCount: 4, fetchedAt: today }],
  ]);
  assert.equal(cacheOf(graph).length, 4, "a steady-state cache must not shrink");
});

test("a fresh cache means no fetching", async () => {
  const graph = new Map([["a", { fetchedAt: today, citedBy: ["x"], cites: ["y"] }]]);
  // No stub: reaching the network here would throw.
  const out = await refreshGraph({ graph, paperIds: ["a"], maxAgeDays: 7 });
  assert.deepEqual(out.citationEdges.get("a"), ["x"]);
  assert.deepEqual(out.referenceEdges.get("a"), ["y"]);
});

test("counts are exposed without their key prefix", async () => {
  const graph = new Map([
    ["a", { fetchedAt: today, citedBy: [], cites: ["r"] }],
    ["counts:r", { citationCount: 42, fetchedAt: today }],
  ]);
  const out = await refreshGraph({ graph, paperIds: ["a"], maxAgeDays: 7 });
  assert.equal(out.citationCounts.get("r"), 42);
});

// ---- Age-aware staleness ----------------------------------------------

const NOW = new Date("2026-09-13T00:00:00Z");
const daysBefore = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * The refresh budget exists to notice new citations. An old paper's citation
 * list grows by a fraction of a percent a week and a new one can double, so
 * spending the same on both wastes most of the budget where nothing changes.
 */
test("a recent paper keeps the base allowance", () => {
  assert.equal(stalenessAllowance(2026, 7, NOW), 7);
  assert.equal(stalenessAllowance(2025, 7, NOW), 7);
});

test("an older paper is allowed to go staler, up to a cap", () => {
  assert.equal(stalenessAllowance(2024, 7, NOW), 14);
  assert.equal(stalenessAllowance(2021, 7, NOW), 35);
  assert.equal(stalenessAllowance(1990, 7, NOW), 84, "capped at twelve times the base");
});

/**
 * A missing year must not buy a paper a three-month holiday: refreshing an old
 * paper too often costs one request, missing a new paper's citations costs a
 * Rec that the recency windows exist to surface.
 */
test("a paper with no year is treated as new", () => {
  assert.equal(stalenessAllowance(null, 7, NOW), 7);
  assert.equal(stalenessAllowance(undefined, 7, NOW), 7);
  assert.equal(stalenessAllowance("not a year", 7, NOW), 7);
});

test("the budget goes to the new paper rather than the old one", async () => {
  // Both were last fetched 20 days ago: past the 7-day base, but only the
  // recent paper is past its own allowance.
  const graph = new Map([
    ["new", { fetchedAt: daysBefore(20), citedBy: [], cites: [] }],
    ["old", { fetchedAt: daysBefore(20), citedBy: [], cites: [] }],
  ]);

  const asked = [];
  await refreshGraph({
    graph,
    paperIds: ["new", "old"],
    years: new Map([["new", new Date().getFullYear()], ["old", 2005]]),
    budget: 10,
    fetchCitations: async (ids) => {
      asked.push(...ids);
      return new Map(ids.map((id) => [id, []]));
    },
    fetchReferences: async (ids) => ({ edges: new Map(ids.map((id) => [id, []])), citationCounts: new Map() }),
  });

  assert.deepEqual(asked, ["new"], "only the recent paper was due");
});

test("turning age-awareness off refreshes everything on the base schedule", async () => {
  const graph = new Map([
    ["new", { fetchedAt: daysBefore(20), citedBy: [], cites: [] }],
    ["old", { fetchedAt: daysBefore(20), citedBy: [], cites: [] }],
  ]);

  const asked = [];
  await refreshGraph({
    graph,
    paperIds: ["new", "old"],
    years: new Map([["new", 2026], ["old", 2005]]),
    ageAware: false,
    budget: 10,
    fetchCitations: async (ids) => {
      asked.push(...ids);
      return new Map(ids.map((id) => [id, []]));
    },
    fetchReferences: async (ids) => ({ edges: new Map(ids.map((id) => [id, []])), citationCounts: new Map() }),
  });

  assert.deepEqual(asked.sort(), ["new", "old"]);
});
