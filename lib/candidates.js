import { log } from "./log.js";
import { fetchCitationIds, fetchPapers } from "./semanticScholar.js";

/**
 * A loose title key used to spot the same work appearing twice. Drops case,
 * punctuation, and the filler words that differ between a preprint and its
 * published version ("Limitations of Transformers" vs "Limitations of the
 * Transformers").
 */
const STOP_WORDS = new Set(["a", "an", "the", "of", "on", "in", "for", "with", "and", "to"]);

const normaliseTitle = (title) =>
  String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(" ");

/**
 * Suggests papers to read next.
 *
 * The idea, inherited from the original project: if many papers already in the
 * survey are cited by the same outside paper, that outside paper is probably
 * part of the same conversation. So we count, across the whole library, how
 * often each external paper shows up as a citer, and rank by that count.
 *
 * The original made one HTTP request per candidate spaced four seconds apart,
 * so 200 candidates took over 13 minutes. Here the whole thing is a handful of
 * batch requests.
 */
export const buildCandidates = async ({ papers, limit, dismissedIds }) => {
  if (!papers.length) {
    log.info("No papers in the survey yet, so there is nothing to base suggestions on.");
    return [];
  }

  // OpenAlex-sourced records have no Semantic Scholar citation graph.
  const seedIds = papers.map((p) => p.id).filter((id) => !id.startsWith("openalex:"));
  if (!seedIds.length) {
    log.warn("No Semantic Scholar papers available, so suggestions cannot be computed this run.");
    return [];
  }

  const citationMap = await fetchCitationIds(seedIds);

  const inSurvey = new Set(papers.map((p) => p.id));
  const dismissed = new Set(dismissedIds ?? []);

  const frequency = new Map();
  for (const citerIds of citationMap.values()) {
    for (const citerId of citerIds) {
      if (!citerId || inSurvey.has(citerId) || dismissed.has(citerId)) continue;
      frequency.set(citerId, (frequency.get(citerId) ?? 0) + 1);
    }
  }

  log.stat("distinct citing papers considered", frequency.size);

  // Take more than we need: databases hold near-duplicate records for the same
  // work (a preprint and its published version differ by a word or two in the
  // title), and dropping those below would otherwise leave the list short.
  const ranked = [...frequency.entries()]
    .filter(([, count]) => count > 1) // a single overlap is usually noise
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit + Math.ceil(limit * 0.4));

  if (!ranked.length) {
    log.info(
      "No paper cites more than one item in this survey yet. Add a few more seed papers and suggestions will appear."
    );
    return [];
  }

  log.info(`Hydrating metadata for the top ${ranked.length} suggestion(s).`);
  const { found } = await fetchPapers(ranked.map(([id]) => ({ id, source: null })));

  const scoreById = new Map(ranked);
  const scored = found
    .map((paper) => ({ ...paper, overlap: scoreById.get(paper.id) ?? 0 }))
    .sort((a, b) => b.overlap - a.overlap || b.citationCount - a.citationCount);

  const titlesInSurvey = new Set(papers.map((x) => normaliseTitle(x.title)));
  const seenTitles = new Set();
  const deduped = [];
  for (const paper of scored) {
    const key = normaliseTitle(paper.title);
    // Also catches a suggestion that is really a paper already in the survey
    // under a different record.
    if (seenTitles.has(key) || titlesInSurvey.has(key)) {
      log.debug(`Dropping near-duplicate suggestion: ${paper.title.slice(0, 60)}`);
      continue;
    }
    seenTitles.add(key);
    deduped.push(paper);
  }

  if (deduped.length !== scored.length) {
    log.info(`Dropped ${scored.length - deduped.length} duplicate suggestion(s).`);
  }
  return deduped.slice(0, limit);
};
