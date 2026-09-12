import { log } from "./log.js";

export const SURVEY_START = "<!-- SURVEY:START -->";
export const SURVEY_END = "<!-- SURVEY:END -->";
export const FOOTER_START = "<!-- TEMPLATE-FOOTER:START -->";
export const FOOTER_END = "<!-- TEMPLATE-FOOTER:END -->";

/** Makes a string safe to drop inside a markdown table cell. */
const cell = (value) =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim() || "—";

const authorList = (authors) => {
  const names = authors ?? [];
  if (!names.length) return "—";
  if (names.length <= 3) return names.join(", ");
  return `${names[0]} et al.`;
};

const titleCell = (paper) => {
  const text = cell(paper.title);
  return paper.url ? `[${text}](${paper.url})` : text;
};

const sortPapers = (papers, sortBy) => {
  const copy = [...papers];
  if (sortBy === "citations") {
    copy.sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
  } else if (sortBy === "title") {
    copy.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } else if (sortBy === "added") {
    copy.sort((a, b) => String(b.addedAt ?? "").localeCompare(String(a.addedAt ?? "")));
  } else {
    // Default: newest research first, which is what a survey reader wants.
    copy.sort(
      (a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.citationCount ?? 0) - (a.citationCount ?? 0)
    );
  }
  return copy;
};

const papersTable = (papers) => {
  if (!papers.length) {
    return [
      "_No papers yet._ Add some links to [`papers.txt`](papers.txt) and commit — the table below fills itself in.",
    ];
  }

  const lines = [
    "| # | Paper | Venue | Year | Cited by |",
    "| ---: | --- | --- | ---: | ---: |",
  ];
  papers.forEach((p, i) => {
    lines.push(
      `| ${i + 1} | ${titleCell(p)}<br><sub>${cell(authorList(p.authors))}</sub>` +
        `${p.summary ? `<br><sub>${cell(p.summary)}</sub>` : ""} ` +
        `| ${cell(p.venue)} | ${p.year ?? "—"} | ${p.citationCount ?? 0} |`
    );
  });
  return lines;
};

const candidatesTable = (candidates) => {
  if (!candidates.length) {
    return [
      "_None yet._ Suggestions appear once several papers in the survey share a citing paper.",
    ];
  }

  const lines = [
    "| Paper | Venue | Year | Cited by | Overlap |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  for (const p of candidates) {
    lines.push(
      `| ${titleCell(p)}<br><sub>${cell(authorList(p.authors))}</sub> ` +
        `| ${cell(p.venue)} | ${p.year ?? "—"} | ${p.citationCount ?? 0} | ${p.overlap} |`
    );
  }
  lines.push(
    "",
    "<sub>**Overlap** is how many papers already in this survey are cited by that paper — higher means more central to this topic.</sub>",
    "",
    "To add any of these, paste its link into [`papers.txt`](papers.txt) and commit."
  );
  return lines;
};

/** Builds the generated section of the README. */
export const renderSurvey = ({ config, papers, candidates }) => {
  const sorted = sortPapers(papers, config.sortBy);
  const updated = new Date().toISOString().slice(0, 10);

  return [
    SURVEY_START,
    "",
    `# ${config.title}`,
    "",
    config.description,
    "",
    `**${papers.length}** paper${papers.length === 1 ? "" : "s"} · last updated ${updated}`,
    "",
    "## Papers",
    "",
    ...papersTable(sorted),
    "",
    "## Suggested next reads",
    "",
    ...candidatesTable(candidates),
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
