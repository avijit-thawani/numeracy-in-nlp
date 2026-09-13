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
 * The generated section of the README.
 *
 * Both lists are truncated here. The README is the front page, so it shows the
 * most connected handful of each and links to the full sorted views rather
 * than printing hundreds of rows nobody scrolls through.
 */
export const renderSurvey = ({ config, core, recs, preview = 10, repo = "" }) => {
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
      ...renderTable({ rows: shown, list, sort: "score", linkPrefix: "views/", showWhy: list === "recs", repo }),
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
    `the tables above up to date. No hosting, no API keys. See **[SETUP.md](${SETUP_URL})**.`,
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
