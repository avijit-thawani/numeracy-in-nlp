import { log } from "./log.js";

/**
 * Sorting, without a website.
 *
 * GitHub renders markdown but runs no JavaScript, so a table cannot be sorted
 * in the browser. Instead every sort order is rendered ahead of time into its
 * own file under `views/`, and a line under each table links to the others.
 *
 * Those links used to live on the column headings, which was neat until the
 * columns themselves went: Venue, Year and Cited by were four narrow columns
 * of mostly-short values that pushed the two columns anyone reads -- the paper
 * and why it is here -- into a horizontal scroll. They are now one stacked
 * cell, and the sort links moved under the table where they are legible.
 *
 * `core` stays the internal name, in filenames and in data/core.json, because
 * renaming those is a migration every existing survey would have to run. What
 * a reader sees is "your list".
 */

export const LISTS = {
  core: { title: "Your list", blurb: "The papers you have." },
  recs: { title: "Recs", blurb: "Papers suggested automatically from the citation graph." },
};

// Each sort gets a file suffix, a heading, and a comparator.
export const SORTS = {
  score: { label: "Score", cmp: (a, b) => (b.score ?? 0) - (a.score ?? 0) },
  year: { label: "Year", cmp: (a, b) => (b.year ?? 0) - (a.year ?? 0) },
  citations: { label: "Cited by", cmp: (a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0) },
  title: { label: "Paper", cmp: (a, b) => String(a.title).localeCompare(String(b.title)) },
};

const DESC_MARK = "&#9660;"; // a small down triangle, since these sorts are descending
const ASC_MARK = "&#9650;";

const cell = (value) =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim() || "-";

const authorList = (authors) => {
  const names = authors ?? [];
  if (!names.length) return "-";
  return names.length <= 3 ? names.join(", ") : `${names[0]} et al.`;
};

export const viewFile = (list, sort) => `views/${list}-by-${sort}.md`;

/**
 * The Decide cell: how to accept or reject one Rec without editing a file.
 *
 * When a pull request exists, that is the richest option: its page carries a
 * real Merge and Close button. Only the top few get one, so every other row
 * falls back to links that open a prefilled issue, which the existing issue
 * pipeline already ingests. Those need no repository settings and no extra
 * permissions, so every row is actionable even where pull requests are off.
 */
const decideCell = (rec, repo, survey = "") => {
  if (rec.prUrl) return `[review #${rec.prNumber}](${rec.prUrl})`;
  if (!repo) return "-";

  const link = rec.arxivId
    ? `https://arxiv.org/abs/${rec.arxivId}`
    : rec.doi
      ? `https://doi.org/${rec.doi}`
      : (rec.url ?? "");

  // One repository can hold several surveys but has only one issue tracker, so
  // the body has to say which one this is about. Omitted for a repo with a
  // single survey, where it would be noise in every issue anyone opens.
  const which = survey && survey !== "." ? `survey: ${survey}\n\n` : "";

  const add =
    `https://github.com/${repo}/issues/new?labels=add-paper` +
    `&title=${encodeURIComponent(`Add paper: ${rec.title}`.slice(0, 90))}` +
    `&body=${encodeURIComponent(`${which}${link}`)}`;

  const drop =
    `https://github.com/${repo}/issues/new?labels=drop-paper` +
    `&title=${encodeURIComponent(`Drop paper: ${rec.title}`.slice(0, 90))}` +
    `&body=${encodeURIComponent(`${rec.id}\n\n${which}`.trim())}`;

  return `[add](${add}) · [drop](${drop})`;
};

/**
 * Everything about a paper that is not its title: year, venue, how often it
 * has been cited, and how it connects to your list.
 *
 * One stacked cell rather than four columns. The values are short and of very
 * different widths, so as columns they cost more space in headings and padding
 * than they do in content -- and the Why value, the one that answers "why am I
 * being shown this?", ended up furthest right where a narrow window hides it.
 */
