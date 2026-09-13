import test from "node:test";
import assert from "node:assert/strict";

import { parseAuthorTarget, resolveAuthorPapers } from "../lib/authors.js";
import { resolveAll } from "../lib/resolve.js";
import { applyFreshness, ageInDays } from "../lib/recommend.js";

test("an author line is recognised however it is written", () => {
  const { authors, resolved, unresolved } = resolveAll([
    "author: https://www.semanticscholar.org/author/Niyati-Bafna/2061069",
    "Authors : Niyati Bafna",
    "https://arxiv.org/abs/2103.03874",
  ]);

  assert.equal(authors.length, 2);
  assert.equal(authors[0].target, "https://www.semanticscholar.org/author/Niyati-Bafna/2061069");
  assert.equal(authors[1].target, "Niyati Bafna");
  assert.equal(resolved.length, 1, "ordinary links still parse as papers");
  assert.deepEqual(unresolved, []);
});

test("every supported profile shape resolves to the same two fields", () => {
  const cases = [
    ["https://www.semanticscholar.org/author/Niyati-Bafna/2061069", "semanticScholar", "2061069"],
    ["https://www.semanticscholar.org/author/2061069", "semanticScholar", "2061069"],
    ["2061069", "semanticScholar", "2061069"],
    ["https://openalex.org/A5023888391", "openalex", "A5023888391"],
    ["openalex:a5023888391", "openalex", "A5023888391"],
    ["https://orcid.org/0000-0002-1825-0097", "orcid", "0000-0002-1825-0097"],
    ["0000-0002-1825-009X", "orcid", "0000-0002-1825-009X"],
    ["Niyati Bafna", "name", "Niyati Bafna"],
  ];

  for (const [input, kind, value] of cases) {
    const parsed = parseAuthorTarget(input);
    assert.equal(parsed.kind, kind, `kind for ${input}`);
    assert.equal(parsed.value, value, `value for ${input}`);
  }
});

/**
 * Google Scholar is the profile people are most likely to reach for and the
 * one nobody can query: no API, and the URL carries an opaque user id rather
 * than the person's name, so there is nothing to fall back to.
 */
test("a Google Scholar profile is refused with a reason rather than half-working", () => {
  const parsed = parseAuthorTarget("https://scholar.google.com/citations?user=abc123");
  assert.equal(parsed.kind, "unsupported");
  assert.match(parsed.reason, /no public API/i);
  assert.match(parsed.reason, /Semantic Scholar or OpenAlex/i);
});

test("a profile URL from somewhere else entirely is refused, not read as a name", () => {
  assert.equal(parseAuthorTarget("https://example.com/~me").kind, "unsupported");
});

/**
 * The failure that would quietly empty a survey: a throttled publication-list
 * request must not read as "this author has published nothing", because the
 * caller would then have no papers to add and the next run would see a Core it
 * no longer recognises.
 */
test("a failed publication lookup returns null rather than an empty career", async () => {
  const result = await resolveAuthorPapers({
    target: { kind: "semanticScholar", value: "42", label: "author 42" },
    papersFor: async () => null,
  });
  assert.equal(result, null);
});

test("a name with several matching profiles takes the most published one", async () => {
  const result = await resolveAuthorPapers({
    target: { kind: "name", value: "J Smith", label: "J Smith" },
    search: async () => [
      { authorId: "1", name: "J Smith", paperCount: 3, hIndex: 2 },
      { authorId: "2", name: "John Smith", paperCount: 90, hIndex: 40 },
    ],
    papersFor: async (id) => [{ id: `p-${id}`, title: "A paper", year: 2024 }],
  });

  assert.equal(result.authorId, "2");
  assert.equal(result.name, "John Smith");
  assert.deepEqual(result.papers, [{ id: "p-2", title: "A paper", year: 2024 }]);
});

/**
 * A profile resolved once is followed by its id afterwards, and that lookup
 * cannot learn the person's name. Returning a stand-in would overwrite the
 * real name stored on the first run with "author 2090730520".
 */
test("following by id reports no name rather than inventing one", async () => {
  const result = await resolveAuthorPapers({
    target: { kind: "semanticScholar", value: "2090730520", label: "author 2090730520" },
    papersFor: async () => [{ id: "p1", title: "A paper", year: 2026 }],
  });
  assert.equal(result.name, null);
  assert.equal(result.authorId, "2090730520");
});

test("a name nobody matches is a failure, not an author with no papers", async () => {
  const result = await resolveAuthorPapers({
    target: { kind: "name", value: "Nobody At All", label: "Nobody At All" },
    search: async () => [],
    papersFor: async () => [{ id: "x" }],
  });
  assert.equal(result, null);
});

// ---- Recency windows --------------------------------------------------

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const rec = (id, score, publicationDate) => ({ id, score, publicationDate, why: "cites 2 in Core" });

test("an undated paper is dated to mid-year, not to January", () => {
  const january = ageInDays({ year: new Date().getFullYear() });
  assert.ok(january > 0, "a year alone must not look newer than today");
});

test("recent work gets the top slots even though it scores lower", () => {
  const out = applyFreshness(
    [
      rec("old-strong", 100, "2019-01-01"),
      rec("new-weak", 10, daysAgo(3)),
      rec("mid-weak", 20, daysAgo(90)),
    ],
    { windows: [{ days: 30, count: 1, label: "past month" }, { days: 180, count: 1, label: "past 6 months" }] }
  );

  assert.deepEqual(out.map((x) => x.id), ["new-weak", "mid-weak", "old-strong"]);
  assert.equal(out[0].freshWindow, "past month");
  assert.equal(out[2].freshWindow, undefined, "the general pool is not labelled");
});

test("the windows do not overlap, so last week is not also counted as last month", () => {
  const out = applyFreshness([rec("a", 5, daysAgo(2)), rec("b", 4, daysAgo(10))], {
    windows: [{ days: 30, count: 1, label: "past month" }, { days: 180, count: 1, label: "past 6 months" }],
  });

  assert.equal(out[0].freshWindow, "past month");
  assert.equal(out[1].freshWindow, "past 6 months", "b falls through to the wider window");
});

test("within a window it is still our own score that decides", () => {
  const out = applyFreshness([rec("low", 1, daysAgo(5)), rec("high", 99, daysAgo(6))], {
    windows: [{ days: 30, count: 2, label: "past month" }],
  });
  assert.deepEqual(out.map((x) => x.id), ["high", "low"]);
});

test("an empty window gives its slots back rather than shortening the list", () => {
  const out = applyFreshness([rec("a", 3, "2015-01-01"), rec("b", 2, "2014-01-01")], {
    windows: [{ days: 30, count: 10, label: "past month" }],
    limit: 2,
  });
  assert.deepEqual(out.map((x) => x.id), ["a", "b"]);
});

test("a paper dated in the future is not treated as fresh", () => {
  const ahead = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const out = applyFreshness([rec("future", 1, ahead), rec("now", 1, daysAgo(1))], {
    windows: [{ days: 30, count: 1, label: "past month" }],
  });
  assert.equal(out[0].id, "now");
});
