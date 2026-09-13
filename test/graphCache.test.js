import test from "node:test";
import assert from "node:assert/strict";

import { loadGraph, saveGraph, keysWorthKeeping, refreshGraph } from "../lib/graphCache.js";

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