const detailCell = (p, showWhy) => {
  const cited = p.citationCount ?? 0;
  const lines = [
    [p.year ?? "-", p.venue ? cell(p.venue) : null].filter(Boolean).join(" · "),
    `${cited} ${cited === 1 ? "citation" : "citations"}`,
  ];
  // For anything published this month this is the whole signal: it cannot have
  // been cited yet, so how it connects to your list is all there is to go on.
  // Surveys carry `why` strings written by earlier runs, which said "Core".
  // Renaming on the way out means a rename shows up on the next render rather
  // than waiting for every survey to recompute its Recs.
  if (showWhy && p.why) lines.push(`**${cell(p.why).replace(/\bin Core\b/g, "in your list")}**`);
  return lines.map((l) => `<sub>${l}</sub>`).join("<br>");
};

/**
 * One table: the paper, the details stack, its Score, and how to act on it.
 */
export const renderTable = ({ rows, list, showWhy = false, startIndex = 1, repo = "", survey = "" }) => {
  if (!rows.length) {
    return list === "core"
      ? ["_Nothing in your list yet._ Add papers to [`import/papers.txt`](../import/papers.txt) and commit."]
      : ["_Nothing yet._ Recs appear once several papers in your list share a citing paper, which usually needs around three."];
  }

  const head = showWhy ? "| # | Paper | Details | Score | Decide |" : "| # | Paper | Details | Score |";
  const rule = showWhy ? "| ---: | --- | --- | ---: | --- |" : "| ---: | --- | --- | ---: |";

  const lines = [head, rule];
  rows.forEach((p, i) => {
    const title = p.url ? `[${cell(p.title)}](${p.url})` : cell(p.title);
    const main =
      `| ${startIndex + i} | ${title}<br><sub>${cell(authorList(p.authors))}</sub>` +
      `${p.summary ? `<br><sub>${cell(p.summary)}</sub>` : ""} ` +
      `| ${detailCell(p, showWhy)} | ${Math.round(p.score ?? 0)} |`;
    lines.push(showWhy ? `${main} ${decideCell(p, repo, survey)} |` : main);
  });
  return lines;
};

/** "Sorted by Score. Also by [Year](...) · [Cited by](...)", for under a table. */
export const sortLinks = (list, activeSort, linkPrefix = "") =>
  Object.entries(SORTS)
    .map(([key, { label }]) =>
      key === activeSort ? `**${label}** ${key === "title" ? ASC_MARK : DESC_MARK}` : `[${label}](${linkPrefix}${list}-by-${key}.md)`
    )
    .join(" · ");

/** A standalone `views/<list>-by-<sort>.md` file. */
export const renderView = ({ list, sort, rows, config, repo = "", survey = "" }) => {
  const meta = LISTS[list];
  const other = list === "core" ? "recs" : "core";

  return [
    `# ${config.title}: ${meta.title}`,
    "",
    meta.blurb,
    "",
    `**${rows.length}** ${rows.length === 1 ? "paper" : "papers"}. Sorted by ${sortLinks(list, sort)}.`,
    "",
    ...renderTable({ rows, list, showWhy: list === "recs", repo, survey }),
    "",
    "---",
    "",
    `[Back to the survey](../README.md) · [${LISTS[other].title}](${other}-by-score.md)`,
    "",
    "<sub>Generated, and rewritten on every update. Edit [`import/papers.txt`](../import/papers.txt), not this file.</sub>",
  ].join("\n");
};

/** Writes every combination of list and sort. */
export const allViews = ({ core, recs, config, repo = "", survey = "" }) => {
  const files = [];
  for (const [list, rows] of [
    ["core", core],
    ["recs", recs],
  ]) {
    for (const sort of Object.keys(SORTS)) {
      const sorted = [...rows].sort(SORTS[sort].cmp);
      files.push({
        path: viewFile(list, sort),
        body: `${renderView({ list, sort, rows: sorted, config, repo, survey })}\n`,
      });
    }
  }
  log.info(`Wrote ${files.length} sorted view files.`);
  return files;
};
