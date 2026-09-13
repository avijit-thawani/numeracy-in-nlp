import { log } from "./log.js";

// Words that stay lowercase inside a title, unless they lead it.
const MINOR = new Set([
  "a", "an", "the", "and", "or", "but", "for", "nor", "of", "on", "in", "to",
  "at", "by", "vs", "via", "with", "from", "into", "over", "as",
]);

// Field acronyms that look wrong in title case.
const ACRONYMS = new Set([
  "nlp", "nlu", "nlg", "ml", "ai", "llm", "llms", "cv", "rl", "hci", "ir", "kg",
  "qa", "asr", "tts", "gnn", "cnn", "rnn", "lm", "lms", "vlm", "vlms", "rag",
  "ocr", "ner", "mt", "hpc", "db", "os", "ui", "ux", "api", "3d", "2d",
]);

/**
 * Turns a repository name into a readable survey title, so nobody has to fill
 * in a config file just to name the thing they already named when they created
 * the repo. "numeracy-in-nlp" becomes "Numeracy in NLP".
 */
export const titleFromRepoName = (repoName) => {
  const words = String(repoName ?? "")
    .replace(/[-_.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return "My Living Survey";

  const shaped = words.map((word, i) => {
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (i > 0 && MINOR.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });

  // "llm-agents-survey" reads better as "LLM Agents", since the page already
  // frames itself as a survey. Only strip when something meaningful is left:
  // "my-living-survey" must not collapse to "My".
  const GENERIC = new Set(["my", "living", "lit", "literature", "paper", "papers", "reading"]);
  if (/^surveys?$/i.test(shaped[shaped.length - 1])) {
    const rest = shaped.slice(0, -1);
    if (rest.length && rest.some((w) => !GENERIC.has(w.toLowerCase()))) {
      return rest.join(" ");
    }
  }

  return shaped.join(" ");
};

/**
 * Works out what to call this survey and how to describe it.
 *
 * Order of preference: what the owner put in survey.config.json, then what
 * they typed into GitHub when creating the repo, then a sensible default.
 * The aim is that naming the repo is the only naming step.
 */
export const resolveIdentity = (config, event) => {
  const repo = event?.repository;

  // Not every run has an event payload -- a scheduled run has none, and nor
  // does a local one -- but `GITHUB_REPOSITORY` is always set in Actions. A
  // survey whose title came from its repo name must not lose it on the days
  // nobody pushed anything.
  const envName = (process.env.GITHUB_REPOSITORY ?? "").split("/")[1] || null;
  const name = repo?.name || envName;
  const fromRepoName = name ? titleFromRepoName(name) : null;

  const title = config.title?.trim() || fromRepoName || "My Living Survey";
  const description =
    config.description?.trim() ||
    repo?.description?.trim() ||
    "A living literature survey. Papers come from `import/`, and Recs update themselves.";

  if (!config.title?.trim() && fromRepoName) {
    log.info(`Using the repository name as the survey title: "${title}".`);
  }
  return { title, description };
};

/**
 * Best-effort contact address for OpenAlex's "polite pool".
 *
 * Only works if the owner has made their email public on GitHub, which most
 * people have not, so this usually comes back empty -- that is fine, the
 * address is optional and only ever sent to OpenAlex.
 */
export const lookupOwnerEmail = async (config) => {
  if (config.contactEmail?.trim()) return config.contactEmail.trim();

  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !token) return "";

  try {
    const res = await fetch(`https://api.github.com/users/${owner}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return "";
    const email = (await res.json())?.email;
    if (email) {
      log.debug(`Using the repository owner's public GitHub email for OpenAlex.`);
      return email;
    }
  } catch (err) {
    log.debug(`Could not look up the owner's email: ${err.message}`);
  }
  return "";
};
