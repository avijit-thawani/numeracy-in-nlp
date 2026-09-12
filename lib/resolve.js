import { log } from "./log.js";

// Hosts that Semantic Scholar can look up directly from a URL.
const DIRECT_URL_HOSTS = new Set([
  "semanticscholar.org",
  "www.semanticscholar.org",
  "arxiv.org",
  "www.arxiv.org",
  "aclweb.org",
  "www.aclweb.org",
  "acm.org",
  "biorxiv.org",
  "www.biorxiv.org",
  "openreview.net",
  "www.openreview.net",
  "pubmed.ncbi.nlm.nih.gov",
]);

const BARE_DOI = /^(?:doi:)?(10\.\d{4,9}\/\S+)$/i;
const BARE_ARXIV = /^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i;

/**
 * Turns one user-supplied line into an identifier the Semantic Scholar API
 * accepts, or null if we cannot make sense of it.
 *
 * Accepts full URLs, bare DOIs, and bare arXiv ids. Comments (#) and blank
 * lines are ignored by the caller.
 */
export const resolveIdentifier = (raw) => {
  // Trailing notes are the natural way to annotate a hand-kept list, as in
  // "https://arxiv.org/abs/2105.13626  # ByT5". Without stripping them the
  // whitespace is percent-encoded into the identifier and the lookup quietly
  // asks for the wrong paper. Requiring whitespace before the "#" leaves URL
  // fragments alone.
  const line = String(raw ?? "")
    .replace(/\s+#.*$/, "")
    .trim();
  if (!line) return null;

  const bareDoi = line.match(BARE_DOI);
  if (bareDoi) return `DOI:${bareDoi[1]}`;

  const bareArxiv = line.match(BARE_ARXIV);
  if (bareArxiv) return `arXiv:${bareArxiv[1]}`;

  let url;
  try {
    url = new URL(line);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);

  // arXiv: normalise to an explicit arXiv id so abs/, pdf/ and version
  // suffixes all collapse to the same paper.
  if (host.endsWith("arxiv.org")) {
    const id = parts[parts.length - 1]?.replace(/\.pdf$/i, "").replace(/v\d+$/i, "");
    if (id) return `arXiv:${id}`;
  }

  // ACL Anthology: the path segment is the anthology id, e.g. /2020.acl-main.463/
  if (host === "aclanthology.org" && parts.length >= 1) {
    const id = parts[0].replace(/\.pdf$/i, "");
    return `DOI:10.18653/v1/${id}`;
  }

  // ACM Digital Library: /doi/10.1145/xxxxx or /doi/abs/10.1145/xxxxx
  if (host.endsWith("dl.acm.org")) {
    const doiAt = parts.indexOf("doi");
    if (doiAt !== -1) {
      const rest = parts.slice(doiAt + 1).filter((p) => p !== "abs" && p !== "full" && p !== "pdf");
      if (rest.length >= 2) return `DOI:${rest.join("/")}`;
    }
  }

  // doi.org links carry the DOI in the path.
  if (host === "doi.org" || host === "dx.doi.org") {
    const doi = parts.join("/");
    if (doi) return `DOI:${doi}`;
  }

  if (DIRECT_URL_HOSTS.has(host)) return `URL:${url.href}`;

  return null;
};

/**
 * Is this line a paper title rather than a mistyped link? Several words, some
 * letters, and no sign of being a URL or identifier.
 */
const looksLikeTitle = (line) => {
  if (/^\w+:\/\//.test(line) || line.includes("://")) return false;
  if (/^10\.\d{4}/.test(line) || /^\d{4}\.\d{4,5}$/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  return words.length >= 3 && /[a-z]{3}/i.test(line);
};

/**
 * Resolves many lines at once, reporting which ones we could not parse so the
 * caller can leave them in the seed list rather than silently dropping them.
 */
export const resolveAll = (lines) => {
  const resolved = [];
  const unresolved = [];
  const seedFrom = [];
  const titles = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = String(line ?? "")
      .replace(/\s+#.*$/, "")
      .trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // "refs: <link>" means: suggest everything this paper cites. Handy for
    // starting from an existing survey, whose bibliography is already a
    // curated reading list for the topic.
    const refsMatch = trimmed.match(/^refs?\s*:\s*(.+)$/i);
    if (refsMatch) {
      const target = resolveIdentifier(refsMatch[1].trim());
      if (target) {
        seedFrom.push({ id: target, source: trimmed });
      } else {
        log.warn(`Could not work out which paper to take references from: "${trimmed}"`);
        unresolved.push(trimmed);
      }
      continue;
    }

    const id = resolveIdentifier(trimmed);
    if (!id) {
      // A line that is plainly not an identifier is probably a title, so try
      // looking it up by name rather than rejecting it.
      if (looksLikeTitle(trimmed)) {
        titles.push(trimmed);
        continue;
      }
      log.warn(`Could not work out what paper this is: "${trimmed}"`);
      unresolved.push(trimmed);
      continue;
    }
    if (seen.has(id)) {
      log.debug(`Skipping duplicate in input: ${trimmed} -> ${id}`);
      continue;
    }
    seen.add(id);
    resolved.push({ id, source: trimmed });
  }

  return { resolved, unresolved, seedFrom, titles };
};
