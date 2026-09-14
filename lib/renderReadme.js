import { log } from "./log.js";
import { renderTable } from "./views.js";

export const SURVEY_START = "<!-- SURVEY:START -->";
export const SURVEY_END = "<!-- SURVEY:END -->";
export const INTRO_START = "<!-- TEMPLATE-INTRO:START -->";
export const INTRO_END = "<!-- TEMPLATE-INTRO:END -->";
export const FOOTER_START = "<!-- TEMPLATE-FOOTER:START -->";
export const FOOTER_END = "<!-- TEMPLATE-FOOTER:END -->";

// Cell escaping, author lists and title links all live in views.js, which is
// what actually renders the rows here. This file used to carry a second copy
// of each, reachable only from a titleCell nothing called -- so a fix to one
// copy would silently not apply to the tables.


/**
 * The generated section of the README.
 *
 * Both lists are truncated here. The README is the front page, so it shows the
 * most connected handful of each and links to the full sorted views rather
 * than printing hundreds of rows nobody scrolls through.
 */
/**
 * The bulk line above a table: edit the list, then merge.
 *
 * The first link goes to GitHub's editor for the branch's `import/papers.txt`,
 * not to the pull request. Deciding on a table means deleting the lines you do
 * not want, and the pull request page is one click away from the file where
 * that happens -- so it opens on the file, and the merge link follows for when
 * the editing is done. Falls back to the pull request alone when the branch is
 * not known, which is any survey rendered before this was recorded.
 */
const bulkLine = (rows, { repo, survey }) => {
  const batch = rows.find((r) => r.batchPrUrl);
  if (!batch) return null;

  const path = survey && survey !== "." ? `${survey}/import/papers.txt` : "import/papers.txt";
  const edit = repo && batch.batchBranch ? `https://github.com/${repo}/edit/${batch.batchBranch}/${path}` : null;
  const merge = batch.batchPrNumber ? `[merge #${batch.batchPrNumber}](${batch.batchPrUrl})` : `[merge](${batch.batchPrUrl})`;

  return edit
    ? `<sub>**[Review all ${rows.length} in one file →](${edit})** Delete the lines you do not want, commit, then ${merge}.</sub>`
    : `<sub>**[Review all ${rows.length} in one pull request →](${batch.batchPrUrl})** Delete the lines you do not want, then merge.</sub>`;
};

// Points at the Decide column rather than at papers.txt. Telling people to
// paste a link by hand described the longhand the column replaced, four lines
// below a column offering to do it for them.
const RECS_NOTE =
  "<sub>Found by following the citation graph — a deterministic algorithm you can tune, not an LLM. " +
  "Refreshed daily. Use the **Decide** column to accept or reject one.</sub>";

// Every sort a list is rendered in, as it appears under the table.
const SORT_LINKS = [
  ["score", "Score"],
  ["year", "Year"],
  ["citations", "Cited by"],
  ["title", "Title"],
];

/**
 * The line under a table: how many rows were left out, and where to see them.
 *
 * The count is plain text rather than the link it used to be. As a link it
 * read as the *only* thing to click, so "... and 603 more, sorted by score"
 * became the single blue phrase under a five-row table -- while the four sort
 * orders that already exist as files went unmentioned. Saying the number in
 * black and then offering every sort puts the choice where it belongs.
 */
const moreLine = (list, hidden, linkPrefix = "") => {
  const links = SORT_LINKS.map(([sort, label]) => `[${label}](${linkPrefix}${list}-by-${sort}.md)`).join(" · ");
  const counted = hidden > 0 ? `… and ${hidden} more. ` : "";
  return `<sub>${counted}View all, sorted by ${links}.</sub>`;
};

