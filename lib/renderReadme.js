import { log } from "./log.js";
import { renderTable, viewFile } from "./views.js";

export const SURVEY_START = "<!-- SURVEY:START -->";
export const SURVEY_END = "<!-- SURVEY:END -->";
export const INTRO_START = "<!-- TEMPLATE-INTRO:START -->";
export const INTRO_END = "<!-- TEMPLATE-INTRO:END -->";
export const FOOTER_START = "<!-- TEMPLATE-FOOTER:START -->";
export const FOOTER_END = "<!-- TEMPLATE-FOOTER:END -->";

/** Makes a string safe to drop inside a markdown table cell. */
const cell = (value) =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim() || "-";

const authorList = (authors) => {
  const names = authors ?? [];
  if (!names.length) return "-";
  if (names.length <= 3) return names.join(", ");
  return `${names[0]} et al.`;
};

const titleCell = (paper) => {
  const text = cell(paper.title);
  return paper.url ? `[${text}](${paper.url})` : text;
};

/**
 * A short legend, placed above the tables rather than below them, so the
 * columns are explained before they are read.
 */
const legend = (coreCount, preview) => [
  "> **How to read this page.**",
  `> **Core** is what this survey contains; **Recs** is what to read next, found automatically by following citations. Only the top ${preview} of each is shown here, linked to the full lists.`,
  "> **Score** is 0 to 100 and says how tied into this survey a paper is, relative to the most connected one in its own list. It drives the default order.",
  "> In Recs, **Why** says how a paper turned up: *cites N here*, newer work building on N of these; *cited by N here*, older work N of these rest on; *from ...*, the bibliography of a survey used as a seed.",
  "> Column headings are links: click one to open the same list sorted that way.",
];

/**
 * The generated section of the README.
 *
 * Both lists are truncated here. The README is the front page, so it shows the
 * most connected handful of each and links to the full sorted views rather
 * than printing hundreds of rows nobody scrolls through.
 */
export const renderSurvey = ({ config, core, recs, preview = 10 }) => {
  const updated = new Date().toISOString().slice(0, 10);
  const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0);

  const coreSorted = [...core].sort(byScore);
  const recsSorted = [...recs].sort(byScore);

  const section = (list, rows, heading, note) => {
    const shown = rows.slice(0, preview);
    const rest = rows.length - shown.length;
    const out = [
      heading,
      "",
      note,
      "",
      ...renderTable({ rows: shown, list, sort: "score", linkPrefix: "views/", showWhy: list === "recs" }),
    ];
    if (rest > 0) {
      out.push(
        "",
        `[... and ${rest} more, sorted by score](${viewFile(list, "score")})`
      );
    }
    return out;
  };

  const counts = [
    `**${core.length}** in Core`,
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
    ...legend(core.length, preview),
    "",
    ...section(
      "core",
      coreSorted,
      "## Core",
      "The papers in this survey."
    ),
    "",
    ...section(
      "recs",
      recsSorted,
      "## ✨ Recs",
      "<sub>Found by following the citation graph, not picked by hand. Refreshed daily. To accept one, paste its link into [`import/papers.txt`](import/papers.txt) and commit.</sub>"
    ),
    "",
    SURVEY_END,
  ].join("\n");
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
