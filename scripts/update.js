import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log, writeSummary } from "../lib/log.js";
import { resolveAll, resolveIdentifier } from "../lib/resolve.js";
import { fetchPapers, fetchReferences, matchByTitle } from "../lib/semanticScholar.js";
import { fetchPapersFallback } from "../lib/openalex.js";
import { buildRecommendations } from "../lib/recommend.js";
import { loadGraph, saveGraph, keysWorthKeeping } from "../lib/graphCache.js";
import { parseBibliography } from "../lib/bibliography.js";
import { INTRO_START, INTRO_END } from "../lib/renderReadme.js";
import { lookupOwnerEmail } from "../lib/identity.js";
import { render } from "./render.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Kept out of the repository: it is a derived cache, several megabytes, and
// rewritten every run. See the cache step in the workflow.
const GRAPH_CACHE = ".cache/graph.json";

// Links pulled out of an "Add a paper" issue, parked outside the commit so the
// commit step can recover them if it has to discard this run. See where it is
// written for why an issue needs this and a file does not.
const ISSUE_RECOVERY = ".cache/issue-links.txt";

/** Small helper so title lookups are not one-at-a-time on a large .bib. */
const inParallel = async (items, fn, limit = 4) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};
const p = (...parts) => join(ROOT, ...parts);

/**
 * `critical` marks files whose contents are the survey itself. For those, a
 * parse error must stop the run: quietly falling back to an empty default
 * would rebuild the README from nothing and commit away every paper. A merge
 * conflict left in data/papers.json is the realistic way this happens.
 */
const readJson = (path, fallback, { critical = false } = {}) => {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (critical) {
      log.error(
        `${path} is not valid JSON (${err.message}). Refusing to continue, because ` +
          `rebuilding from an empty file would erase the survey. If this is a merge ` +
          `conflict, fix the file or restore it with: git checkout HEAD~1 -- ${path}`
      );
      writeSummary();
      process.exit(1);
    }
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

  // "Drop paper" issues carry a paper id in the body and reject it, which is
  // what the Decide column's "drop" link opens.
  if (labels.includes("drop-paper") || /^drop paper:/i.test(String(issue.title ?? ""))) {
    const id = String(issue.body ?? "").trim().split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/i.test(id)) {
      const store = readJson(p("data/dismissed.json"), { ids: [], notes: {} });
      store.ids = store.ids ?? [];
      store.notes = store.notes ?? {};
      if (!store.ids.includes(id)) {
        store.ids.push(id);
        store.notes[id] = String(issue.title ?? "").replace(/^Drop paper:\s*/i, "");
        writeJson(p("data/dismissed.json"), store);
        log.info(`Dismissed ${id} from issue #${issue.number}.`);
      }
    } else {
      log.warn(`Issue #${issue.number} is a drop request but its body is not a paper id.`);
    }
    return [];
  }

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
  const current = readJson(p("data/core.json"), { core: [] }, { critical: true }).core ?? [];
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
  writeJson(p("data/core.json"), { core: [] });
  writeJson(p("data/recs.json"), { recs: [] });
  writeFileSync(p("data/core.csv"), "", "utf8");

  // Blank the demo's title rather than substituting a placeholder: an empty
  // title makes the survey fall back to the repository name and description,
  // which the owner already chose when they created the repo.
  const config = readJson(p("survey.config.json"), {});
  if (config.title === meta.title) {
    writeJson(p("survey.config.json"), { ...config, title: "", description: "" });
  }

  // The template's own README opens with an explainer aimed at people deciding
  // whether to use it. That is noise on somebody's actual survey, so it goes
  // too. The footer stays, since it is how readers of a survey discover this.
  const readmePath = p("README.md");
  if (existsSync(readmePath)) {
    const text = readFileSync(readmePath, "utf8");
    const from = text.indexOf(INTRO_START);
    const to = text.indexOf(INTRO_END);
    if (from !== -1 && to !== -1 && to > from) {
      writeFileSync(
        readmePath,
        (text.slice(0, from) + text.slice(to + INTRO_END.length)).trimStart(),
        "utf8"
      );
      log.info("Removed the template's introduction from your README.");
    }
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

  // `fromFile` marks a request as coming from a bibliography rather than from
  // a line in papers.txt. It decides where a failure gets reported: a .bib
  // entry must never be written back into papers.txt, because the file is
  // re-read every run and the entry would be re-reported every run too.
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const entry of parseBibliography(file, text)) {
      if (entry.id) requests.push({ id: entry.id, source: `${file}: ${entry.title}`, fromFile: true });
      else if (entry.url) {
        const id = resolveIdentifier(entry.url);
        if (id) requests.push({ id, source: `${file}: ${entry.title}`, fromFile: true });
        else if (entry.title) needTitleMatch.push({ file, title: entry.title });
      } else if (entry.needsTitleMatch) needTitleMatch.push({ file, title: entry.title });
    }
  }

  // Entries with no identifier at all: look them up by title.
  if (needTitleMatch.length) {
    log.info(`Looking up ${needTitleMatch.length} bibliography entr(y/ies) by title.`);
    const matched = await inParallel(needTitleMatch, async ({ file, title }) => {
      const paperId = await matchByTitle(title);
      if (!paperId) {
        log.warn(`No match for bibliography entry "${title.slice(0, 60)}".`);
        return null;
      }
      return { id: paperId, source: `${file}: ${title}`, fromFile: true };
    });
    requests.push(...matched.filter(Boolean));
  }

  log.stat("papers found in bibliography files", requests.length);
  return { requests, files };
};

