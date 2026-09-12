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
