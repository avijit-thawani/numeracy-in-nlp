import { log } from "./log.js";

const BASE = "https://api.semanticscholar.org/graph/v1/paper";

// The metadata shown in the survey table. Deliberately excludes `abstract`:
// it roughly triples the size of the committed JSON and `tldr` already gives
// us a one-line summary.
const CORE_FIELDS = [
  "paperId",
  "externalIds",
  "url",
  "title",
  "tldr",
  "venue",
  "year",
  "publicationDate",
  "authors",
  "citationCount",
  "referenceCount",
  "influentialCitationCount",
  "openAccessPdf",
].join(",");

const CORE_CHUNK = 200;

// Citations are fetched one paper at a time rather than in a batch. A batch
// response is capped at roughly 9,999 citations in total, so a single hugely
// cited paper (Attention Is All You Need has over 100,000) swallows the entire
// budget and every other paper silently returns none -- which collapses the
// overlap ranking to zero. Per-paper requests give each paper its own cap.
//
// Capping at 1,000 is also better signal, not just cheaper: papers cited by
// everything say little about what makes *this* survey's topic cohere.
const CITATIONS_PER_PAPER = 1000;

// The shared unauthenticated pool can throttle for minutes at a time, so we are
// patient: eight attempts with the wait capped at a minute is roughly five
// minutes of trying before giving up and letting the next run retry.
const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jitter stops several requests from retrying in lockstep.
const backoff = (wait) => Math.min(wait, MAX_BACKOFF_MS) * (0.75 + Math.random() * 0.5);

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * POSTs one batch of ids, retrying on throttling and transient server errors.
 *
 * The API's shared unauthenticated pool returns 429 readily (we saw three in a
 * row during development), so backoff here is load-bearing rather than
 * defensive. Crucially a 429 is never reported as "paper not found" -- the
 * original project conflated the two, which made throttling look like missing
 * papers.
 */
const postBatch = async (ids, fields) => {
  let wait = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/batch?fields=${fields}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    } catch (err) {
      log.warn(`Network error talking to Semantic Scholar (attempt ${attempt}): ${err.message}`);
      await sleep(backoff(wait));
      wait *= 2;
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return data;
      // The endpoint sometimes answers 200 with an error object/string.
      log.warn(`Unexpected batch response shape: ${JSON.stringify(data).slice(0, 200)}`);
      return ids.map(() => null);
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(wait);
      log.warn(
        `Semantic Scholar returned ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}); waiting ${Math.round(delay / 1000)}s. This is throttling, not a missing paper.`
      );
      await sleep(delay);
      wait *= 2;
      continue;
    }

    const body = await res.text().catch(() => "");
    log.warn(`Semantic Scholar returned ${res.status}: ${body.slice(0, 200)}`);
    return ids.map(() => null);
  }

  log.error(
    `Gave up on a batch of ${ids.length} papers after ${MAX_ATTEMPTS} attempts. They will be retried on the next run.`
  );
  return ids.map(() => null);
};

const normaliseAuthors = (authors) =>
  (authors ?? []).map((a) => a?.name).filter(Boolean);

/** Reshapes an API record into the flat form we store in data/papers.json. */
const toRecord = (raw, sourceLink) => {
  if (!raw?.paperId) return null;
  const ext = raw.externalIds ?? {};
  return {
    id: raw.paperId,
    title: raw.title ?? "Untitled",
    authors: normaliseAuthors(raw.authors),
    year: raw.year ?? null,
    venue: raw.venue || null,
    publicationDate: raw.publicationDate ?? null,
    summary: raw.tldr?.text ?? "",
    url: raw.url ?? `https://www.semanticscholar.org/paper/${raw.paperId}`,
    doi: ext.DOI ?? null,
    arxivId: ext.ArXiv ?? null,
    pdf: raw.openAccessPdf?.url || null,
    citationCount: raw.citationCount ?? 0,
    referenceCount: raw.referenceCount ?? 0,
    influentialCitationCount: raw.influentialCitationCount ?? 0,
    source: sourceLink ?? null,
    addedAt: new Date().toISOString().slice(0, 10),
  };
};

/**
 * Looks up many papers. `requests` is [{ id, source }].
 * Returns { found: Record[], missing: [{id, source}] }.
 */
export const fetchPapers = async (requests) => {
  const found = [];
  const missing = [];
  if (!requests.length) return { found, missing };

  const batches = chunk(requests, CORE_CHUNK);
  log.info(
    `Looking up ${requests.length} paper(s) from Semantic Scholar in ${batches.length} batch request(s).`
  );

  for (const [i, batch] of batches.entries()) {
    log.debug(`Core batch ${i + 1}/${batches.length} (${batch.length} ids)`);
    const results = await postBatch(
      batch.map((r) => r.id),
      CORE_FIELDS
    );

    results.forEach((raw, idx) => {
      const req = batch[idx];
      const record = toRecord(raw, req.source);
      if (record) found.push(record);
      else missing.push(req);
    });
  }

  log.info(`Semantic Scholar resolved ${found.length}, missed ${missing.length}.`);
  return { found, missing };
};

/** GETs one paper's citation list, with the same backoff policy as batches. */
const getCitations = async (paperId) => {
  const url = `${BASE}/${paperId}/citations?fields=paperId&limit=${CITATIONS_PER_PAPER}`;
  let wait = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      log.warn(`Network error fetching citations (attempt ${attempt}): ${err.message}`);
      await sleep(backoff(wait));
      wait *= 2;
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      return (data?.data ?? []).map((d) => d?.citingPaper?.paperId).filter(Boolean);
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(wait);
      log.debug(`Citations for ${paperId}: ${res.status}, waiting ${Math.round(delay / 1000)}s.`);
      await sleep(delay);
      wait *= 2;
      continue;
    }

    log.warn(`Could not fetch citations for ${paperId}: HTTP ${res.status}.`);
    return [];
  }

  log.warn(`Gave up fetching citations for ${paperId} after ${MAX_ATTEMPTS} attempts.`);
  return [];
};

/**
 * Fetches the ids of papers citing each given paper, used to rank candidates.
 * Returns Map<paperId, string[]>.
 */
export const fetchCitationIds = async (paperIds) => {
  const out = new Map();
  if (!paperIds.length) return out;

  log.info(`Fetching citation lists for ${paperIds.length} paper(s), one request each.`);

  for (const [i, paperId] of paperIds.entries()) {
    const ids = await getCitations(paperId);
    out.set(paperId, ids);
    log.debug(`(${i + 1}/${paperIds.length}) ${paperId} -> ${ids.length} citing papers`);
  }

  const counts = [...out.values()].map((ids) => ids.length);
  const total = counts.reduce((n, c) => n + c, 0);
  const empty = counts.filter((c) => c === 0).length;
  log.info(`Collected ${total} citation edges across ${paperIds.length} paper(s).`);
  if (empty) {
    log.warn(
      `${empty} paper(s) returned no citations. If that seems wrong it is usually throttling; the next run will retry.`
    );
  }
  return out;
};
