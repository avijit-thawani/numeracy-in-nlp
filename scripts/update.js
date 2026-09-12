import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log, writeSummary } from "../lib/log.js";
import { resolveAll, resolveIdentifier } from "../lib/resolve.js";
import { fetchPapers, fetchReferences, matchByTitle } from "../lib/semanticScholar.js";
import { fetchPapersFallback } from "../lib/openalex.js";
import { buildCandidates } from "../lib/candidates.js";
import { parseBibliography } from "../lib/bibliography.js";
import { renderSurvey, applySurvey, renderCsv } from "../lib/renderReadme.js";
import { resolveIdentity, lookupOwnerEmail } from "../lib/identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => join(ROOT, ...parts);

const readJson = (path, fallback) => {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    log.warn(`Could not read ${path} (${err.message}); starting from defaults.`);
    return fallback;
  }
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/**
 * When the workflow is triggered by someone opening an "Add a paper" issue,
 * pull any links out of the issue body so they get ingested like any other
 * seed link.
 */
const linksFromIssue = () => {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (process.env.GITHUB_EVENT_NAME !== "issues" || !eventPath) return [];

  const event = readJson(eventPath, null);
  const issue = event?.issue;
  if (!issue) return [];

  // Match on either the label or the title prefix. Labels are repository
  // settings rather than files, so "Use this template" does not copy them --
  // gating on the label alone would silently never fire in a fresh survey.
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
  const looksLikeRequest =
    labels.includes("add-paper") || /^add paper:/i.test(String(issue.title ?? ""));

  if (!looksLikeRequest) {
    log.info(`Issue #${issue.number} is not a paper request; ignoring it.`);
    return [];
  }

  const found = String(issue.body ?? "").match(/(https?:\/\/\S+|\b10\.\d{4,9}\/\S+)/g) ?? [];
  const cleaned = found.map((s) => s.replace(/[.,)\]]+$/, ""));
  log.info(`Issue #${issue.number} contributed ${cleaned.length} link(s).`);
  return cleaned;
};

/**
 * The template ships with a small demo survey so its own page shows something
 * real. A repo created from the template inherits that demo, which is not what
 * anyone wants their survey to start as. The first run in a fresh repo clears
 * it automatically, so nobody has to know to delete someone else's papers.
 *
 * Keyed off a marker file rather than the repo name, so cloning or renaming
 * behaves predictably.
 */
const clearDemoIfInherited = () => {
  const marker = p(".demo-survey");
  if (!existsSync(marker)) return false;

  const meta = readJson(marker, null);
  if (!meta?.repo) {
    log.warn("The .demo-survey marker is unreadable; leaving your data alone.");
    return false;
  }

  // Still running in the template repo itself: keep the demo.
  const here = process.env.GITHUB_REPOSITORY ?? "";
  if (here && here === meta.repo) {
    log.debug("Running in the template repo; keeping the demo survey.");
    return false;
  }
  if (!here) {
    log.debug("No GITHUB_REPOSITORY set (local run); keeping the demo survey.");
    return false;
  }

  // The marker can come back -- a rebase or a revert will happily restore a
  // deleted file -- so never decide to destroy data on its presence alone.
  // Only clear when what is on disk is still exactly the untouched demo.
  const current = readJson(p("data/papers.json"), { papers: [] }).papers ?? [];
  const demoIds = new Set(meta.paperIds ?? []);
  const ownPapers = current.filter((x) => !demoIds.has(x.id));

  if (ownPapers.length) {
    log.info(
      `Found ${ownPapers.length} paper(s) of your own, so the demo has already been cleared. Removing the marker.`
    );
    rmSync(marker);
    return false;
  }

  log.step("First run in a new survey: clearing the template's demo papers");
  writeJson(p("data/papers.json"), { papers: [] });
  writeJson(p("data/candidates.json"), { candidates: [] });
  writeFileSync(p("data/papers.csv"), "", "utf8");

  // Blank the demo's title rather than substituting a placeholder: an empty
  // title makes the survey fall back to the repository name and description,
  // which the owner already chose when they created the repo.
  const config = readJson(p("survey.config.json"), {});
  if (config.title === meta.title) {
    writeJson(p("survey.config.json"), { ...config, title: "", description: "" });
  }

  rmSync(marker);
  log.info("Demo cleared. Your papers from papers.txt are being added now.");
  return true;
};

