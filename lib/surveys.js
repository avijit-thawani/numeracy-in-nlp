import { readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * One repo, many surveys.
 *
 * A survey used to be a whole repository: `import/` and `data/` at the root,
 * one README, one Action. That is still the common case and still the default,
 * but it makes keeping four related surveys mean keeping four repositories,
 * four Actions and four sets of settings, which is a lot of administration for
 * what is really one project.
 *
 * So a survey is now a *directory* that contains a `survey.config.json`, and a
 * repository may hold as many as it likes:
 *
 *   my-repo/survey.config.json      one survey, at the root (unchanged)
 *
 *   my-repo/README.md               an index
 *   my-repo/demos/dean/survey.config.json
 *   my-repo/demos/bengio/survey.config.json
 *
 * The rule that makes both work without a setting: if any survey is nested,
 * the root is an index rather than a survey, even when a stray config is left
 * there. Otherwise the root is the survey, exactly as before.
 */

// Deep trees are somebody else's repository layout, not a survey collection,
// and walking them is how a discovery pass ends up reading node_modules.
const MAX_DEPTH = 3;
const SKIP = new Set(["node_modules", "views", "data", "import", "test", "lib", "scripts", "assets"]);

const isSurveyDir = (dir) => existsSync(join(dir, "survey.config.json"));

const walk = (root, dir, depth, out) => {
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (isSurveyDir(full)) {
      out.push(full);
      // A survey's own folder is a leaf: whatever is inside it belongs to it.
      continue;
    }
    walk(root, full, depth + 1, out);
  }
};

/**
 * Every survey in a repository, as absolute paths, plus whether the root is
 * acting as an index.
 *
 * Discovery is by layout rather than by configuration because the alternative
 * is a list of folders that has to be kept in step with the folders, and the
 * first thing anyone does is add a survey and forget the list.
 */
export const findSurveys = (root) => {
  const nested = [];
  walk(root, root, 1, nested);
  nested.sort();

  if (nested.length) return { surveys: nested, index: true };
  if (isSurveyDir(root)) return { surveys: [root], index: false };

  // A repository with nothing in it yet: treat the root as the survey, so the
  // first run in a fresh template creates the files where they are expected.
  return { surveys: [root], index: false };
};

/** How a survey is named in logs, issues and the index: its path from the repo root. */
export const surveyName = (root, surveyRoot) => {
  const rel = relative(root, surveyRoot);
  return rel === "" ? "." : rel.split(sep).join("/");
};

/** The reverse: turns a name from an issue back into a directory we will accept. */
export const surveyByName = (root, surveys, name) => {
  const wanted = String(name ?? "").trim().replace(/^\.?\//, "").replace(/\/$/, "");
  if (!wanted) return null;
  return surveys.find((dir) => surveyName(root, dir) === wanted) ?? null;
};
