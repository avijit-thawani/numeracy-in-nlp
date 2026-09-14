import { log } from "./log.js";

const BASE = "https://api.openalex.org";

/**
 * Fallback metadata source for papers Semantic Scholar does not know about,
 * or could not return because of throttling.
 *
 * IMPORTANT: only ever use single-work lookups (`/works/doi:...`) here.
 * Since OpenAlex moved to usage-based pricing, singleton lookups are the one
 * operation that stays free and unlimited without an API key
 * (`x-ratelimit-cost-usd: 0`), while `list`/`filter` queries cost $0.0001 each
 * against a $0.10/day keyless budget. Adding a `?filter=` call here would
 * quietly put every user of this template on a metered budget and eventually
 * require them to register a key, which defeats the point of the project.
 *
 * Supplying a contact email puts us in OpenAlex's faster "polite pool".
 */
const politeSuffix = (email) => (email ? `mailto=${encodeURIComponent(email)}` : "");

const withPolite = (url, email) => {
  const suffix = politeSuffix(email);
  if (!suffix) return url;
  return url + (url.includes("?") ? "&" : "?") + suffix;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = async (url, email) => {
  let wait = 1500;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(withPolite(url, email), {
        headers: { Accept: "application/json" },
      });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        log.warn(`OpenAlex returned ${res.status} (attempt ${attempt}); backing off.`);
        await sleep(wait);
        wait *= 2;
        continue;
      }
      return null;
    } catch (err) {
      log.warn(`OpenAlex network error (attempt ${attempt}): ${err.message}`);
      await sleep(wait);
      wait *= 2;
    }
  }
  return null;
};

/** Maps one of our Semantic Scholar style identifiers onto an OpenAlex URL. */
const lookupUrl = (id) => {
  if (id.startsWith("DOI:")) return `${BASE}/works/doi:${id.slice(4)}`;
  // OpenAlex indexes arXiv preprints under their DataCite DOI.
  if (id.startsWith("arXiv:")) return `${BASE}/works/doi:10.48550/arXiv.${id.slice(6)}`;
  if (id.startsWith("URL:")) {
    const url = id.slice(4);
    const arxiv = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
    if (arxiv) return `${BASE}/works/doi:10.48550/arXiv.${arxiv[1]}`;
    const doi = url.match(/doi\.org\/(10\.\S+)/i);
    if (doi) return `${BASE}/works/doi:${doi[1]}`;
  }
  return null;
};

const toRecord = (work, sourceLink) => {
  if (!work?.id) return null;
  const openAlexId = String(work.id).replace(`${BASE}/works/`, "").replace("https://openalex.org/", "");
  const doi = work.doi ? String(work.doi).replace("https://doi.org/", "") : null;
  const pdf = work.best_oa_location?.pdf_url ?? work.open_access?.oa_url ?? null;

  return {
    id: `openalex:${openAlexId}`,
    title: work.display_name ?? work.title ?? "Untitled",
    authors: (work.authorships ?? []).map((a) => a?.author?.display_name).filter(Boolean),
    // OpenAlex has no h-index on a work, so there is nobody to rank: leave the
    // author column empty rather than guess. Institutions it does have, and
    // better populated than Semantic Scholar's free-text affiliations.
    topAuthors: [],
    affiliations: [
      ...new Set(
        (work.authorships ?? []).flatMap((a) => (a?.institutions ?? []).map((i) => i?.display_name).filter(Boolean))
      ),
    ].slice(0, 2),
    year: work.publication_year ?? null,
    venue:
      work.primary_location?.source?.display_name ??
      work.host_venue?.display_name ??
      null,
    publicationDate: work.publication_date ?? null,
    summary: "",
    url: doi ? `https://doi.org/${doi}` : `https://openalex.org/${openAlexId}`,
    doi,
    arxivId: null,
    pdf,
    citationCount: work.cited_by_count ?? 0,
    referenceCount: (work.referenced_works ?? []).length,
    influentialCitationCount: 0,
    source: sourceLink ?? null,
    via: "openalex",
    addedAt: new Date().toISOString().slice(0, 10),
  };
};

/** The institutions on an OpenAlex work, most-shared first, at most two. */
export const institutionsOf = (work) => {
  const weight = new Map();

  for (const authorship of work?.authorships ?? []) {
    // One vote per author, for the same reason as the Semantic Scholar side:
    // otherwise one author with three listed institutions fills every slot.
    const first = (authorship?.institutions ?? []).map((i) => i?.display_name).filter(Boolean)[0];
    if (!first) continue;
    weight.set(first, (weight.get(first) ?? 0) + 1);
  }

  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
};

/**
 * Fills in affiliations that Semantic Scholar does not have.
 *
 * Its `affiliations` field is free text on an author record and mostly empty
 * on recent work: across a sample of 36 suggestions it was present on 11%,
 * against 63% for the same papers in OpenAlex, which models institutions as
 * real entities. Since the column is most useful precisely where citations are
 * not -- a paper published this month -- an empty column there defeats the
 * point of having it.
 *
 * One single-work lookup per paper, which is the free, unmetered half of the
 * OpenAlex API. Bounded by the caller to the suggestions on show.
 */
export const fetchAffiliations = async (papers, email) => {
  const filled = new Map();
  const wanted = papers.filter((p) => !(p.affiliations ?? []).length && (p.doi || p.arxivId));
  if (!wanted.length) return filled;

  log.info(`Asking OpenAlex for affiliations on ${wanted.length} paper(s) Semantic Scholar had none for.`);

  for (const paper of wanted) {
    const url = paper.doi
      ? `${BASE}/works/doi:${paper.doi}`
      : `${BASE}/works/doi:10.48550/arXiv.${paper.arxivId}`;

    const work = await getJson(`${url}?select=id,authorships`, email);
    const institutions = institutionsOf(work);
    if (institutions.length) filled.set(paper.id, institutions);
  }

  log.stat("affiliations recovered from OpenAlex", filled.size);
  return filled;
};

/**
 * Attempts to recover papers Semantic Scholar could not return.
 * Returns { found: Record[], missing: [{id, source}] }.
 */
export const fetchPapersFallback = async (requests, email) => {
  const found = [];
  const missing = [];
  if (!requests.length) return { found, missing };

  log.info(`Trying OpenAlex for ${requests.length} paper(s) Semantic Scholar could not return.`);

  for (const req of requests) {
    const url = lookupUrl(req.id);
    if (!url) {
      missing.push(req);
      continue;
    }
    const work = await getJson(url, email);
    const record = toRecord(work, req.source);
    if (record) {
      log.debug(`OpenAlex recovered: ${record.title.slice(0, 60)}`);
      found.push(record);
    } else {
      missing.push(req);
    }
  }

  log.info(`OpenAlex recovered ${found.length}, still missing ${missing.length}.`);
  return { found, missing };
};
