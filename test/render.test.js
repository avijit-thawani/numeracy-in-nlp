import test from "node:test";
import assert from "node:assert/strict";

import { renderTable, allViews, sortLinks, SORTS } from "../lib/views.js";
import { topAuthorsOf, affiliationsOf } from "../lib/semanticScholar.js";
import {
  renderSurvey,
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

/**
 * The words stay put even when the destination changes. A cell reading
 * "review #71" described the mechanism and left the reader no way to tell that
 * this is how a paper joins their list.
 */
test("Decide always asks the same question, and add opens the pull request", () => {
  const [, , row] = renderTable({
    rows: [rec({ prUrl: "https://github.com/o/r/pull/12", prNumber: 12 })],
    list: "recs",
    showWhy: true,
    repo: "o/r",
  });

  assert.match(row, /\[add\]\(https:\/\/github\.com\/o\/r\/pull\/12\)/, "merging the PR is the acceptance");
  assert.match(row, /\[drop\]\(https:\/\/github\.com\/o\/r\/issues\/new\?labels=drop-paper/);
  assert.doesNotMatch(row, /review/, "no mechanism words, and no issue numbers");
});

test("a pipe in a title cannot break the table", () => {
  const [, , row] = renderTable({
    rows: [rec({ title: "Tables | Pipes | Trouble" })],
    list: "recs",
    sort: "score",
    showWhy: true,
    repo: "o/r",
  });
  assert.equal(columnCount(row), 7);
});

/**
 * The sort links moved out of the headings and under the table when Venue,
 * Year and Cited by were folded into one Details cell.
 */
test("the active sort is marked and the others are links", () => {
  const line = sortLinks("core", "year");
  assert.match(line, /\*\*Year\*\*/, "the active sort is named, not linked");
  assert.ok(!/\[Year\]/.test(line), "the active sort must not link to itself");
  assert.match(line, /\[Score\]\(core-by-score\.md\)/);
  assert.match(line, /\[Cited by\]\(core-by-citations\.md\)/);
});

test("the details cell carries year, venue, citations and the reason", () => {
  const [, , row] = renderTable({
    rows: [rec({ year: 2026, venue: "ACL", citationCount: 1, why: "cites 2 in your list" })],
    list: "recs",
    showWhy: true,
    repo: "o/r",
  });
  assert.match(row, /2026 · ACL/);
  assert.match(row, /1 citation</, "singular, since it is read as prose");
  assert.match(row, /cites 2 in your list/);
});

test("an empty list explains itself instead of rendering an empty table", () => {
  assert.match(renderTable({ rows: [], list: "core" })[0], /Nothing in your list yet/);
  assert.match(renderTable({ rows: [], list: "recs" })[0], /Nothing yet/);
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

/**
 * The recency windows reserve the top of the Recs list, and a paper published
 * last month scores low by construction. Re-sorting by score here put those
 * papers back among the rest, where the preview cut them off -- the feature
 * ran every day and was invisible on every front page.
 */
test("the README keeps the order the ranking chose, not score order", () => {
  const recs = [
    { id: "fresh", title: "New", score: 2, why: "past month · cites 2 in Core", freshWindow: "past month" },
    { id: "old", title: "Established", score: 100, why: "cited by 9 in Core" },
  ];
  const block = renderSurvey({ config: { title: "T", description: "" }, core: [], recs });
  assert.ok(block.indexOf("New") < block.indexOf("Established"), "the reserved paper must stay on top");
});

/**
 * The window used to be written into the Why column, which is the
 * second-to-last column of a table wide enough to scroll: "the best paper
 * published this month" rendered as an unremarkable middle row. Each window
 * gets its own table so the answer to "what is new?" is a heading.
 */
/**
 * The count used to be the link, which made it the only clickable thing under
 * a table -- and it only ever offered one of the four sort orders that already
 * exist as files.
 */
test("the row count is plain text and every sort order is offered", () => {
  const core = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, title: `Paper ${i}`, score: 100 - i }));
  const block = renderSurvey({ config: { title: "T", description: "" }, core, recs: [], preview: 5 });

  assert.match(block, /… and 7 more\. View all, sorted by/);
  assert.doesNotMatch(block, /\[… and 7 more/, "the count must not be a link");
  for (const sort of ["score", "year", "citations", "title"]) {
    assert.match(block, new RegExp(`\\(views/core-by-${sort}\\.md\\)`), `${sort} view is linked`);
  }
});

test("a table showing everything still links the other sort orders", () => {
  const core = [{ id: "a", title: "Only", score: 1 }];
  const block = renderSurvey({ config: { title: "T", description: "" }, core, recs: [], preview: 5 });
  assert.doesNotMatch(block, /more\./, "nothing was hidden, so nothing is claimed to be");
  assert.match(block, /View all, sorted by .*\[Year\]\(views\/core-by-year\.md\)/);
});

test("five rows per table, including each recency window", () => {
  const window = (n, label) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${label}${i}`,
      title: `${label} paper ${i}`,
      score: 100 - i,
      why: `${label} · cites 2 in Core`,
      freshWindow: label,
    }));

  const block = renderSurvey({
    config: { title: "T", description: "" },
    core: [],
    recs: [...window(8, "past month"), ...window(9, "past year")],
    preview: 5,
  });

  // Sliced at the "View all" line rather than at the next <sub>, because every
  // row contains <sub> tags of its own for the authors and the summary.
  const rows = (heading) => {
    const from = block.indexOf(`### New in the ${heading}`);
    const to = block.indexOf("View all, sorted by", from);
    return block.slice(from, to).split("\n").filter((l) => /^\| \d+ \|/.test(l)).length;
  };

  assert.equal(rows("past month"), 5);
  assert.equal(rows("past year"), 5);
  assert.equal((block.match(/… and 3 more/g) ?? []).length, 1, "past month hid 3");
  assert.equal((block.match(/… and 4 more/g) ?? []).length, 1, "past year hid 4");
});

test("each recency window gets its own table", () => {
  const recs = [
    { id: "a", title: "Fresh", score: 5, why: "past month · cites 2 in Core", freshWindow: "past month" },
    { id: "b", title: "Newish", score: 9, why: "past year · cites 3 in Core", freshWindow: "past year" },
    { id: "c", title: "Classic", score: 99, why: "cited by 9 in Core" },
  ];
  const block = renderSurvey({ config: { title: "T", description: "" }, core: [], recs });

  assert.match(block, /### New in the past month/);
  assert.match(block, /### New in the past year/);
  assert.match(block, /### Most connected, any year/);
  assert.ok(
    block.indexOf("### New in the past month") < block.indexOf("### New in the past year"),
    "narrower windows come first"
  );
  assert.ok(block.indexOf("Fresh") < block.indexOf("Classic"));
});

test("a window heading is not repeated in every row of its table", () => {
  const recs = [
    { id: "a", title: "Fresh", score: 5, why: "past month · cites 2 in your list", freshWindow: "past month" },
  ];
  const block = renderSurvey({ config: { title: "T", description: "" }, core: [], recs });
  assert.match(block, /cites 2 in your list/);
  assert.doesNotMatch(block, /past month · cites/, "the heading already said when");
});

/**
 * "Core" is still the name in the files, and every survey carries `why`
 * strings written before the rename. Renaming them as they are rendered means
 * the next render is enough; nothing has to recompute its Recs first.
 */
test("a why string written before the rename still reads as your list", () => {
  const recs = [{ id: "a", title: "Old", score: 5, why: "cited by 4 in Core" }];
  const block = renderSurvey({ config: { title: "T", description: "" }, core: [], recs });
  assert.match(block, /cited by 4 in your list/);
  assert.doesNotMatch(block, /in Core/);
});

test("with nothing reserved, Recs are still shown by score", () => {
  const recs = [
    { id: "low", title: "Low", score: 2, why: "cites 2 in Core" },
    { id: "high", title: "High", score: 100, why: "cited by 9 in Core" },
  ];
  const block = renderSurvey({ config: { title: "T", description: "" }, core: [], recs });
  assert.ok(block.indexOf("High") < block.indexOf("Low"));
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
  assert.equal(resolveIdentity({ title: "Chosen" }, event, "").title, "Chosen");
  assert.equal(resolveIdentity({ title: "  " }, event, "").title, "Numeracy in NLP");
  assert.equal(resolveIdentity({}, event, "").description, "About numbers");
  assert.equal(resolveIdentity({}, null, "").title, "My Living Survey");
});

/**
 * A scheduled run carries no event payload, so the title used to fall back to
 * "My Living Survey" on exactly the days nobody pushed -- renaming the survey
 * every night and renaming it back on the next push.
 */
test("a run with no event still knows the repository it is in", () => {
  assert.equal(resolveIdentity({}, null, "someone/numeracy-in-nlp").title, "Numeracy in NLP");
  assert.equal(resolveIdentity({ title: "Chosen" }, null, "someone/numeracy-in-nlp").title, "Chosen");
});

// ---- Author and affiliation signals -----------------------------------

test("the top two authors by h-index are named, not the first two", () => {
  const authors = [
    { name: "First Author", hIndex: 3, affiliations: ["Small College"] },
    { name: "Senior Author", hIndex: 63, affiliations: ["UC Irvine"] },
    { name: "Middle Author", hIndex: 50, affiliations: ["UC Irvine"] },
  ];
  assert.deepEqual(topAuthorsOf(authors), [
    { name: "Senior Author", hIndex: 63, authorId: null },
    { name: "Middle Author", hIndex: 50, authorId: null },
  ]);
});

test("an author with no h-index is left out rather than counted as zero", () => {
  assert.deepEqual(topAuthorsOf([{ name: "Unknown" }, { name: "Known", hIndex: 5 }]), [
    { name: "Known", hIndex: 5, authorId: null },
  ]);
  assert.deepEqual(topAuthorsOf([]), []);
  assert.deepEqual(topAuthorsOf(undefined), []);
});

test("the affiliation most of the authors share wins", () => {
  const authors = [
    { name: "A", hIndex: 5, affiliations: ["MIT"] },
    { name: "B", hIndex: 4, affiliations: ["Google"] },
    { name: "C", hIndex: 3, affiliations: ["Google"] },
  ];
  assert.deepEqual(affiliationsOf(authors), ["Google", "MIT"]);
});

/**
 * One author each at two places is the common case on a two-author paper, and
 * the established one is the more informative answer.
 */
test("a tie on count is broken by the more established author", () => {
  const authors = [
    { name: "Junior", hIndex: 2, affiliations: ["Somewhere"] },
    { name: "Senior", hIndex: 60, affiliations: ["Anthropic"] },
  ];
  assert.equal(affiliationsOf(authors)[0], "Anthropic");
});

test("missing affiliations are absent, not empty strings", () => {
  assert.deepEqual(affiliationsOf([{ name: "A", hIndex: 1, affiliations: [] }]), []);
  assert.deepEqual(affiliationsOf([{ name: "A", hIndex: 1, affiliations: ["  "] }]), []);
});

test("both columns say so when a paper carries neither signal", () => {
  const [, , row] = renderTable({ rows: [rec({ topAuthors: [], affiliations: [] })], list: "core" });
  const cells = row.split("|").map((c) => c.trim());
  assert.ok(cells.includes("-"), "an empty column reads as a dash, not a blank cell");
});

test("the author column carries the h-index that justifies it", () => {
  const [, , row] = renderTable({
    rows: [rec({ topAuthors: [{ name: "Sameer Singh", hIndex: 63, authorId: "34650964" }], affiliations: ["UC Irvine"] })],
    list: "core",
  });
  assert.match(row, /\[Sameer Singh\]\(https:\/\/www\.semanticscholar\.org\/author\/Sameer-Singh\/34650964\)/);
  assert.match(row, /\(h=63\)/);
  assert.match(row, /UC Irvine/, "affiliations stay plain: S2 has no page for an institution");
  assert.doesNotMatch(row, /\[UC Irvine\]\(/);
});

test("an author with no id is named but not linked", () => {
  const [, , row] = renderTable({
    rows: [rec({ topAuthors: [{ name: "No Id", hIndex: 4, authorId: null }] })],
    list: "core",
  });
  assert.match(row, /No Id \(h=4\)/);
  assert.doesNotMatch(row, /semanticscholar\.org\/author/);
});

test("one author cannot fill both affiliation slots with their own employers", () => {
  const authors = [
    { name: "Senior", hIndex: 63, affiliations: ["UC Irvine", "A Startup"] },
    { name: "Other", hIndex: 50, affiliations: ["Allen Institute"] },
  ];
  assert.deepEqual(affiliationsOf(authors), ["UC Irvine", "Allen Institute"]);
});

test("but a lone author's second affiliation still beats an empty slot", () => {
  const authors = [{ name: "Solo", hIndex: 20, affiliations: ["MIT", "DeepMind"] }];
  assert.deepEqual(affiliationsOf(authors), ["MIT", "DeepMind"]);
});