export const renderSurvey = ({ config, core, recs, preview = 5, repo = "", survey = "" }) => {
  const updated = new Date().toISOString().slice(0, 10);
  const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0);

  const coreSorted = [...core].sort(byScore);

  // Recs arrive in the order the ranking decided, which is not score order
  // once the recency windows have reserved the top slots. Re-sorting by score
  // here undid that silently: the reserved papers scattered back through the
  // table, and because a month-old paper scores low by construction, most of
  // them fell past the preview and off the front page entirely -- so the
  // feature looked like it had not run at all. Only fall back to sorting when
  // nothing claimed a slot.
  const recsSorted = recs.some((r) => r.freshWindow) ? [...recs] : [...recs].sort(byScore);

  const section = (list, rows, heading, note) => {
    const shown = rows.slice(0, preview);
    return [
      heading,
      "",
      note,
      "",
      ...renderTable({ rows: shown, list, sort: "score", linkPrefix: "views/", showWhy: list === "recs", repo, survey }),
      "",
      moreLine(list, rows.length - shown.length, "views/"),
    ];
  };

  /**
   * Recs, split by how recent they are.
   *
   * One table with the window written into the Why column was technically
   * correct and practically invisible: Why is the second-to-last column of a
   * table wide enough to need scrolling, so "the best thing published this
   * month" looked like row four of twenty-five. A reader asking "what is new?"
   * should not have to read a column to find out, so each window gets its own
   * table under its own heading.
   *
   * The window headings already say how recent the papers are, so the Why cell
   * drops the prefix it would otherwise repeat in every row.
   */
  const recsSections = (rows) => {
    const windows = [...new Set(rows.map((r) => r.freshWindow).filter(Boolean))];
    if (!windows.length) {
      return section("recs", rows, "## ✨ Recs", RECS_NOTE);
    }

    const out = ["## ✨ Recs", "", RECS_NOTE, ""];

    for (const label of windows) {
      const inWindow = rows
        .filter((r) => r.freshWindow === label)
        .map((r) => ({ ...r, why: String(r.why ?? "").replace(/^[^·]+·\s*/, "") }));

      // One pull request holds this whole table, so a reader can accept the
      // lot in one go instead of clicking five links. Offered above the table
      // because it is the quicker path, not a footnote to the slow one.
      const bulk = bulkLine(inWindow, { repo, survey });

      out.push(
        `### New in the ${label}`,
        "",
        ...(bulk ? [bulk, ""] : []),
        ...renderTable({
          rows: inWindow.slice(0, preview),
          list: "recs",
          sort: "score",
          linkPrefix: "views/",
          showWhy: true,
          repo,
          survey,
        }),
        "",
        moreLine("recs", inWindow.length - Math.min(inWindow.length, preview), "views/"),
        ""
      );
    }

    const rest = rows.filter((r) => !r.freshWindow);
    if (rest.length) {
      const bulk = bulkLine(rest, { repo, survey });
      out.push(
        "### Most connected, any year",
        "",
        ...(bulk ? [bulk, ""] : []),
        ...renderTable({ rows: rest.slice(0, preview), list: "recs", sort: "score", linkPrefix: "views/", showWhy: true, repo, survey }),
        "",
        moreLine("recs", rest.length - Math.min(rest.length, preview), "views/")
      );
    }
    return out;
  };

  const counts = [
    `**${core.length}** in your list`,
    recs.length ? `**${recs.length}** Recs` : null,
    `updated ${updated}`,
  ].filter(Boolean);

  return [
    SURVEY_START,
    "",
    `# ${config.title}`,
    "",
    config.description,
    "",
    counts.join(" · "),
    "",
    // Recs first. The papers you already have are the least useful thing on
    // your own front page -- you know them, you chose them -- while what to
    // read next is the reason to open it at all, and it used to sit below a
    // table of everything you had already read.
    ...recsSections(recsSorted),
    "",
    ...section(
      "core",
      coreSorted,
      "## Your list",
      "The papers this survey is built from."
    ),
    "",
    SURVEY_END,
  ].join("\n");
};

// The one canonical copy of the instructions. Every survey links here rather
// than carrying its own copy, so there is nothing to keep in step.
const SETUP_URL = "https://github.com/avijit-thawani/living-survey/blob/main/SETUP.md";

