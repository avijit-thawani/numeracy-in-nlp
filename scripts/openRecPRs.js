import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log, writeSummary } from "../lib/log.js";

/**
 * Opens one pull request per top recommendation, so accepting a paper is a
 * merge and rejecting it is a close, rather than hand-editing a text file.
 *
 * Runs after the survey has been rebuilt, and only for the highest-scoring
 * Recs that do not already have a PR. The count is deliberately small: these
 * are notifications as much as changes, and a survey with sixty Recs should
 * not open sixty pull requests.
 *
 * Needs `pull-requests: write`, and the repository setting "Allow GitHub
 * Actions to create and approve pull requests", which GitHub leaves off by
 * default. Without it the API refuses and this step reports why and stops,
 * rather than failing the run.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => join(ROOT, ...parts);

const BRANCH_PREFIX = "rec/";
const LABEL = "rec";

const gh = (args, options = {}) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const readJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * A branch name that is stable for a paper, so reruns do not duplicate PRs.
 * Carries the full id, not a short prefix: the rejection handler reads the id
 * back out of the branch name and matches it against `rec.id` exactly.
 */
const branchFor = (rec) => `${BRANCH_PREFIX}${rec.id}`;

/** The link we would add to the seed list, preferring readable identifiers. */
const linkFor = (rec) => {
  if (rec.arxivId) return `https://arxiv.org/abs/${rec.arxivId}`;
  if (rec.doi) return `https://doi.org/${rec.doi}`;
  return rec.url ?? `https://www.semanticscholar.org/paper/${rec.id}`;
};

const body = (rec) =>
  [
    `**${rec.title}**`,
    "",
    `${(rec.authors ?? []).slice(0, 5).join(", ")}${(rec.authors ?? []).length > 5 ? " et al." : ""}`,
    `${rec.venue ?? "no venue"} · ${rec.year ?? "no year"} · cited ${rec.citationCount ?? 0} times`,
    "",
    rec.summary ? `> ${rec.summary}\n` : "",
    `Suggested because it **${rec.why}**, scoring **${Math.round(rec.score ?? 0)}/100**.`,
    "",
    `[Read it](${linkFor(rec)})`,
    "",
    "---",
    "",
    "**Merge** to add it to Core. **Close** to reject it, and it will not be",
    "suggested again.",
  ].join("\n");

/**
 * Writes each open pull request's link into data/recs.json so the next render
 * can put a "review" link on that row. Must run on every path, including when
 * no new pull requests are opened: a survey that is already at its quota still
 * needs its existing ones linked, and skipping that silently left every row
 * without a link.
 */
const recordLinks = () => {
  try {
    const open = JSON.parse(
      gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "headRefName,url,number"])
    );
    const byBranch = new Map(open.map((x) => [x.headRefName, x]));

    const path = p("data/recs.json");
    const store = readJson(path, { recs: [] });
    let linked = 0;
    store.recs = (store.recs ?? []).map((rec) => {
      const match = byBranch.get(branchFor(rec));
      if (!match) {
        const { prUrl, prNumber, ...rest } = rec;
        return rest;
      }
      linked++;
      return { ...rec, prUrl: match.url, prNumber: match.number };
    });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    log.stat("Recs linked to a pull request", linked);
  } catch (err) {
    log.warn(`Could not record pull request links: ${String(err.message).split("\n")[0]}`);
  }
};

const main = () => {
  const config = readJson(p("survey.config.json"), {});
  const settings = config.recPullRequests ?? {};
  if (!settings.enabled) {
    log.info("Pull requests for Recs are off. Set recPullRequests.enabled to turn them on.");
    return;
  }

  const recs = readJson(p("data/recs.json"), { recs: [] }).recs ?? [];
  if (!recs.length) {
    log.info("No Recs to open pull requests for.");
    return;
  }

  // Which papers already have one, open or closed, so nothing is re-proposed.
  let taken = new Set();
  try {
    const seen = JSON.parse(
      gh(["pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName"])
    );
    taken = new Set(seen.map((x) => x.headRefName));
  } catch (err) {
    log.warn(`Could not list existing pull requests: ${err.message.split("\n")[0]}`);
  }

  // `count` is a ceiling on how many sit open at once, not how many to open
  // per run. Treating it as the latter opened a fresh batch every day and
  // quietly accumulated: ten piled up during one afternoon of testing.
  let openNow = 0;
  try {
    openNow = JSON.parse(gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "headRefName"]))
      .filter((x) => x.headRefName.startsWith(BRANCH_PREFIX)).length;
  } catch {
    /* treat as none open */
  }

  const room = (Number(settings.count) || 3) - openNow;
  if (room <= 0) {
    log.info(`${openNow} Rec pull request(s) already await a decision; not opening more.`);
    recordLinks();
    return;
  }

  const wanted = recs.filter((r) => !taken.has(branchFor(r))).slice(0, room);

  if (!wanted.length) {
    log.info("Every top Rec already has a pull request.");
    recordLinks();
    return;
  }

  const base = process.env.GITHUB_REF_NAME || "main";

  // Labels are repository settings rather than files, so "Use this template"
  // does not copy them and `gh pr create --label` fails outright on a fresh
  // survey. Create it first; the call is harmless if it already exists.
  let labelArgs = ["--label", LABEL];
  try {
    gh(["label", "create", LABEL, "--description", "A suggested paper awaiting a decision", "--color", "1D76DB"]);
    log.info(`Created the "${LABEL}" label.`);
  } catch (err) {
    if (!/already exists/i.test(String(err.stderr || err.message))) {
      log.warn(`Could not create the "${LABEL}" label; opening pull requests without it.`);
      labelArgs = [];
    }
  }

  let opened = 0;
  const created = new Map();

  for (const rec of wanted) {
    const branch = branchFor(rec);
    const seedFile = p("import/papers.txt");

    try {
      git(["checkout", "-q", "-B", branch, `origin/${base}`]);

      const current = readFileSync(seedFile, "utf8").replace(/\s*$/, "");
      writeFileSync(seedFile, `${current}\n${linkFor(rec)}    # ${rec.title}\n`, "utf8");

      git(["add", "import/papers.txt"]);
      git(["-c", "user.name=github-actions[bot]",
           "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
           "commit", "-q", "-m", `Add: ${rec.title}`.slice(0, 72)]);
      git(["push", "-q", "-f", "origin", branch]);

      const url = gh(["pr", "create",
          "--base", base,
          "--head", branch,
          "--title", `Add: ${rec.title}`.slice(0, 72),
          "--body", body(rec),
          ...labelArgs]).trim().split("\n").pop();
      created.set(rec.id, url);
      opened++;
      log.info(`Opened a pull request for "${rec.title.slice(0, 55)}".`);
    } catch (err) {
      const message = String(err.stderr || err.message).split("\n").filter(Boolean)[0] ?? "";
      if (/not permitted to create or approve pull requests/i.test(message)) {
        log.warn(
          "GitHub is blocking Actions from opening pull requests. Turn on " +
            "Settings > Actions > General > Allow GitHub Actions to create and " +
            "approve pull requests, or set recPullRequests.enabled to false."
        );
        break;
      }
      log.warn(`Could not open a pull request for "${rec.title.slice(0, 40)}": ${message}`);
    } finally {
      try {
        git(["checkout", "-q", base]);
      } catch {
        /* already there */
      }
    }
  }

  recordLinks();

  log.stat("pull requests opened", opened);
  writeSummary();
};

main();
