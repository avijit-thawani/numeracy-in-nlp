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
const BATCH_PREFIX = "recs/";
const LABEL = "rec";

/** `past month` -> `recs/past-month`, stable across runs so a PR updates in place. */
const batchBranch = (window) =>
  `${BATCH_PREFIX}${String(window).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/**
 * One line per paper, plus enough commented context to recognise it without
 * opening anything.
 *
 * The comment carries the name, the best author with their h-index, and the
 * affiliation, because the decision being asked for is "do I want this?" and a
 * bare URL cannot answer it. Deleting the pair of lines is how you say no, so
 * they are kept adjacent and in that order.
 */
const seedEntry = (rec) => {
  const author = (rec.topAuthors ?? [])[0];
  const facts = [
    author ? `${author.name} (h=${author.hIndex})` : (rec.authors ?? [])[0],
    (rec.affiliations ?? [])[0],
    rec.year,
    `${rec.citationCount ?? 0} citations`,
    rec.why,
  ].filter(Boolean);

  return [`# ${rec.title}`, `#   ${facts.join(" · ")}`, linkFor(rec)].join("\n");
};

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

/**
 * Closes pull requests for papers that have dropped out of Recs, because they
 * were accepted, dismissed, or simply outranked. Without this the queue only
 * ever grows.
 */
const closeStale = (recs) => {
  const current = new Set(recs.map(branchFor));
  try {
    const open = JSON.parse(
      gh(["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName"])
    ).filter((x) => x.headRefName.startsWith(BRANCH_PREFIX) && !current.has(x.headRefName));

    for (const pr of open) {
      gh(["pr", "close", String(pr.number), "--delete-branch", "--comment",
          "No longer among the current suggestions."]);
      log.info(`Closed #${pr.number}, no longer recommended.`);
    }
    if (open.length) log.stat("stale pull requests closed", open.length);
  } catch (err) {
    log.warn(`Could not tidy stale pull requests: ${String(err.message).split("\n")[0]}`);
  }
};

/**
 * One pull request per table, rather than one per paper.
 *
 * Per-paper pull requests made two problems. Deciding on ten papers meant ten
 * pages and ten merges, and only the first few Recs ever got one -- so the
 * `add` link opened a pull request on some rows and an issue on others, with
 * nothing in the link to say which. A batch is one page holding the whole
 * table: every paper as a commented line, delete the ones you do not want,
 * merge once.
 *
 * The branch name is derived from the window, so a later run updates the same
 * pull request instead of opening a second one for the same five papers.
 */
const openBatches = ({ recs, base, labelArgs }) => {
  const groups = new Map();
  for (const rec of recs) {
    const key = rec.freshWindow ?? "most connected";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }

  const open = (() => {
    try {
      return JSON.parse(gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "headRefName,url,number"]));
    } catch (err) {
      log.warn(`Could not list pull requests: ${String(err.message).split("\n")[0]}`);
      return [];
    }
  })();
  const byBranch = new Map(open.map((x) => [x.headRefName, x]));

  const links = new Map();
  let opened = 0;

  for (const [window, papers] of groups) {
    if (!papers.length) continue;
    const branch = batchBranch(window);
    const seedFile = p("import/papers.txt");
    const title = `Add ${papers.length} paper${papers.length === 1 ? "" : "s"} from the ${window}`;

    try {
      git(["checkout", "-q", "-B", branch, `origin/${base}`]);

      const current = readFileSync(seedFile, "utf8").replace(/\s*$/, "");
      const block = papers.map(seedEntry).join("\n\n");
      writeFileSync(seedFile, `${current}\n\n# --- ${window} ---\n${block}\n`, "utf8");

      git(["add", "import/papers.txt"]);
      git([
        "-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-q", "-m", title.slice(0, 72),
      ]);
      // Force, because the same branch is rewritten every run as the table
      // changes. An open pull request picks the new contents up in place.
      git(["push", "-q", "-f", "origin", branch]);

      const existing = byBranch.get(branch);
      if (existing) {
        gh(["pr", "edit", String(existing.number), "--title", title, "--body", batchBody(window, papers)]);
        links.set(window, existing);
        log.info(`Updated #${existing.number} with the current ${window} table.`);
      } else {
        const url = gh([
          "pr", "create",
          "--base", base,
          "--head", branch,
          "--title", title,
          "--body", batchBody(window, papers),
          ...labelArgs,
        ]).trim().split("\n").pop();
        const number = Number(url.split("/").pop());
        links.set(window, { url, number });
        opened++;
        log.info(`Opened ${url} for the ${window} table.`);
      }
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
      log.warn(`Could not prepare the ${window} pull request: ${message}`);
    } finally {
      try {
        git(["checkout", "-q", base]);
      } catch {
        /* already there */
      }
    }
  }

  // Per-paper pull requests from before this changed are noise now: the same
  // papers are in the batches, so leaving them open asks twice.
  for (const pr of open) {
    if (!pr.headRefName.startsWith(BRANCH_PREFIX)) continue;
    try {
      gh(["pr", "close", String(pr.number), "--delete-branch", "--comment",
          "Superseded: suggestions are now proposed one pull request per table."]);
      log.info(`Closed the old per-paper #${pr.number}.`);
    } catch {
      /* it will be closed on a later run */
    }
  }

  // Each row learns its table's pull request, so the README can offer one
  // link per table rather than one per paper.
  try {
    const path = p("data/recs.json");
    const store = readJson(path, { recs: [] });
    store.recs = (store.recs ?? []).map((rec) => {
      const match = links.get(rec.freshWindow ?? "most connected");
      const { prUrl, prNumber, batchPrUrl, batchPrNumber, ...rest } = rec;
      return match ? { ...rest, batchPrUrl: match.url, batchPrNumber: match.number } : rest;
    });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch (err) {
    log.warn(`Could not record pull request links: ${String(err.message).split("\n")[0]}`);
  }

  log.stat("pull requests opened", opened);
};

