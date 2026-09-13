import { log } from "./log.js";
import { scoreCore, scoreRecs } from "./score.js";
import { fetchPapers } from "./semanticScholar.js";
import { refreshGraph } from "./graphCache.js";

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
export const buildRecommendations = async ({
  core,
  limit,
  dismissedIds,
  seeded,
  algorithm = {},
  graph = new Map(),
  // The one network call left in this function, injectable so the ranking can
  // be tested without it. A pre-populated `graph` covers the other two.
  hydrate = fetchPapers,
}) => {
  const papers = core;
  const inSurvey = new Set(papers.map((x) => x.id));
  const dismissed = new Set(dismissedIds ?? []);

  // Papers pulled in from a survey's bibliography. They are suggestions rather
  // than accepted papers: someone else curated them, not the owner.
  const seededPending = (seeded ?? []).filter(
    (s) => !inSurvey.has(s.id) && !dismissed.has(s.id)
  );

  if (!papers.length && !seededPending.length) {
    log.info("Nothing in Core yet, so there is nothing to base Recs on.");
    return { recs: [], coreScores: new Map() };
  }

  // OpenAlex-sourced records have no Semantic Scholar citation graph.
  const seedIds = papers.map((p) => p.id).filter((id) => !id.startsWith("openalex:"));
  if (!seedIds.length && papers.length) {
    log.warn("No Semantic Scholar papers available, so suggestions cannot be computed this run.");
  }

  const tally = (edgeMap) => {
    const counts = new Map();
    for (const ids of edgeMap.values()) {
      for (const id of ids) {
        if (!id || inSurvey.has(id) || dismissed.has(id)) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  };

  // Forward: papers that cite yours. These are newer work building on the
  // survey, and are what makes it "living".
  // Edges come from the cache, which refreshes only what is new or stale, so
  // a large survey costs a bounded amount per run.
  const { citationEdges, referenceEdges, citationCounts } = await refreshGraph({
    graph,
    paperIds: seedIds,
    maxAgeDays: algorithm.graphMaxAgeDays ?? 7,
    budget: algorithm.graphBudget ?? 150,
    concurrency: algorithm.concurrency,
  });

  const forward = algorithm.forward !== false ? tally(citationEdges) : new Map();

  // Backward: papers that yours cite. These are the foundations of the topic,
  // and are invisible to the forward pass because they predate your papers and
  // never cite them back.
  const globalCitations = citationCounts;
  const backward = algorithm.backward !== false ? tally(referenceEdges) : new Map();

  log.stat("papers citing this survey", forward.size);
  log.stat("papers cited by this survey", backward.size);

  // A floor of 2 used to be hard-coded here, which silently ignored the
  // documented `minCount` setting -- and 1 is the one value a survey too small
  // to produce Recs actually wants. Clamped at 1 only, since 0 would rank
  // every paper the graph has ever seen.
  const minCount = Math.max(1, Math.floor(Number(algorithm.minCount)) || 2);
  const overFetch = limit + Math.ceil(limit * 0.4);

  const rankForward = [...forward.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, overFetch);

  // The backward direction needs a popularity penalty or it returns the field's
  // plumbing: every numeracy paper cites Adam and BERT, which says nothing
  // about numeracy. Dividing the co-citation count by citationCount^0.2 is the
  // same idea as the IDF term in TF-IDF, with global citation count standing in
  // for document frequency. Tuned on a 20-paper survey: raw counts put 4
  // generic papers in the top 10, this puts 0. A square-root penalty (0.5)
  // over-corrects and surfaces obscure papers cited twice.
  const penalty = algorithm.popularityPenalty ?? 0.2;
  const rankBackward = [...backward.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([id, c]) => [id, c, c / Math.pow(Math.max(globalCitations.get(id) ?? 1, 1), penalty)])
    .sort((a, b) => b[2] - a[2])
    .slice(0, overFetch);

  // Interleave, so neither direction crowds the other out.
  const ranked = [];
  const seenRank = new Set();
  for (let i = 0; i < Math.max(rankForward.length, rankBackward.length); i++) {
    for (const [entry, dir] of [
      [rankForward[i], "forward"],
      [rankBackward[i], "backward"],
    ]) {
      if (!entry || seenRank.has(entry[0])) continue;
      seenRank.add(entry[0]);
      ranked.push([entry[0], entry[1], dir]);
    }
  }

  // Nothing was ranked. Core is still scored and returned: leaving the Score
  // column reading zero was a bug, not a result.
  //
  // Two very different situations arrive here, and they need opposite
  // handling. A small survey genuinely has no Recs yet, so an empty list is
  // the right answer. A throttled run, where every citation list came back
  // empty, has no answer at all -- and 429s are routine enough that treating
  // that as "no Recs" would wipe a perfectly good list.
  if (!ranked.length && !seededPending.length) {
    const haveEdges = [...citationEdges.values(), ...referenceEdges.values()].some(
      (ids) => ids.length
    );
    const starved = seedIds.length > 0 && !haveEdges;

    if (starved) {
      log.warn(
        `Semantic Scholar returned no citation data for any of the ${seedIds.length} paper(s) in Core, ` +
          `which is normally throttling rather than an empty graph. Keeping the previous Recs.`
      );
    } else {
      log.info(
        `No outside paper connects to ${minCount} or more papers in Core yet. Add a few more seed papers and Recs will appear.`
      );
    }

    return {
      recs: [],
      coreScores: scoreCore({ core: papers, citationEdges, referenceEdges }),
      hydrationFailed: starved,
    };
  }

  // Fetch the citation-ranked suggestions and the bibliography-seeded ones
  // together, so it stays a single batch request.
  const seededById = new Map(seededPending.map((s) => [s.id, s]));
  const wanted = [...new Set([...ranked.map(([id]) => id), ...seededById.keys()])];

  log.info(`Hydrating metadata for ${wanted.length} suggestion(s).`);
  const { found } = await hydrate(wanted.map((id) => ({ id, source: null })));

  // The ranking worked but the API would not return the metadata, which during
  // heavy throttling means every one of them. Say so, rather than returning an
  // empty list that the caller would write over a perfectly good one.
  if (wanted.length && !found.length) {
    log.warn(
      `Ranked ${wanted.length} suggestion(s) but could not fetch details for any of them. Keeping the previous list.`
    );
    return { recs: [], coreScores: scoreCore({ core: papers, citationEdges, referenceEdges }), hydrationFailed: true };
  }

  const recScores = scoreRecs({
    forwardCounts: new Map(rankForward.map(([id, c]) => [id, c])),
    backwardScores: new Map(rankBackward.map(([id, , s]) => [id, s])),
  });

  const rankById = new Map(ranked.map(([id, count, dir]) => [id, { count, dir }]));

  const scored = found.map((paper) => {
    const hit = rankById.get(paper.id);
    const seed = seededById.get(paper.id);
    let why = "related";
    if (hit?.dir === "forward") why = `cites ${hit.count} in Core`;
    else if (hit?.dir === "backward") why = `cited by ${hit.count} in Core`;
    else if (seed) why = `from ${seed.fromTitle ?? "a bibliography you added"}`;

    return {
      ...paper,
      overlap: hit?.count ?? 0,
      direction: hit?.dir ?? null,
      score: recScores.get(paper.id) ?? 0,
      why,
      fromReferences: Boolean(seed) && !hit,
    };
  });

  // Score already blends the two directions, so it can drive the order
  // directly; bibliography entries have no score and trail behind.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.fromReferences) - Number(b.fromReferences) ||
      b.citationCount - a.citationCount
  );

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

  // `limit` caps the citation-derived suggestions. Papers seeded from a
  // bibliography were asked for explicitly, so they are all kept.
  const fromCitations = deduped.filter((x) => !x.fromReferences).slice(0, limit);
  const fromReferences = deduped.filter((x) => x.fromReferences);
  if (fromReferences.length) {
    log.stat("recs from bibliographies", fromReferences.length);
  }

  return {
    recs: [...fromCitations, ...fromReferences],
    coreScores: scoreCore({ core: papers, citationEdges, referenceEdges }),
    hydrationFailed: false,
  };
};
