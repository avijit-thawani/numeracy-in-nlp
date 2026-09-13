import test from "node:test";
import assert from "node:assert/strict";

import { buildRecommendations } from "../lib/recommend.js";

const today = new Date().toISOString().slice(0, 10);

/**
 * A pre-populated cache, so these run with no network. `refreshGraph` only
 * fetches entries older than `maxAgeDays`, so a fresh `fetchedAt` keeps the
 * whole pass offline.
 */
const graphOf = (entries) =>
  new Map(
    Object.entries(entries).map(([id, [citedBy, cites]]) => [
      id,
      { fetchedAt: today, citedBy, cites },
    ])
  );

const core = (...ids) => ids.map((id) => ({ id, title: `Paper ${id}`, citationCount: 1 }));

/** Stands in for the metadata lookup, so nothing here touches the network. */
const hydrate = async (requests) => ({
  found: requests.map(({ id }) => ({
    id,
    title: `Paper ${id}`,
    authors: [],
    year: 2020,
    citationCount: 10,
  })),
  missing: [],
});

const build = (opts) =>
  buildRecommendations({
    limit: 25,
    dismissedIds: [],
    seeded: [],
    algorithm: {},
    hydrate,
    ...opts,
  });

/**
 * The regression this file exists for. This path returned a bare `[]` while
 * every other path returned an object, so the caller's `built.coreScores.get`
 * threw, the error was swallowed, and a new survey's first run showed a red
 * "Suggestions failed" annotation with every Core score reading zero.
 */
test("returns the full result shape when nothing can be ranked", async () => {
  const result = await build({
    core: core("a", "b"),
    graph: graphOf({ a: [["x1"], ["y1"]], b: [["x2"], ["y2"]] }),
  });

  assert.ok(!Array.isArray(result), "must not return a bare array");
  assert.deepEqual(result.recs, []);
  assert.ok(result.coreScores instanceof Map, "coreScores must be a Map");
  assert.doesNotThrow(() => result.coreScores.get("a"));
});

test("scores Core even when there are no Recs", async () => {
  // Scoring counts each paper's own edges that land inside Core, in either
  // direction: `a` has two, `c` has one, `b` has none.
  const result = await build({
    core: core("a", "b", "c"),
    graph: graphOf({
      a: [["c"], ["b"]],
      b: [[], []],
      c: [[], ["a"]],
    }),
  });

  assert.deepEqual(result.recs, []);
  assert.equal(result.coreScores.get("a"), 100);
  assert.equal(result.coreScores.get("b"), 0);
  assert.ok(result.coreScores.get("c") > 0 && result.coreScores.get("c") < 100);
});

/**
 * A throttled run and a small survey both reach the "nothing ranked" path, and
 * they need opposite handling: an empty list is the right answer for one and
 * would erase a good list for the other.
 */
test("a survey with no overlap yet reports an empty list, not a failure", async () => {
  const result = await build({
    core: core("a", "b"),
    graph: graphOf({ a: [["x1"], ["y1"]], b: [["x2"], ["y2"]] }),
  });
  assert.equal(result.hydrationFailed, false);
});

test("a run with no citation data at all asks the caller to keep the previous list", async () => {
  const result = await build({
    core: core("a", "b"),
    graph: graphOf({ a: [[], []], b: [[], []] }),
  });
  assert.equal(result.hydrationFailed, true, "empty graph means throttling, not zero Recs");
});

test("an empty Core is not treated as throttling", async () => {
  const result = await build({ core: [], graph: new Map() });
  assert.equal(result.recs.length, 0);
  assert.ok(result.coreScores instanceof Map);
  assert.notEqual(result.hydrationFailed, true);
});

/**
 * `minCount` was clamped with Math.max(2, ...), which silently ignored the
 * documented value. 1 is the setting a survey too small for Recs wants.
 */
test("minCount of 1 is honoured rather than floored to 2", async () => {
  const graph = graphOf({ a: [["shared"], []], b: [["other"], []] });

  const strict = await build({ core: core("a", "b"), graph, algorithm: { minCount: 2 } });
  assert.deepEqual(strict.recs, [], "one citer of one paper must not qualify at minCount 2");

  const loose = await build({ core: core("a", "b"), graph, algorithm: { minCount: 1 } });
  assert.notEqual(loose.hydrationFailed, true, "minCount 1 must change the outcome");
});

test("minCount cannot be driven below 1", async () => {
  const result = await build({
    core: core("a", "b"),
    graph: graphOf({ a: [[], []], b: [[], []] }),
    algorithm: { minCount: 0 },
  });
  assert.ok(result.coreScores instanceof Map);
});

test("papers already in Core are never suggested back", async () => {
  const result = await build({
    core: core("a", "b", "c"),
    graph: graphOf({
      a: [["c", "x"], []],
      b: [["c", "x"], []],
      c: [[], []],
    }),
  });
  assert.ok(!result.recs.some((r) => r.id === "c"), "Core must not appear in Recs");
});