/**
 * Reads any .bib or .ris files dropped in `import/` and turns them into
 * lookups. These land in the survey itself rather than in suggestions: a
 * bibliography export is the owner's own library, already curated.
 */
const readBibliographies = async () => {
  const dir = p("import");
  if (!existsSync(dir)) return { requests: [], files: [] };

  const files = readdirSync(dir).filter((f) => /\.(bib|ris)$/i.test(f));
  if (!files.length) return { requests: [], files: [] };

  const requests = [];
  const needTitleMatch = [];

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const entry of parseBibliography(file, text)) {
      if (entry.id) requests.push({ id: entry.id, source: `${file}: ${entry.title}` });
      else if (entry.url) {
        const id = resolveIdentifier(entry.url);
        if (id) requests.push({ id, source: `${file}: ${entry.title}` });
        else if (entry.title) needTitleMatch.push({ file, title: entry.title });
      } else if (entry.needsTitleMatch) needTitleMatch.push({ file, title: entry.title });
    }
  }

  // Entries with no identifier at all: look them up by title.
  if (needTitleMatch.length) {
    log.info(`Looking up ${needTitleMatch.length} bibliography entr(y/ies) by title.`);
    for (const { file, title } of needTitleMatch) {
      const paperId = await matchByTitle(title);
      if (paperId) requests.push({ id: paperId, source: `${file}: ${title}` });
      else log.warn(`No match for bibliography entry "${title.slice(0, 60)}".`);
    }
  }

  log.stat("papers found in bibliography files", requests.length);
  return { requests, files };
};