/**
 * The "want your own" footer, rewritten on every run.
 *
 * It used to be written once and then left alone, which meant a survey created
 * months ago still advertised whatever the instructions said back then. Now it
 * is generated like everything else.
 */
export const renderFooter = () =>
  [
    FOOTER_START,
    "",
    "### Want your own living survey?",
    "",
    "Click **Use this template**, add your papers, and a daily GitHub Action keeps",
    "the tables above up to date. Everything lives in your own repo — no website, no",
    "backend, no database, no API keys — and the Recs come from a citation graph",
    `algorithm you can tune, not from an LLM. See **[SETUP.md](${SETUP_URL})**.`,
    "",
    FOOTER_END,
  ].join("\n");

/** Swaps in a freshly generated footer, adding one if the survey has none. */
export const applyFooter = (readme, footerBlock) => {
  const text = readme ?? "";
  const start = text.indexOf(FOOTER_START);
  const end = text.indexOf(FOOTER_END);

  if (start === -1 || end === -1 || end < start) {
    return `${text.trimEnd()}\n\n---\n\n${footerBlock}\n`;
  }
  return `${text.slice(0, start)}${footerBlock}${text.slice(end + FOOTER_END.length)}`;
};

/**
 * Replaces only the marked region, so anything a maintainer writes outside the
 * markers (their own prose, notes, the template footer) survives every run.
 */
export const applySurvey = (existingReadme, surveyBlock) => {
  const text = existingReadme ?? "";
  const start = text.indexOf(SURVEY_START);
  const end = text.indexOf(SURVEY_END);

  if (start === -1 || end === -1 || end < start) {
    log.warn(
      "README markers were missing, so the survey was prepended. Keep the SURVEY:START/END comments intact to control where it goes."
    );
    return `${surveyBlock}\n\n${text}`.trimEnd() + "\n";
  }

  const before = text.slice(0, start);
  const after = text.slice(end + SURVEY_END.length);
  return `${before}${surveyBlock}${after}`.trimEnd() + "\n";
};

export const INDEX_START = "<!-- SURVEYS:START -->";
export const INDEX_END = "<!-- SURVEYS:END -->";

/**
 * The table of contents for a repository that holds several surveys.
 *
 * Written only between markers the owner puts in their own README, so the rest
 * of that page -- which is the one page a repository like this has to sell
 * itself with -- stays hand-written. No markers, no index: the alternative is
 * a generator that overwrites somebody's front page the first time they add a
 * second survey.
 */
export const renderIndexBlock = (surveys) => {
  const rows = surveys.map(({ name, title, description, core, recs, updated }) => {
    const label = title || name;
    const detail = [description, `**${core}** in your list`, recs ? `**${recs}** Recs` : null]
      .filter(Boolean)
      .join(" · ");
    return `| [${label}](${name}/) | ${detail.replace(/\|/g, "\\|")} | ${updated ?? "-"} |`;
  });

  return [
    INDEX_START,
    "",
    "| Survey | What is in it | Updated |",
    "| --- | --- | --- |",
    ...rows,
    "",
    INDEX_END,
  ].join("\n");
};

/** Swaps in a freshly generated index, leaving a README with no markers alone. */
export const applyIndex = (readme, block) => {
  const text = readme ?? "";
  const start = text.indexOf(INDEX_START);
  const end = text.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) return null;
  return `${text.slice(0, start)}${block}${text.slice(end + INDEX_END.length)}`;
};

/** CSV export, mirroring the columns the original project produced. */
export const renderCsv = (papers) => {
  const fields = [
    "id",
    "title",
    "authors",
    "venue",
    "year",
    "citationCount",
    "referenceCount",
    "influentialCitationCount",
    "doi",
    "url",
  ];
  const escape = (v) => {
    const s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    fields.join(","),
    ...papers.map((p) => fields.map((f) => escape(p[f])).join(",")),
  ].join("\n");
};
