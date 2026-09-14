import test from "node:test";
import assert from "node:assert/strict";

import { scoreCore, scoreRecs, applyAuthority, authorityFactor } from "../lib/score.js";

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

// ---- Author authority --------------------------------------------------

/**
 * A famous author writing outside your topic must not outrank a paper that
 * cites four of yours: connection stays the ranking, authority only breaks
 * ties inside it. That is why this is a small multiplier and not a term added
 * to the score.
 */
test("authority nudges the order without overturning it", () => {
  const papers = [
    { id: "connected", score: 100, topAuthors: [] },
    { id: "famous", score: 60, topAuthors: [{ name: "Big Name", hIndex: 99 }] },
  ];
  const out = applyAuthority(papers, 0.2);
  assert.equal(out[0].id, "connected");
  assert.ok(out[0].score > out[1].score, "the well-connected paper keeps the top spot");
});

test("between equally connected papers, the established author wins", () => {
  const out = applyAuthority(
    [
      { id: "unknown", score: 50, topAuthors: [{ name: "New", hIndex: 1 }] },
      { id: "senior", score: 50, topAuthors: [{ name: "Senior", hIndex: 80 }] },
    ],
    0.2
  );
  const byId = new Map(out.map((p) => [p.id, p.score]));
  assert.ok(byId.get("senior") > byId.get("unknown"));
});

test("the top of the list is still 100 after adjustment", () => {
  const out = applyAuthority(
    [
      { id: "a", score: 100, topAuthors: [] },
      { id: "b", score: 90, topAuthors: [{ name: "X", hIndex: 50 }] },
    ],
    0.2
  );
  assert.equal(Math.max(...out.map((p) => p.score)), 100);
});

test("a weight of zero leaves every score exactly as it was", () => {
  const papers = [{ id: "a", score: 42, topAuthors: [{ name: "X", hIndex: 90 }] }];
  assert.deepEqual(applyAuthority(papers, 0), papers);
});

/**
 * h-indexes are long-tailed: 5 to 20 is a real difference, 80 to 95 is noise.
 */
test("the h-index curve flattens at the top", () => {
  const gainLow = authorityFactor([{ hIndex: 20 }], 0.2) - authorityFactor([{ hIndex: 5 }], 0.2);
  const gainHigh = authorityFactor([{ hIndex: 95 }], 0.2) - authorityFactor([{ hIndex: 80 }], 0.2);
  assert.ok(gainLow > gainHigh * 3, "early h-index growth counts for much more");
});

test("no author data means no adjustment at all", () => {
  assert.equal(authorityFactor([], 0.2), 1);
  assert.equal(authorityFactor(undefined, 0.2), 1);
  assert.equal(authorityFactor([{ name: "X" }], 0.2), 1);
});
