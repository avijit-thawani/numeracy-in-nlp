import test from "node:test";
import assert from "node:assert/strict";

import { parseBibTeX, parseRIS, parseBibliography } from "../lib/bibliography.js";

test("prefers an explicit DOI", () => {
  const [entry] = parseBibTeX(`@article{x, title={A Paper}, doi={10.1145/3442188}}`);
  assert.equal(entry.id, "DOI:10.1145/3442188");
  assert.equal(entry.title, "A Paper");
});

test("strips a doi.org prefix from a DOI field", () => {
  const [entry] = parseBibTeX(`@article{x, title={T}, doi={https://doi.org/10.1145/3442188}}`);
  assert.equal(entry.id, "DOI:10.1145/3442188");
});

test("reads an arXiv eprint", () => {
  const [entry] = parseBibTeX(
    `@article{x, title={T}, eprint={2103.03874}, archivePrefix={arXiv}}`
  );
  assert.equal(entry.id, "arXiv:2103.03874");
});

test("does not read a non-arXiv eprint as an arXiv id", () => {
  const [entry] = parseBibTeX(
    `@article{x, title={T}, eprint={1234.5678}, archivePrefix={hal}}`
  );
  assert.notEqual(entry.id, "arXiv:1234.5678");
});

test("digs an identifier out of a prose field", () => {
  const [entry] = parseBibTeX(
    `@article{x, title={T}, journal={arXiv preprint arXiv:2304.07359}}`
  );
  assert.equal(entry.id, "arXiv:2304.07359");
});

test("keeps capitalisation protected by nested braces", () => {
  const [entry] = parseBibTeX(`@inproceedings{x, title={{BERT}: Pre-training}}`);
  assert.equal(entry.title, "BERT: Pre-training");
});

test("a title containing an @ does not start a new entry", () => {
  const entries = parseBibTeX(
    `@article{a, title={Reaching 90@ accuracy}, doi={10.1/a}}\n@article{b, title={Second}, doi={10.1/b}}`
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.id), ["DOI:10.1/a", "DOI:10.1/b"]);
});

test("falls back to a URL, then to a title search", () => {
  const [withUrl] = parseBibTeX(`@misc{x, title={T}, url={https://example.com/p}}`);
  assert.equal(withUrl.url, "https://example.com/p");
  assert.ok(!withUrl.id);

  const [bare] = parseBibTeX(`@misc{x, title={Only A Title}}`);
  assert.equal(bare.needsTitleMatch, true);
  assert.equal(bare.title, "Only A Title");
});

test("skips @comment, @preamble and @string", () => {
  const entries = parseBibTeX(
    `@comment{ignore me}\n@string{acl = "ACL"}\n@article{x, title={Real}, doi={10.1/real}}`
  );
  assert.deepEqual(entries.map((e) => e.id), ["DOI:10.1/real"]);
});

/**
 * Taken verbatim from avi-thesis.bib. Stripping braces before escapes turned
 * the literal-brace escape into "\PMI", which the macro rule then deleted, so
 * this reached the title search as "\-Masking: Principled masking of
 * correlated spans" and could never match.
 */
test("an escaped literal brace does not eat the word inside it", () => {
  const [entry] = parseBibTeX(
    `@inproceedings{levine2021pmimasking, title={{\\{}PMI{\\}}-Masking: Principled masking of correlated spans}}`
  );
  assert.equal(entry.title, "PMI-Masking: Principled masking of correlated spans");
});

test("a title never starts with leftover punctuation from a macro", () => {
  const [entry] = parseBibTeX(
    `@inproceedings{x, title={\\emph{}-Masking: Principled masking of correlated spans}}`
  );
  assert.ok(!entry.title.includes("\\"), `still has a backslash: ${entry.title}`);
  assert.ok(!/^[-\s:]/.test(entry.title), `starts with punctuation: ${entry.title}`);
});

test("accented characters keep their letter", () => {
  const [entry] = parseBibTeX(`@article{x, title={Beyond the Caf\\'{e}: A Study}}`);
  assert.equal(entry.title, "Beyond the Cafe: A Study");
});

test("parses RIS records", () => {
  const entries = parseRIS(
    [
      "TY  - JOUR",
      "TI  - A Paper",
      "DO  - 10.1/abc",
      "ER  - ",
      "TY  - JOUR",
      "T1  - Another",
      "UR  - https://example.com/x",
      "ER  - ",
    ].join("\n")
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "DOI:10.1/abc");
  assert.equal(entries[1].url, "https://example.com/x");
});

test("a final RIS record with no ER is not dropped", () => {
  const entries = parseRIS("TY  - JOUR\nTI  - Trailing\nDO  - 10.1/tail");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "DOI:10.1/tail");
});

test("dispatches on file extension", () => {
  assert.equal(parseBibliography("x.ris", "TY  - JOUR\nDO  - 10.1/a\nER  - ").length, 1);
  assert.equal(parseBibliography("x.bib", "@article{k, doi={10.1/a}}").length, 1);
});

test("empty and malformed input yields no entries rather than throwing", () => {
  assert.deepEqual(parseBibTeX(""), []);
  assert.deepEqual(parseRIS(""), []);
  assert.doesNotThrow(() => parseBibTeX("@article{unclosed, title={oops"));
});
