import test from "node:test";
import assert from "node:assert/strict";

import { renderTable, allViews, SORTS } from "../lib/views.js";
import {
  applySurvey,
  applyFooter,
  renderFooter,
  renderCsv,
  SURVEY_START,
  SURVEY_END,
} from "../lib/renderReadme.js";
import { titleFromRepoName, resolveIdentity } from "../lib/identity.js";

const rec = (over = {}) => ({
  id: "a".repeat(40),
  title: "A Paper",
  authors: ["One", "Two"],
  venue: "ACL",
  year: 2021,
  citationCount: 7,
  score: 80,
  why: "cites 3 in Core",
  ...over,
});

// Splits on cell separators only. An escaped `\|` is a literal pipe inside a
// cell, so counting it as a separator would report phantom columns.
const columnCount = (row) => row.split(/(?<!\\)\|/).slice(1, -1).length;

test("every row has as many columns as the header", () => {
  const lines = renderTable({ rows: [rec()], list: "recs", sort: "score", showWhy: true, repo: "o/r" });
  const [head, rule, ...body] = lines;
  assert.equal(columnCount(rule), columnCount(head), "rule must match header");
  for (const row of body) {
    assert.equal(columnCount(row), columnCount(head), `row has wrong column count: ${row}`);
  }
});

test("Core rows match the narrower Core header", () => {
  const lines = renderTable({ rows: [rec()], list: "core", sort: "score" });
  const [head, rule, ...body] = lines;
  assert.equal(columnCount(rule), columnCount(head));
  for (const row of body) assert.equal(columnCount(row), columnCount(head));
  assert.ok(!head.includes("Decide"), "Core has nothing to decide");
});

/**
 * The Decide column is the whole of step 4 in the README, and it renders as a
 * row of dashes unless `repo` reaches it. It did not, for the copy of the
 * render pipeline that lived in update.js.
 */
test("Decide offers add and drop links once the repo is known", () => {
  const [, , row] = renderTable({
    rows: [rec({ arxivId: "2103.03874" })],
    list: "recs",
    sort: "score",
    showWhy: true,
    repo: "owner/survey",
  });
  assert.match(row, /\[add\]\(https:\/\/github\.com\/owner\/survey\/issues\/new\?labels=add-paper/);
  assert.match(row, /\[drop\]\(https:\/\/github\.com\/owner\/survey\/issues\/new\?labels=drop-paper/);
});

test("Decide prefers a pull request when one is open", () => {
  const [, , row] = renderTable({
    rows: [rec({ prUrl: "https://github.com/o/r/pull/12", prNumber: 12 })],
    list: "recs",
    sort: "score",
    showWhy: true,
    repo: "o/r",
  });
  assert.match(row, /\[review #12\]/);
});

test("a pipe in a title cannot break the table", () => {
  const [, , row] = renderTable({
    rows: [rec({ title: "Tables | Pipes | Trouble" })],
    list: "recs",
    sort: "score",
    showWhy: true,
    repo: "o/r",
  });
  assert.equal(columnCount(row), 8);
});

test("the active column is marked and the others are links", () => {
  const [head] = renderTable({ rows: [rec()], list: "core", sort: "year" });
  assert.ok(!/\[Year\]/.test(head), "the active column must not link to itself");
  assert.match(head, /\[Score\]\(core-by-score\.md\)/);
});

test("an empty list explains itself instead of rendering an empty table", () => {
  assert.match(renderTable({ rows: [], list: "core", sort: "score" })[0], /Nothing in Core yet/);
  assert.match(renderTable({ rows: [], list: "recs", sort: "score" })[0], /Nothing yet/);
});

test("every list and sort combination gets a file", () => {
  const files = allViews({ core: [rec()], recs: [rec()], config: { title: "T" }, repo: "o/r" });
  assert.equal(files.length, 2 * Object.keys(SORTS).length);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("views/core-by-score.md"));
  assert.ok(paths.includes("views/recs-by-title.md"));
  assert.equal(new Set(paths).size, paths.length, "no duplicate paths");
});

test("sorting a view does not reorder the caller's array", () => {
  const rows = [rec({ id: "x", year: 2000 }), rec({ id: "y", year: 2024 })];
  const before = rows.map((r) => r.id);
  allViews({ core: rows, recs: [], config: { title: "T" } });
  assert.deepEqual(rows.map((r) => r.id), before);
});

test("only the marked region of a README is replaced", () => {
  const readme = `# Mine\n\nMy own words.\n\n${SURVEY_START}\nold\n${SURVEY_END}\n\nNotes I keep.\n`;
  const out = applySurvey(readme, `${SURVEY_START}\nnew\n${SURVEY_END}`);
  assert.match(out, /My own words\./);
  assert.match(out, /Notes I keep\./);
  assert.match(out, /new/);
  assert.ok(!out.includes("old"));
});

test("a README with no markers keeps its prose", () => {
  const out = applySurvey("# Mine\n\nProse.\n", `${SURVEY_START}\nblock\n${SURVEY_END}`);
  assert.match(out, /Prose\./);
  assert.match(out, /block/);
});

test("rendering twice is stable", () => {
  const block = `${SURVEY_START}\nblock\n${SURVEY_END}`;
  const once = applyFooter(applySurvey("# Mine\n\nProse.\n", block), renderFooter());
  const twice = applyFooter(applySurvey(once, block), renderFooter());
  assert.equal(twice, once, "a second render must not append a second footer");
});

test("the footer is replaced rather than stacked", () => {
  let text = "# Mine\n";
  for (let i = 0; i < 3; i++) text = applyFooter(text, renderFooter());
  assert.equal(text.match(/Want your own living survey\?/g).length, 1);
});

test("CSV quotes the separators it contains", () => {
  const csv = renderCsv([
    { id: "1", title: 'Commas, and "quotes"', authors: ["A", "B"], year: 2020 },
  ]);
  const [header, row] = csv.split("\n");
  assert.equal(header.split(",")[0], "id");
  assert.match(row, /"Commas, and ""quotes"""/);
  assert.match(row, /A; B/);
});

test("a repo name becomes a readable title", () => {
  assert.equal(titleFromRepoName("numeracy-in-nlp"), "Numeracy in NLP");
  assert.equal(titleFromRepoName("tokenization_in_NLP"), "Tokenization in NLP");
  assert.equal(titleFromRepoName("llm-agents-survey"), "LLM Agents");
  assert.equal(titleFromRepoName("my-living-survey"), "My Living Survey");
  assert.equal(titleFromRepoName(""), "My Living Survey");
});

test("config beats the repo name, which beats the default", () => {
  const event = { repository: { name: "numeracy-in-nlp", description: "About numbers" } };
  assert.equal(resolveIdentity({ title: "Chosen" }, event).title, "Chosen");
  assert.equal(resolveIdentity({ title: "  " }, event).title, "Numeracy in NLP");
  assert.equal(resolveIdentity({}, event).description, "About numbers");
  assert.equal(resolveIdentity({}, null).title, "My Living Survey");
});
