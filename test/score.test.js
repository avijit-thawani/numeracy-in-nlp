import test from "node:test";
import assert from "node:assert/strict";

import { scoreCore, scoreRecs } from "../lib/score.js";

const edges = (entries) => new Map(Object.entries(entries));

test("a one-paper survey is its own centre rather than a division by zero", () => {
  const scores = scoreCore({
    core: [{ id: "a" }],
    citationEdges: new Map(),
    referenceEdges: new Map(),
  });
  assert.equal(scores.get("a"), 100);
});

test("an empty Core produces no scores and does not throw", () => {
  assert.doesNotThrow(() => scoreCore({ core: [], citationEdges: new Map(), referenceEdges: new Map() }));
});

test("a list nobody connects to scores zero rather than dividing by zero", () => {
  const scores = scoreCore({
    core: [{ id: "a" }, { id: "b" }],
    citationEdges: edges({ a: [], b: [] }),
    referenceEdges: edges({ a: [], b: [] }),
  });
  assert.equal(scores.get("a"), 0);
  assert.equal(scores.get("b"), 0);
});

test("edges leaving Core do not count towards centrality", () => {
  const scores = scoreCore({
    core: [{ id: "a" }, { id: "b" }],
    // `a` is cited by two outsiders, `b` by one paper inside Core.
    citationEdges: edges({ a: ["out1", "out2"], b: ["a"] }),
    referenceEdges: edges({ a: [], b: [] }),
  });
  assert.equal(scores.get("a"), 0, "outside citations are not centrality");
  assert.equal(scores.get("b"), 100);
});

test("the most connected paper anchors the scale at 100", () => {
  const scores = scoreCore({
    core: [{ id: "a" }, { id: "b" }, { id: "c" }],
    citationEdges: edges({ a: ["b", "c"], b: ["a"], c: [] }),
    referenceEdges: edges({ a: [], b: [], c: [] }),
  });
  assert.equal(scores.get("a"), 100);
  assert.equal(scores.get("b"), 50);
  assert.equal(scores.get("c"), 0);
});

test("scores stay unrounded so distinct papers keep distinct order", () => {
  const scores = scoreCore({
    core: [{ id: "a" }, { id: "b" }, { id: "c" }],
    citationEdges: edges({ a: ["b", "c"], b: ["a"], c: ["a"] }),
    referenceEdges: edges({ a: ["b"], b: [], c: [] }),
  });
  // 3, 1 and 1 connections against a max of 3 is 100 and 33.33 twice.
  assert.equal(scores.get("a"), 100);
  assert.ok(!Number.isInteger(scores.get("b")), "rounding here collapses the sort order");
});

test("Recs take the better of their two directions", () => {
  const scores = scoreRecs({
    forwardCounts: new Map([["x", 4], ["y", 1]]),
    backwardScores: new Map([["y", 8], ["z", 2]]),
  });
  assert.equal(scores.get("x"), 100, "strongest forward paper");
  assert.equal(scores.get("y"), 100, "strongest backward paper, despite a weak forward count");
  assert.equal(scores.get("z"), 25);
});

test("each direction is scaled on its own, so the penalty cannot sink them all", () => {
  // Backward values are tiny after the popularity penalty. Scaled jointly the
  // whole backward direction would round to nothing.
  const scores = scoreRecs({
    forwardCounts: new Map([["fwd", 50]]),
    backwardScores: new Map([["bwd", 0.4]]),
  });
  assert.equal(scores.get("bwd"), 100);
});

test("a direction with no entries does not produce NaN", () => {
  const scores = scoreRecs({ forwardCounts: new Map(), backwardScores: new Map([["a", 3]]) });
  assert.equal(scores.get("a"), 100);
  assert.ok(!Number.isNaN(scores.get("a")));
});
