import { log } from "./log.js";
import { scoreCore, scoreRecs, applyAuthority } from "./score.js";
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
 * How recent a paper is, in days, or null if it does not say.
 *
 * `publicationDate` is exact but missing on plenty of records, so a bare year
 * falls back to the middle of that year: guessing January would make every
 * undated 2026 paper look like the freshest thing in the list every January.
 */
export const ageInDays = (paper, now = Date.now()) => {
  const exact = paper?.publicationDate ? Date.parse(paper.publicationDate) : NaN;
  const when = Number.isFinite(exact)
    ? exact
    : paper?.year
      ? Date.parse(`${paper.year}-07-01`)
      : NaN;
  if (!Number.isFinite(when)) return null;
  return (now - when) / 86_400_000;
};

const DEFAULT_WINDOWS = [
  { days: 30, count: 10, label: "past month" },
  { days: 365, count: 10, label: "past year" },
];

/**
 * Reserves the top of the Recs list for recent work.
 *
 * Score alone buries new papers. A paper published last month has had no time
 * to be cited, and both directions of the ranking are counts, so it loses to
 * anything established -- which is exactly backwards for the reader who just
 * seeded a survey from their own profile and wants to know what appeared while
 * they were writing. So the list is built in windows: the best few from the
 * last month, then the best few from the last six months, then everything else
 * by score as before.
 *
 * The windows do not overlap (a paper from last week is only ever in the first
 * one) and they are filled by our own score, so this changes which papers get
 * a place, never how they are judged. A window that cannot be filled simply
 * gives its slots back to the general pool.
 */