/**
 * The two lists were once called "papers" and "candidates"; they are now Core
 * and Recs, consistently, everywhere. Surveys created before the rename carry
 * the old filenames, so move them across once and keep going.
 */
const migrateLegacyNames = () => {
  const moves = [
    ["data/papers.json", "data/core.json", "papers", "core"],
    ["data/candidates.json", "data/recs.json", "candidates", "recs"],
  ];
  for (const [from, to, oldKey, newKey] of moves) {
    if (!existsSync(p(from)) || existsSync(p(to))) continue;
    const old = readJson(p(from), null, { critical: true });
    if (!old) continue;
    writeJson(p(to), { updatedAt: old.updatedAt, [newKey]: old[oldKey] ?? [] });
    rmSync(p(from));
    log.info(`Renamed ${from} to ${to}.`);
  }
  if (existsSync(p("data/papers.csv")) && !existsSync(p("data/core.csv"))) {
    writeFileSync(p("data/core.csv"), readFileSync(p("data/papers.csv"), "utf8"), "utf8");
    rmSync(p("data/papers.csv"));
  }
};

const main = async () => {
  const refreshMode = process.argv.includes("--refresh");
  log.step(`Starting update${refreshMode ? " (refresh mode)" : ""}`);

  clearDemoIfInherited();

  const config = readJson(p("survey.config.json"), {});
  const email = await lookupOwnerEmail(config);
  const limit = Number(config.candidateCount) || 25;

  migrateLegacyNames();
  const store = readJson(p("data/core.json"), { core: [] }, { critical: true });
  let papers = Array.isArray(store.core) ? store.core : [];

  // Heal any duplicates that a previous run may have written.
  const byId = new Map();
  for (const paper of papers) if (paper?.id && !byId.has(paper.id)) byId.set(paper.id, paper);
  if (byId.size !== papers.length) {
    log.warn(`Removed ${papers.length - byId.size} duplicate paper(s) from the survey.`);
    papers = [...byId.values()];
  }
  const dismissed = readJson(p("data/dismissed.json"), { ids: [] }).ids ?? [];
  log.stat("papers in Core", papers.length);

  // ---- Gather new links -------------------------------------------------
  // The seed list moved into import/ so everything you feed the survey lives
  // in one folder. Older surveys keep it at the root; move it once.
  const legacyQueue = p("papers.txt");
  const queueFile = p("import/papers.txt");
  if (existsSync(legacyQueue) && !existsSync(queueFile)) {
    mkdirSync(dirname(queueFile), { recursive: true });
    writeFileSync(queueFile, readFileSync(legacyQueue, "utf8"), "utf8");
    rmSync(legacyQueue);
    log.info("Moved papers.txt into import/.");
  }
  const rawQueueLines = existsSync(queueFile)
    ? readFileSync(queueFile, "utf8").split(/\r?\n/)
    : [];

  // Surveys that ran the older code have papers.txt full of bibliography
  // source labels a previous run wrote back. They are not valid input, they
  // cost a futile title search each, and they multiply. Drop them on sight;
  // the file is rewritten at the end of every run, so this heals in one pass
  // and the entries themselves are still in the .bib they came from.
  const BIB_LABEL = /^\S+\.(?:bib|ris):\s/i;
  const queueLines = rawQueueLines.filter((line) => !BIB_LABEL.test(line.trim()));
  const purged = rawQueueLines.length - queueLines.length;
  if (purged) {
    log.info(`Removed ${purged} stale bibliography line(s) that an older run wrote into papers.txt.`);
  }

  const issueLinks = linksFromIssue();
  const incoming = [...queueLines, ...issueLinks];

  // An issue is the one input that is not a file in the repository. Every
  // other input survives the commit step throwing this run's output away,
  // because `git reset --hard` restores import/ along with data/ and the next
  // run reads it again. An issue's links have no such copy: the run that
  // ingested them loses them, and the issue does not fire a second time.
  //
  // So leave them somewhere the reset cannot reach. The commit step appends
  // them to a fresh papers.txt if it has to discard, which is a push to
  // import/ and therefore triggers the run that ingests them.
  if (issueLinks.length) {
    mkdirSync(dirname(p(ISSUE_RECOVERY)), { recursive: true });
    writeFileSync(p(ISSUE_RECOVERY), `${issueLinks.join("\n")}\n`, "utf8");
  } else if (existsSync(p(ISSUE_RECOVERY))) {
    // Cleared rather than left behind. A stale file would make a later run's
    // discard path requeue links that are already in Core.
    rmSync(p(ISSUE_RECOVERY));
  }

  const { resolved, unresolved, seedFrom, titles } = resolveAll(incoming);

  // Lines that are titles rather than links get looked up by name.
  const fromTitles = (
    await inParallel(titles, async (title) => {
      const paperId = await matchByTitle(title);
      if (paperId) return { id: paperId, source: title };
      log.warn(`No paper found matching the title "${title}".`);
      unresolved.push(title);
      return null;
    })
  ).filter(Boolean);
  if (fromTitles.length) log.stat("papers matched by title", fromTitles.length);

  const bibliography = await readBibliographies();
  const known = new Set(papers.map((x) => x.id));
  const knownSources = new Set(
    papers.flatMap((x) => [x.source, ...(x.aliases ?? [])]).filter(Boolean)
  );
  const toFetch = [...resolved, ...fromTitles, ...bibliography.requests].filter(
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
  const seededStore = readJson(p("data/seeded.json"), { seeded: [] }, { critical: true });
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
  const graph = loadGraph(readJson(p(GRAPH_CACHE), { graph: {} }));
  let candidates = [];
  try {
    const built = await buildRecommendations({
      graph,
      core: papers,
      limit,
      dismissedIds: dismissed,
      seeded,
      algorithm: config.algorithm ?? {},
    });
    if (built.hydrationFailed) {
      const previous = readJson(p("data/recs.json"), { recs: [] }, { critical: true }).recs ?? [];
      candidates = previous;
      log.stat("Recs kept from the previous run", previous.length);
    } else {
      candidates = built.recs;
    }
    // Centrality comes back from the same pass, so Core can be scored and
    // sorted with no extra requests.
    for (const paper of papers) paper.score = built.coreScores.get(paper.id) ?? 0;
  } catch (err) {
    log.error(`Suggestions failed: ${err.message}. Keeping the previous list.`);
    candidates = readJson(p("data/recs.json"), { recs: [] }, { critical: true }).recs ?? [];
  }
  log.stat("Recs", candidates.length);

  // ---- Write everything out --------------------------------------------
  log.step("Writing data files and README");

  const stamp = new Date().toISOString();
  writeJson(p("data/core.json"), { updatedAt: stamp, core: papers });
  writeJson(p("data/recs.json"), { updatedAt: stamp, recs: candidates });
  writeJson(p("data/seeded.json"), { updatedAt: stamp, seeded });
  // Keep cached edges for current papers, plus the citation counts those
  // papers' references actually need. See keysWorthKeeping for why the counts
  // are pruned by need rather than by age.
  writeJson(p(GRAPH_CACHE), saveGraph(graph, keysWorthKeeping(graph, papers.map((x) => x.id))));

  // Anything we could not resolve stays in papers.txt so it is visible and
  // fixable, rather than vanishing silently.
  //
  // Only lines that came from papers.txt are written back, and only ever as
  // the line the owner actually typed. Writing a bibliography entry's `source`
  // label here instead ("thesis.bib: Some Title") was a ratchet: the label is
  // not a parseable input, so the next run read it as a title, failed to match
  // it, and wrote it back again -- while the .bib re-contributed its own copy.
  // One survey reached 95 leftover lines covering 12 papers, one of them 24
  // times, and burned a title-search request on each of them every run.
  const fileFailures = stillMissing.filter((r) => r.fromFile).map((r) => r.source).filter(Boolean);
  const leftovers = [
    ...new Set([...unresolved, ...stillMissing.filter((r) => !r.fromFile).map((r) => r.source).filter(Boolean)]),
  ];

  if (leftovers.length) {
    log.warn(
      `${leftovers.length} line(s) could not be looked up and were left in papers.txt: ${leftovers.join(", ")}`
    );
  }
  if (fileFailures.length) {
    const unique = [...new Set(fileFailures)];
    log.warn(
      `${unique.length} bibliography entr(y/ies) could not be looked up. They stay in their source file, ` +
        `so nothing is lost and nothing accumulates: ${unique.slice(0, 10).join("; ")}` +
        (unique.length > 10 ? ` (and ${unique.length - 10} more)` : "")
    );
  }
  const header = [
    "# One paper per line. A link (arXiv, ACL, DOI, Semantic Scholar), a bare DOI",
    "# or arXiv id, or just the paper's title.",
    "#",
    "# Prefix a line with 'refs:' to pull in everything that paper cites.",
    "#",
    "# Commit this file and the survey rebuilds itself. Lines starting with # are",
    "# ignored. Anything that could not be looked up is left here so you can fix it.",
    "",
  ];
  writeFileSync(queueFile, `${header.concat(leftovers).join("\n")}\n`, "utf8");

  // Rendering lives in one place. This used to be a second copy of the README,
  // CSV and views pipeline, whose output the workflow then overwrote by
  // running scripts/render.js -- and because this copy passed no `repo`, the
  // Decide column it produced was a row of dashes. One implementation, called
  // from both, cannot drift like that.
  render();

  log.step("Done");
  writeSummary();
};

main().catch((err) => {
  log.error(`Update failed: ${err.stack ?? err.message}`);
  writeSummary();
  process.exit(1);
});
