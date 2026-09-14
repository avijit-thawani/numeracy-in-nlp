/**
 * Scores, on a 0 to 100 scale, for both lists.
 *
 * The question a score answers is the same in both cases: how tied into this
 * survey is this paper? A paper is tied in when it cites, or is cited by, the
 * papers already here.
 *
 * Every score is relative to the strongest member of its own list, so 100
 * always means "the most connected thing here" and the full range always gets
 * used. That has three properties worth keeping:
 *
 *   - bounded, so it reads as a percentage and sorts sensibly;
 *   - a one-paper survey scores 100, since it is trivially its own centre;
 *   - a list nobody is connected to scores 0 across the board rather than
 *     dividing by zero.
 *
 * It is deliberately relative, not absolute. An absolute measure (share of the
 * survey each paper touches) sounds tidier but in practice sits in the single
 * digits for almost everything, which sorts fine but reads as though the survey
 * is broken.
 */

/**
 * Kept as a float rather than rounded here. Counts are small integers, so
 * rounding at this point collapses distinct papers onto the same score and the
 * default ordering becomes arbitrary. Rounding happens once, at render.
 */
const scale = (values) => {
  const max = Math.max(0, ...values.values());
  const out = new Map();
  for (const [id, raw] of values) {
    out.set(id, max > 0 ? (raw / max) * 100 : raw > 0 ? 100 : 0);
  }
  return out;
};

/**
 * Centrality for papers in Core: how many other Core papers each one is joined
 * to, in either direction.
 *
 * Costs no extra API calls, because the recommendation pass has already
 * fetched every Core paper's citations and references.
 */
export const scoreCore = ({ core, citationEdges, referenceEdges }) => {
  const ids = new Set(core.map((p) => p.id));
  if (core.length <= 1) {
    return new Map(core.map((p) => [p.id, 100]));
  }

  const connections = new Map();
  const bump = (id, n) => connections.set(id, (connections.get(id) ?? 0) + n);

  for (const paper of core) {
    const citedBy = (citationEdges.get(paper.id) ?? []).filter((x) => ids.has(x)).length;
    const cites = (referenceEdges.get(paper.id) ?? []).filter((x) => ids.has(x)).length;
    bump(paper.id, citedBy + cites);
  }

  return scale(connections);
};

/**
 * Scores for Recs.
 *
 * Each direction is scaled against its own strongest member before the two are
 * combined, so the popularity penalty on the backward direction does not push
 * every foundational paper below every recent one. Without that, sorting by a
 * single score would quietly undo the point of having two directions.
 */
export const scoreRecs = ({ forwardCounts, backwardScores }) => {
  const f = scale(forwardCounts);
  const b = scale(backwardScores);

  const out = new Map();
  for (const id of new Set([...f.keys(), ...b.keys()])) {
    out.set(id, Math.max(f.get(id) ?? 0, b.get(id) ?? 0));
  }
  return out;
};

/**
 * Nudges a paper's score by how established its authors are.
 *
 * The connection score answers "is this in your conversation?" and says
 * nothing about whether the paper is likely to be any good. For a paper
 * published last month there is nothing else to go on: it has no citations, so
 * every citation-derived measure is zero. The best author's h-index is the one
 * signal available on day one.
 *
 * Deliberately a multiplier on the existing score rather than a term added to
 * it, and deliberately small: connection stays the ranking, and authority only
 * breaks ties within it. A famous author writing outside your topic should not
 * outrank a paper that cites four of yours, which is exactly what an additive
 * term would do.
 *
 * `log10` because h-indexes are long-tailed: the distance from 5 to 20 means
 * far more than the distance from 80 to 95, and a linear term would make the
 * list a directory of the field's most senior people.
 */
export const authorityFactor = (topAuthors, weight) => {
  if (!weight) return 1;
  const best = Math.max(0, ...(topAuthors ?? []).map((a) => (Number.isFinite(a?.hIndex) ? a.hIndex : 0)));
  if (best <= 0) return 1;

  // log10(1+h)/2 is 0 at h=0, 0.5 at h≈9, 1 at h≈99. So at the default weight
  // of 0.2 a well-known author is worth about 20% and a new one nothing.
  return 1 + weight * Math.min(1, Math.log10(1 + best) / 2);
};

/**
 * Applies that factor across a list and rescales, so the top is still 100 and
 * the column keeps meaning the same thing.
 */
export const applyAuthority = (papers, weight) => {
  if (!weight) return papers;

  const adjusted = papers.map((p) => ({ ...p, score: (p.score ?? 0) * authorityFactor(p.topAuthors, weight) }));
  const max = Math.max(0, ...adjusted.map((p) => p.score));
  if (max <= 0) return adjusted;

  return adjusted.map((p) => ({ ...p, score: (p.score / max) * 100 }));
};