export const applyFreshness = (scored, { windows = DEFAULT_WINDOWS, limit, minOverlap = 0, now = Date.now() } = {}) => {
  const sorted = [...windows].sort((a, b) => a.days - b.days);
  const taken = new Set();
  const head = [];

  for (const window of sorted) {
    // Sorted here rather than trusting the caller's order: the whole claim of
    // this function is that a reserved slot still goes to the best paper.
    const inWindow = scored
      .filter((paper) => {
        if (taken.has(paper.id)) return false;
        // A reserved slot is a promotion over better-connected work, so it
        // asks for more than the minimum. Without this the recent tables fill
        // with whatever brushed past the floor: on a 20-paper survey every one
        // of the ten was a barely-related paper citing the same two famous
        // entries. An unfillable window gives its slots back, which is a
        // better answer than ten papers about something else.
        if ((paper.overlap ?? 0) < minOverlap) return false;
        const age = ageInDays(paper, now);
        return age !== null && age >= 0 && age <= window.days;
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    for (const paper of inWindow.slice(0, Math.max(0, window.count ?? 0))) {
      taken.add(paper.id);
      head.push({ ...paper, freshWindow: window.label ?? `past ${window.days} days` });
    }
  }

  const rest = scored.filter((paper) => !taken.has(paper.id));
  const combined = [...head, ...rest];
  return typeof limit === "number" ? combined.slice(0, limit) : combined;
};

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
    log.info("Nothing in your list yet, so there is nothing to base Recs on.");
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

  /**
   * The same tally, but counting *which* of your papers were cited rather than
   * how many.
   *
   * Not every citation of your list says the same thing. A survey of 20
   * numeracy papers contains a couple that half the field cites -- a benchmark,
   * a famous model -- and any recent paper on any subject will cite two of
   * those in passing. Counted equally, those papers fill the recent tables with
   * work that has nothing to do with the topic: ten arrived on one survey at
   * once, all agent and inference papers, all "cites 2 in your list".
   *
   * So an edge is worth less when it comes from a paper the whole world cites.
   * Citing your obscure arithmetic-extrapolation paper is strong evidence of
   * shared subject; citing the MATH benchmark is nearly none. Same idea as the
   * popularity penalty on the backward direction, pointed the other way, and
   * the raw count is still what the Why column reports.
   */
  const specificity = (edgeMap, penalty, strongSets = new Map(), boost = 0) => {
    const counts = new Map();
    const weights = new Map();

    for (const [seedId, ids] of edgeMap) {
      const timesCited = Math.max(seedCitations.get(seedId) ?? 1, 1);
      const worth = 1 / Math.pow(timesCited, penalty);
      const strong = strongSets.get(seedId);

      for (const id of ids) {
        if (!id || inSurvey.has(id) || dismissed.has(id)) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        // Semantic Scholar says whether a citation was methodology, result or
        // just background, and flags a few as influential. Where it says
        // nothing -- about 40% of edges -- the edge keeps its plain worth, so
        // this only ever lifts, never demotes for missing data.
        weights.set(id, (weights.get(id) ?? 0) + worth * (strong?.has(id) ? 1 + boost : 1));
      }
    }
    return { counts, weights };
  };

  const seedCitations = new Map(papers.map((p) => [p.id, p.citationCount ?? 0]));

  // Forward: papers that cite yours. These are newer work building on the
  // survey, and are what makes it "living".
  // Edges come from the cache, which refreshes only what is new or stale, so
  // a large survey costs a bounded amount per run.
  const { citationEdges, referenceEdges, citationCounts, strongCitations, strongReferences } = await log.phase("refreshing the citation graph", () =>
    refreshGraph({
      graph,
      paperIds: seedIds,
      // Lets the cache spend its budget on the papers whose citation lists
      // actually move. See stalenessAllowance.
      years: new Map(papers.map((x) => [x.id, x.year])),
      maxAgeDays: algorithm.graphMaxAgeDays ?? 7,
      ageAware: algorithm.graphAgeAware !== false,
      budget: algorithm.graphBudget ?? 150,
      concurrency: algorithm.concurrency,
    })
  );

  // `specificityPenalty` of 0 restores the old behaviour, where every citation
  // of your list counted the same; `intentBoost` of 0 ignores what the API
  // says about why the citation was made.
  const intentBoost = Number(algorithm.intentBoost ?? 0.5);
  const forwardSpecificity = specificity(
    citationEdges,
    Number(algorithm.specificityPenalty ?? 0.3),
    strongCitations,
    intentBoost
  );
  const forward = algorithm.forward !== false ? forwardSpecificity.counts : new Map();
  const forwardWeights = forwardSpecificity.weights;

  // Backward: papers that yours cite. These are the foundations of the topic,
  // and are invisible to the forward pass because they predate your papers and
  // never cite them back.
  const globalCitations = citationCounts;
  // No specificity penalty on this side -- the popularity penalty below is the
  // backward equivalent -- but the same intent bonus: a paper your work
  // actually built on beats one mentioned in an introduction.
  const backwardSpecificity = specificity(referenceEdges, 0, strongReferences, intentBoost);
  const backward = algorithm.backward !== false ? backwardSpecificity.counts : new Map();
  const backwardWeights = backwardSpecificity.weights;

  log.stat("papers citing this survey", forward.size);
  log.stat("papers cited by this survey", backward.size);

  // A floor of 2 used to be hard-coded here, which silently ignored the
  // documented `minCount` setting -- and 1 is the one value a survey too small
  // to produce Recs actually wants. Clamped at 1 only, since 0 would rank
  // every paper the graph has ever seen.
  const minCount = Math.max(1, Math.floor(Number(algorithm.minCount)) || 2);

  // Ranking happens before metadata, so at this point we know how many of your
  // papers each candidate connects to but not when it was published. With the
  // recency windows on, a candidate cut here can never make the list -- and the
  // papers they are meant to surface are precisely the ones with the weakest
  // counts, because they are new. So take a much deeper slice and let the
  // windows choose from it. The cost is metadata for a few hundred papers,
  // which is one or two batch requests.
  const freshness = algorithm.freshness ?? {};
  const freshnessOn = freshness.enabled !== false;
  const overFetch = freshnessOn
    ? Math.max(limit + Math.ceil(limit * 0.4), Number(freshness.pool) || 400)
    : limit + Math.ceil(limit * 0.4);

  // Ordered by how *specific* the citations are, but still reported and
  // filtered by the plain count, which is what the reader is told.
  const rankForward = [...forward.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => (forwardWeights.get(b[0]) ?? 0) - (forwardWeights.get(a[0]) ?? 0) || b[1] - a[1])
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
    .map(([id, c]) => [
      id,
      c,
      (backwardWeights.get(id) ?? c) / Math.pow(Math.max(globalCitations.get(id) ?? 1, 1), penalty),
    ])
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
        `Semantic Scholar returned no citation data for any of the ${seedIds.length} paper(s) in your list, ` +
          `which is normally throttling rather than an empty graph. Keeping the previous Recs.`
      );
    } else {
      log.info(
        `No outside paper connects to ${minCount} or more papers in your list yet. Add a few more seed papers and Recs will appear.`
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
  const { found } = await log.phase("fetching suggestion details", () =>
    hydrate(wanted.map((id) => ({ id, source: null })))
  );

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
    // Weights, not counts: a paper that cites two obscure papers of yours is a
    // better suggestion than one that cites two everybody cites, and the Score
    // should say so.
    forwardCounts: new Map(rankForward.map(([id]) => [id, forwardWeights.get(id) ?? 0])),
    backwardScores: new Map(rankBackward.map(([id, , s]) => [id, s])),
  });

  const rankById = new Map(ranked.map(([id, count, dir]) => [id, { count, dir }]));

  const scored = found.map((paper) => {
    const hit = rankById.get(paper.id);
    const seed = seededById.get(paper.id);
    let why = "related";
    if (hit?.dir === "forward") why = `cites ${hit.count} in your list`;
    else if (hit?.dir === "backward") why = `cited by ${hit.count} in your list`;
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

  // Authority is applied here rather than inside scoreRecs because it needs
  // the author metadata, which only exists once the candidates are hydrated.
  const withAuthority = applyAuthority(scored, Number(algorithm.authorityWeight ?? 0.2));
  scored.length = 0;
  scored.push(...withAuthority);

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
  const citationPool = deduped.filter((x) => !x.fromReferences);
  const fromCitations = freshnessOn
    ? applyFreshness(citationPool, {
        windows: Array.isArray(freshness.windows) && freshness.windows.length ? freshness.windows : undefined,
        limit,
        // One more connection than the list floor: a reserved slot has to be
        // earned, not merely qualified for.
        minOverlap: Number.isFinite(Number(freshness.minCount)) ? Number(freshness.minCount) : minCount + 1,
      }).map((paper) =>
        // The Why column has to say why a paper is above better-connected ones,
        // or the reserved slots read as a broken sort.
        paper.freshWindow ? { ...paper, why: `${paper.freshWindow} · ${paper.why}` } : paper
      )
    : citationPool.slice(0, limit);

  if (freshnessOn) {
    const reserved = fromCitations.filter((x) => x.freshWindow).length;
    log.stat("Recs held for recent work", reserved);
  }
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