const batchBody = (window, papers) =>
  [
    `The **${window}** suggestions, ${papers.length} of them, as lines in \`import/papers.txt\`.`,
    "",
    "**Delete the lines for anything you do not want**, then merge. Merging adds",
    "the rest to your list; closing rejects the whole batch. Each paper is three",
    "lines: its title, a line of context, and the link that actually counts.",
    "",
    "| Paper | Who | Why |",
    "| --- | --- | --- |",
    ...papers.map((p) => {
      const author = (p.topAuthors ?? [])[0];
      const who = [author ? `${author.name} (h=${author.hIndex})` : null, (p.affiliations ?? [])[0]]
        .filter(Boolean)
        .join(" · ") || "-";
      return `| [${String(p.title).replace(/\|/g, "\\|")}](${linkFor(p)}) | ${who.replace(/\|/g, "\\|")} | ${p.why ?? "-"} |`;
    }),
  ].join("\n");

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

  if ((settings.mode ?? "batch") === "batch") {
    const base = process.env.GITHUB_REF_NAME || "main";
    let labelArgs = ["--label", LABEL];
    try {
      gh(["label", "create", LABEL, "--description", "Suggested papers awaiting a decision", "--color", "1D76DB"]);
    } catch (err) {
      if (!/already exists/i.test(String(err.stderr || err.message))) labelArgs = [];
    }
    openBatches({ recs, base, labelArgs });
    writeSummary();
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

  // Close anything still open for a paper that is no longer recommended, so
  // the queue reflects the current Recs rather than every paper ever
  // suggested.
  closeStale(recs);

  // `count` is a ceiling on how many sit open at once, not how many to open
  // per run. Treating it as the latter opened a fresh batch every day and
  // quietly accumulated: ten piled up during one afternoon of testing.
  // "all" gives every Rec its own pull request, which turns the pull request
  // list into the whole triage queue.
  let openNow = 0;
  try {
    openNow = JSON.parse(gh(["pr", "list", "--state", "open", "--limit", "200", "--json", "headRefName"]))
      .filter((x) => x.headRefName.startsWith(BRANCH_PREFIX)).length;
  } catch {
    /* treat as none open */
  }

  const ceiling = settings.count === "all" ? recs.length : Number(settings.count) || 3;
  const room = Math.min(
    ceiling - openNow,
    // Never open more than this in one go. With "all" on a large survey the
    // first run would otherwise fire off dozens of notifications at once; a
    // per-run cap fills the queue over a few runs instead.
    Number(settings.maxPerRun) || 20
  );
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
