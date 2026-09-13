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
} from "../lib/renderReadme.js";
import { allViews } from "../lib/views.js";
import { resolveIdentity } from "../lib/identity.js";

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
const p = (...parts) => join(ROOT, ...parts);

const readJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch (err) {
    log.error(`${path} is not valid JSON (${err.message}).`);
    process.exit(1);
  }
};

export const render = () => {
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

  for (const file of allViews({ core, recs, config: identity, repo, updated: stamp })) {
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
    preview: Number(config.previewRows) || 10,
  });
  writeFileSync(readmePath, applyFooter(applySurvey(existing, block), renderFooter()), "utf8");

  log.info(`Rendered ${core.length} in Core and ${recs.length} Recs.`);
};

// Also runnable on its own, which the workflow does after opening pull requests.
if (import.meta.url === `file://${process.argv[1]}`) render();
