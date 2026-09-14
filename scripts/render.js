import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../lib/log.js";
import {
  renderSurvey,
  applySurvey,
  renderFooter,
  applyFooter,
  renderCsv,
  renderIndexBlock,
  applyIndex,
} from "../lib/renderReadme.js";
import { allViews } from "../lib/views.js";
import { resolveIdentity } from "../lib/identity.js";
import { findSurveys, surveyName } from "../lib/surveys.js";

/**
 * Writes the README, the sorted views and the CSV from whatever is currently
 * in data/.
 *
 * Kept separate from fetching so it can run twice in a single job: once after
 * the survey is rebuilt, and again after pull requests have been opened, so
 * every Rec row can link to its own pull request. Rendering is cheap and
 * touches no network, so running it twice costs nothing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch (err) {
    log.error(`${path} is not valid JSON (${err.message}).`);
    process.exit(1);
  }
};

export const render = (surveyRoot = ROOT, { name = ".", isOnlySurvey = true } = {}) => {
  const p = (...parts) => join(surveyRoot, ...parts);

  const config = readJson(p("survey.config.json"), {});
  const event = process.env.GITHUB_EVENT_PATH
    ? readJson(process.env.GITHUB_EVENT_PATH, null)
    : null;
  const identity = resolveIdentity(config, event);

  const core = readJson(p("data/core.json"), { core: [] }).core ?? [];
  const recs = readJson(p("data/recs.json"), { recs: [] }).recs ?? [];

  // Needed to build "add" and "drop" links that open a prefilled issue.
  const repo = process.env.GITHUB_REPOSITORY || event?.repository?.full_name || "";

  const stamp = new Date().toISOString();
  writeFileSync(p("data/core.csv"), `${renderCsv(core)}\n`, "utf8");

  const survey = isOnlySurvey ? "" : name;

  for (const file of allViews({ core, recs, config: identity, repo, survey, updated: stamp })) {
    const full = p(file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.body, "utf8");
  }

  const readmePath = p("README.md");
  const existing = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  // No `sortBy` here. It was passed in for a long time and never read: the
  // README is always sorted by Score and the alternatives live in views/.
  // Four surveys had set it to "year" and silently got Score anyway.
  const block = renderSurvey({
    config: identity,
    core,
    recs,
    repo,
    survey,
    preview: Number(config.previewRows) || 5,
  });
  writeFileSync(readmePath, applyFooter(applySurvey(existing, block), renderFooter()), "utf8");

  log.info(`${isOnlySurvey ? "Rendered" : `Rendered ${name}:`} ${core.length} in Core and ${recs.length} Recs.`);
};

/**
 * The repository's front page, when it holds more than one survey.
 *
 * Counts are read back from what each survey just wrote, so the index cannot
 * disagree with the surveys it lists.
 */
export const renderIndex = (root, surveyDirs) => {
  const readmePath = join(root, "README.md");
  if (!existsSync(readmePath)) return;

  const rows = surveyDirs.map((dir) => {
    const config = readJson(join(dir, "survey.config.json"), {});
    const coreFile = readJson(join(dir, "data/core.json"), { core: [] });
    const recs = readJson(join(dir, "data/recs.json"), { recs: [] }).recs ?? [];
    return {
      name: surveyName(root, dir),
      title: config.title,
      description: config.description,
      core: (coreFile.core ?? []).length,
      recs: recs.length,
      updated: (coreFile.updatedAt ?? "").slice(0, 10) || null,
    };
  });

  const updated = applyIndex(readFileSync(readmePath, "utf8"), renderIndexBlock(rows));
  if (updated === null) {
    log.debug("No SURVEYS markers in the repository README, so no index was written.");
    return;
  }
  writeFileSync(readmePath, updated, "utf8");
  log.info(`Listed ${rows.length} surveys on the repository's front page.`);
};

// Also runnable on its own, which the workflow does after opening pull requests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { surveys, index } = findSurveys(ROOT);
  const isOnlySurvey = surveys.length === 1 && !index;
  for (const dir of surveys) render(dir, { name: surveyName(ROOT, dir), isOnlySurvey });
  if (index) renderIndex(ROOT, surveys);
}
