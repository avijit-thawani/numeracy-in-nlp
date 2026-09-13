import { log } from "./log.js";

/**
 * Sorting, without a website.
 *
 * GitHub renders markdown but runs no JavaScript, so a table cannot be sorted
 * in the browser. Instead every sort order is rendered ahead of time into its
 * own file under `views/`, and each column heading links to the file sorted by
 * that column. The active column is marked rather than linked. Clicking around
 * the headings then behaves like sorting a table, using nothing but static
 * files GitHub already knows how to display.
 */

export const LISTS = {
  core: { title: "Core", blurb: "Papers in this survey." },
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
 * Builds the header row. Every column except the active one is a link to the
 * file sorted that way; `linkPrefix` lets the README point into `views/` while
 * the view files point at each other.
 */
const header = (list, activeSort, linkPrefix, columns) => {
  const cells = columns.map((key) => {
    const { label } = SORTS[key];
    if (key === activeSort) {
      return `${label} ${key === "title" ? ASC_MARK : DESC_MARK}`;
    }
    return `[${label}](${linkPrefix}${list}-by-${key}.md)`;
  });
  return cells;
};

/**
 * One table. `columns` names the sortable columns in display order; Venue and
 * Why are not sortable and are placed by hand.
 */
export const renderTable = ({ rows, list, sort, linkPrefix = "", showWhy = false, startIndex = 1, repo = "", survey = "" }) => {
  if (!rows.length) {
    return list === "core"
      ? ["_Nothing in Core yet._ Add papers to [`import/papers.txt`](../import/papers.txt) and commit."]
      : ["_Nothing yet._ Recs appear once several papers in Core share a citing paper, which usually needs around ten."];
  }

  const sortable = ["title", "year", "citations", "score"];
  const [hTitle, hYear, hCited, hScore] = header(list, sort, linkPrefix, sortable);

  const head = showWhy
    ? `| # | ${hTitle} | Venue | ${hYear} | ${hCited} | ${hScore} | Why | Decide |`
    : `| # | ${hTitle} | Venue | ${hYear} | ${hCited} | ${hScore} |`;
  const rule = showWhy
    ? "| ---: | --- | --- | ---: | ---: | ---: | --- | --- |"
    : "| ---: | --- | --- | ---: | ---: | ---: |";

  const lines = [head, rule];
  rows.forEach((p, i) => {
    const title = p.url ? `[${cell(p.title)}](${p.url})` : cell(p.title);
    const main =
      `| ${startIndex + i} | ${title}<br><sub>${cell(authorList(p.authors))}</sub>` +
      `${p.summary ? `<br><sub>${cell(p.summary)}</sub>` : ""} ` +
      `| ${cell(p.venue)} | ${p.year ?? "-"} | ${p.citationCount ?? 0} | ${Math.round(p.score ?? 0)} |`;
    // `main` already ends with the closing pipe of the Score cell, so the Why
    // cell is simply appended. Trimming that pipe first, as this once did,
    // merged Score and Why into a single cell and left the table one column
    // short of its header, which markdown renders as an empty last column.
    lines.push(showWhy ? `${main} ${cell(p.why)} | ${decideCell(p, repo, survey)} |` : main);
  });
  return lines;
};

/** A standalone `views/<list>-by-<sort>.md` file. */
export const renderView = ({ list, sort, rows, config, repo = "", survey = "" }) => {
  const meta = LISTS[list];
  const other = list === "core" ? "recs" : "core";

  return [
    `# ${config.title}: ${meta.title}`,
    "",
    meta.blurb,
    "",
    `**${rows.length}** ${rows.length === 1 ? "paper" : "papers"}, sorted by **${SORTS[sort].label}**. Click any other column heading to sort by it.`,
    "",
    ...renderTable({ rows, list, sort, showWhy: list === "recs", repo, survey }),
    "",
    "---",
    "",
    `[Back to the survey](../README.md) · [${LISTS[other].title} list](${other}-by-score.md)`,
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
