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

// How many graph requests to have in flight at once. The citation and
// reference passes are one request per paper, so a 474-paper survey is ~950
// round trips; sequentially that is a very long run. Four is deliberately
// modest: the unauthenticated pool is shared with everyone and throttles under
// load, so pushing this higher mostly buys more 429s and more backoff.
export const DEFAULT_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving order.
 * Reports progress, since these passes are the slow part of a run and silence
 * for several minutes looks like a hang.
 */
const mapPool = async (items, limit, fn, label) => {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const started = Date.now();

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      done++;
      if (label && (done % 25 === 0 || done === items.length)) {
        const rate = done / ((Date.now() - started) / 1000);
        const left = Math.round((items.length - done) / Math.max(rate, 0.01));
        log.info(
          `${label}: ${done}/${items.length}` +
            (done < items.length ? `, about ${left}s left` : "")
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

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

/**
 * Fetches, for each given paper, the ids of the papers it cites.
 *
 * Also returns how often each cited paper is cited globally, which the
 * backward ranking needs to discount ubiquitous works.
 */
export const fetchReferenceIdsFor = async (paperIds, concurrency = DEFAULT_CONCURRENCY) => {
  const edges = new Map();
  const citationCounts = new Map();
  if (!paperIds.length) return { edges, citationCounts };

  log.info(
    `Fetching reference lists for ${paperIds.length} paper(s), ${concurrency} at a time.`
  );

  await mapPool(paperIds, concurrency, async (paperId) => {
    const url = `${BASE}/${paperId}/references?fields=paperId,citationCount&limit=1000`;
    let wait = 2000;
    let rows = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && rows === null; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          rows = (await res.json())?.data ?? [];
        } else if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after"));
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(wait)
          );
          wait *= 2;
        } else {
          log.warn(`Could not fetch references for ${paperId}: HTTP ${res.status}.`);
          rows = [];
        }
      } catch (err) {
        log.debug(`Reference fetch error (attempt ${attempt}): ${err.message}`);
        await sleep(backoff(wait));
        wait *= 2;
      }
    }

    const ids = [];
    for (const row of rows ?? []) {
      const cited = row?.citedPaper;
      if (!cited?.paperId) continue;
      ids.push(cited.paperId);
      citationCounts.set(cited.paperId, cited.citationCount ?? 0);
    }
    edges.set(paperId, ids);
  }, "references");

  const total = [...edges.values()].reduce((n, ids) => n + ids.length, 0);
  log.info(`Collected ${total} reference edges.`);
  return { edges, citationCounts };
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
 * Fetches the papers a given paper cites.
 *
 * This is what makes "seed from a survey" work: a survey's reference list is a
 * reading list someone already curated by hand, so one request turns a single
 * link into a whole starting bibliography.
 */
export const fetchReferences = async (identifier) => {
  const url = `${BASE}/${encodeURIComponent(identifier)}/references?fields=paperId,title&limit=1000`;
  let wait = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      log.warn(`Network error fetching references (attempt ${attempt}): ${err.message}`);
      await sleep(backoff(wait));
      wait *= 2;
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const ids = (data?.data ?? []).map((d) => d?.citedPaper?.paperId).filter(Boolean);
      log.info(`${identifier} cites ${ids.length} paper(s).`);
      return ids;
    }
    if (res.status === 404) {
      log.warn(`Could not find ${identifier}, so its references could not be used as seeds.`);
      return [];
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(wait);
      log.warn(`Semantic Scholar returned ${res.status} fetching references; waiting.`);
      await sleep(delay);
      wait *= 2;
      continue;
    }
    log.warn(`Could not fetch references for ${identifier}: HTTP ${res.status}.`);
    return [];
  }
  log.warn(`Gave up fetching references for ${identifier}.`);
  return [];
};

/**
 * Resolves a bare title to a paper. Used for bibliography entries that carry
 * no DOI, arXiv id or URL, which is common in hand-maintained .bib files.
 */
export const matchByTitle = async (title) => {
  const url = `${BASE}/search/match?query=${encodeURIComponent(title)}&fields=paperId,title`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const hit = (await res.json())?.data?.[0];
    if (!hit?.paperId) return null;
    log.debug(`Title matched: "${title.slice(0, 50)}" -> ${hit.title?.slice(0, 50)}`);
    return hit.paperId;
  } catch (err) {
    log.debug(`Title match failed for "${title.slice(0, 40)}": ${err.message}`);
    return null;
  }
};

/**
 * Fetches the ids of papers citing each given paper, used to rank candidates.
 * Returns Map<paperId, string[]>.
 */
export const fetchCitationIds = async (paperIds, concurrency = DEFAULT_CONCURRENCY) => {
  const out = new Map();
  if (!paperIds.length) return out;

  log.info(`Fetching citation lists for ${paperIds.length} paper(s), ${concurrency} at a time.`);

  await mapPool(
    paperIds,
    concurrency,
    async (paperId) => {
      out.set(paperId, await getCitations(paperId));
    },
    "citations"
  );

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