const main = async () => {
  const refreshMode = process.argv.includes("--refresh");
  log.step(`Starting update${refreshMode ? " (refresh mode)" : ""}`);

  clearDemoIfInherited();

  const config = readJson(p("survey.config.json"), {});
  const event = process.env.GITHUB_EVENT_PATH
    ? readJson(process.env.GITHUB_EVENT_PATH, null)
    : null;
  const identity = resolveIdentity(config, event);
  const email = await lookupOwnerEmail(config);
  const limit = Number(config.candidateCount) || 25;

  const store = readJson(p("data/papers.json"), { papers: [] });
  let papers = Array.isArray(store.papers) ? store.papers : [];

  // Heal any duplicates that a previous run may have written.
  const byId = new Map();
  for (const paper of papers) if (paper?.id && !byId.has(paper.id)) byId.set(paper.id, paper);
  if (byId.size !== papers.length) {
    log.warn(`Removed ${papers.length - byId.size} duplicate paper(s) from the survey.`);
    papers = [...byId.values()];
  }
  const dismissed = readJson(p("data/dismissed.json"), { ids: [] }).ids ?? [];
  log.stat("papers already in survey", papers.length);

  // ---- Gather new links -------------------------------------------------
  const queueFile = p("papers.txt");
  const queueLines = existsSync(queueFile)
    ? readFileSync(queueFile, "utf8").split(/\r?\n/)
    : [];
  const incoming = [...queueLines, ...linksFromIssue()];

  const { resolved, unresolved, seedFrom } = resolveAll(incoming);

  const bibliography = await readBibliographies();
  const known = new Set(papers.map((x) => x.id));
  const knownSources = new Set(
    papers.flatMap((x) => [x.source, ...(x.aliases ?? [])]).filter(Boolean)
  );
  const toFetch = [...resolved, ...bibliography.requests].filter(
    (r) => !knownSources.has(r.source)
  );
  log.stat("new links queued", toFetch.length);

  // ---- Fetch ------------------------------------------------------------
  let added = [];
  let stillMissing = [];

  if (toFetch.length) {
    log.step("Fetching new papers");
    const s2 = await fetchPapers(toFetch);
    added = s2.found;

    if (s2.missing.length) {
      const oa = await fetchPapersFallback(s2.missing, email);
      added = added.concat(oa.found);
      stillMissing = oa.missing;
    }

    // Two different links can name the same paper (an arXiv URL and the ACL
    // DOI, say), so deduplicate against papers added earlier in this same run
    // as well as against the existing survey.
    const byIdExisting = new Map(papers.map((x) => [x.id, x]));
    const fresh = [];
    for (const paper of added) {
      if (known.has(paper.id)) {
        // The same paper can arrive under several source strings -- a .bib
        // entry with a URL and a .ris entry with a DOI, say. Remember the
        // extra ones, or they get looked up again on every future run.
        const existing = byIdExisting.get(paper.id);
        if (existing && paper.source && paper.source !== existing.source) {
          existing.aliases = [...new Set([...(existing.aliases ?? []), paper.source])];
        }
        log.debug(`Already in the survey, skipping: ${paper.title.slice(0, 60)}`);
        continue;
      }
      known.add(paper.id);
      byIdExisting.set(paper.id, paper);
      fresh.push(paper);
    }
    if (fresh.length !== added.length) {
      log.info(`${added.length - fresh.length} fetched paper(s) were duplicates.`);
    }
    papers = papers.concat(fresh);
    added = fresh;
  }
  log.stat("papers added this run", added.length);

  // ---- Upgrade papers that fell back to OpenAlex ------------------------
  // A throttled run stores papers from OpenAlex, and those records carry no
  // Semantic Scholar citation graph, so they can never produce suggestions.
  // Every later run tries to promote them back, so throttling degrades a run
  // rather than the survey.
  const degraded = papers.filter((x) => x.id.startsWith("openalex:") && x.source);
  if (degraded.length) {
    log.step(`Retrying ${degraded.length} paper(s) that previously fell back to OpenAlex`);
    const { found } = await fetchPapers(degraded.map((x) => ({ id: x.source, source: x.source })));
    const bySource = new Map(found.map((x) => [x.source, x]));
    let upgraded = 0;

    papers = papers.map((old) => {
      const better = bySource.get(old.source);
      if (!old.id.startsWith("openalex:") || !better || known.has(better.id)) return old;
      known.delete(old.id);
      known.add(better.id);
      upgraded++;
      return { ...better, addedAt: old.addedAt, notes: old.notes };
    });
    // Promotion can collide with a paper already present under its real id.
    const seen = new Set();
    papers = papers.filter((x) => !seen.has(x.id) && seen.add(x.id));
    log.stat("papers upgraded from OpenAlex", upgraded);
  }

  // ---- Refresh citation counts -----------------------------------------
  if (refreshMode && papers.length) {
    log.step("Refreshing metadata for existing papers");
    const refreshable = papers
      .filter((x) => !x.id.startsWith("openalex:"))
      .map((x) => ({ id: x.id, source: x.source }));

    const { found } = await fetchPapers(refreshable);
    const byId = new Map(found.map((x) => [x.id, x]));
    let changed = 0;

    papers = papers.map((old) => {
      const next = byId.get(old.id);
      if (!next) return old;
      if (next.citationCount !== old.citationCount) changed++;
      // Keep the fields that describe how the paper entered this survey.
      return { ...next, source: old.source, addedAt: old.addedAt, notes: old.notes };
    });
    log.stat("papers with changed citation counts", changed);
  }

  // ---- Seed from a survey's bibliography --------------------------------
  // `refs: <link>` in papers.txt means "suggest everything this paper cites".
  // The ids are stored so they keep appearing in suggestions on later runs,
  // until they are either promoted into the survey or dismissed.
  const seededStore = readJson(p("data/seeded.json"), { seeded: [] });
  let seeded = Array.isArray(seededStore.seeded) ? seededStore.seeded : [];

  if (seedFrom.length) {
    log.step(`Taking seed papers from ${seedFrom.length} bibliograph(y/ies)`);
    const alreadySeededFrom = new Set(seeded.map((s) => s.from));

    for (const target of seedFrom) {
      if (alreadySeededFrom.has(target.id)) {
        log.info(`Already seeded from ${target.id}; skipping.`);
        continue;
      }
      // Fetch the survey itself too, so we can name it in the table.
      const { found } = await fetchPapers([{ id: target.id, source: target.source }]);
      const title = found[0]?.title ?? null;

      const refIds = await fetchReferences(target.id);
      const existing = new Set(seeded.map((s) => s.id));
      let added = 0;
      for (const id of refIds) {
        if (existing.has(id)) continue;
        existing.add(id);
        seeded.push({ id, from: target.id, fromTitle: title });
        added++;
      }
      log.info(`Added ${added} suggestion(s) from "${title ?? target.id}".`);
    }
  }

  // Drop anything that has since been accepted into the survey or dismissed.
  const acceptedIds = new Set(papers.map((x) => x.id));
  const before = seeded.length;
  seeded = seeded.filter((s) => !acceptedIds.has(s.id) && !dismissed.includes(s.id));
  if (seeded.length !== before) {
    log.info(`${before - seeded.length} seeded suggestion(s) are now in the survey or dismissed.`);
  }
  log.stat("seeded suggestions pending", seeded.length);

  // ---- Suggestions ------------------------------------------------------
  log.step("Working out suggested next reads");
  let candidates = [];
  try {
    candidates = await buildCandidates({ papers, limit, dismissedIds: dismissed, seeded });
  } catch (err) {
    log.error(`Suggestions failed: ${err.message}. Keeping the previous list.`);
    candidates = readJson(p("data/candidates.json"), { candidates: [] }).candidates ?? [];
  }
  log.stat("suggestions", candidates.length);

  // ---- Write everything out --------------------------------------------
  log.step("Writing data files and README");

  writeJson(p("data/papers.json"), { updatedAt: new Date().toISOString(), papers });
  writeJson(p("data/candidates.json"), { updatedAt: new Date().toISOString(), candidates });
  writeJson(p("data/seeded.json"), { updatedAt: new Date().toISOString(), seeded });
  writeFileSync(p("data/papers.csv"), `${renderCsv(papers)}\n`, "utf8");

  // Anything we could not resolve stays in papers.txt so it is visible and
  // fixable, rather than vanishing silently.
  const leftovers = [...unresolved, ...stillMissing.map((r) => r.source).filter(Boolean)];
  if (leftovers.length) {
    log.warn(
      `${leftovers.length} link(s) could not be looked up and were left in papers.txt: ${leftovers.join(", ")}`
    );
  }
  const header = [
    "# One paper per line: an arXiv/ACL/DOI/Semantic Scholar link, or a bare DOI.",
    "# Commit this file and the survey rebuilds itself. Lines starting with # are ignored.",
    "# Anything that could not be looked up is left here so you can fix it.",
    "",
  ];
  writeFileSync(queueFile, `${header.concat(leftovers).join("\n")}\n`, "utf8");

  const readmePath = p("README.md");
  const existing = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  const block = renderSurvey({
    config: { ...identity, sortBy: config.sortBy },
    papers,
    candidates,
  });
  writeFileSync(readmePath, applySurvey(existing, block), "utf8");

  log.step("Done");
  writeSummary();
};

main().catch((err) => {
  log.error(`Update failed: ${err.stack ?? err.message}`);
  writeSummary();
  process.exit(1);
});
