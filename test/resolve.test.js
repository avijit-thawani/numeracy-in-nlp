import test from "node:test";
import assert from "node:assert/strict";

import { resolveIdentifier, resolveAll } from "../lib/resolve.js";

test("normalises the link shapes SETUP.md promises", () => {
  const cases = [
    ["https://arxiv.org/abs/2103.03874", "arXiv:2103.03874"],
    ["https://arxiv.org/pdf/2103.03874.pdf", "arXiv:2103.03874"],
    ["https://arxiv.org/abs/2103.03874v3", "arXiv:2103.03874"],
    ["2103.03874", "arXiv:2103.03874"],
    ["arXiv:2103.03874", "arXiv:2103.03874"],
    ["10.18653/v1/N18-2074", "DOI:10.18653/v1/N18-2074"],
    ["doi:10.18653/v1/N18-2074", "DOI:10.18653/v1/N18-2074"],
    ["https://doi.org/10.18653/v1/N18-2074", "DOI:10.18653/v1/N18-2074"],
    ["https://aclanthology.org/2020.acl-main.463", "DOI:10.18653/v1/2020.acl-main.463"],
    ["https://dl.acm.org/doi/10.1145/3442188.3445922", "DOI:10.1145/3442188.3445922"],
    ["https://dl.acm.org/doi/abs/10.1145/3442188.3445922", "DOI:10.1145/3442188.3445922"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveIdentifier(input), expected, input);
  }
});

test("a trailing note does not leak into the identifier", () => {
  assert.equal(resolveIdentifier("https://arxiv.org/abs/2105.13626  # ByT5"), "arXiv:2105.13626");
});

test("a URL fragment is not mistaken for a note", () => {
  assert.equal(
    resolveIdentifier("https://openreview.net/forum?id=abc#discussion"),
    "URL:https://openreview.net/forum?id=abc#discussion"
  );
});

test("rejects what it cannot identify", () => {
  for (const bad of ["", "   ", "javascript:alert(1)", "ftp://example.com/x.pdf", "#comment"]) {
    assert.equal(resolveIdentifier(bad), null, bad);
  }
});

test("separates titles, refs: seeds, comments and junk", () => {
  const { resolved, unresolved, seedFrom, titles } = resolveAll([
    "# a comment",
    "",
    "https://arxiv.org/abs/2103.03874",
    "refs: https://arxiv.org/abs/2103.13136",
    "Representing Numbers in NLP a Survey and a Vision",
    "javascript:alert(1)",
  ]);

  assert.deepEqual(resolved.map((r) => r.id), ["arXiv:2103.03874"]);
  assert.deepEqual(seedFrom.map((r) => r.id), ["arXiv:2103.13136"]);
  assert.equal(titles.length, 1);
  assert.deepEqual(unresolved, ["javascript:alert(1)"]);
});

test("the same paper twice in one file is queued once", () => {
  const { resolved } = resolveAll([
    "https://arxiv.org/abs/2103.03874",
    "https://arxiv.org/pdf/2103.03874v2.pdf",
  ]);
  assert.equal(resolved.length, 1);
});

/**
 * The property behind the leftovers ratchet. Whatever gets written back into
 * papers.txt is read again next run, so every line the writer can emit has to
 * survive a round trip. A bibliography's `source` label ("thesis.bib: Some
 * Title") did not: it parsed as a title, failed to match, and was written
 * back again while the .bib re-contributed its own copy. One survey reached
 * 95 lines covering 12 papers.
 */
test("a bibliography source label is not a parseable input line", () => {
  const label = "avi-thesis.bib: An Empirical Investigation of Contextualized Number Prediction";
  const { resolved, titles } = resolveAll([label]);

  assert.equal(resolved.length, 0, "it is not an identifier");
  assert.deepEqual(
    titles,
    [label],
    "it parses as a title, which is exactly why writing it back multiplied it"
  );
});

test("every line resolveAll accepts survives a round trip", () => {
  const lines = [
    "https://arxiv.org/abs/2103.03874",
    "10.18653/v1/N18-2074",
    "https://aclanthology.org/2020.acl-main.463",
  ];
  for (const line of lines) {
    const first = resolveIdentifier(line);
    assert.equal(resolveIdentifier(line), first, `${line} must be stable`);
    assert.ok(first, line);
  }
});
