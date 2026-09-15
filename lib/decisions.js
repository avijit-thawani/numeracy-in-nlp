/**
 * Reading a decision out of what was merged.
 *
 * A batch pull request proposes a table of papers as lines in the seed file,
 * and the review is done by deleting the ones you do not want. Merging then
 * says two things at once: keep these, and reject those. The keeping was
 * always handled -- the lines are in the seed file, so the next run ingests
 * them -- but the rejecting was silent, so every deleted paper came straight
 * back in the next run's suggestions, which is worse than not offering the
 * review at all.
 *
 * So each batch branch carries a manifest of what it proposed. The manifest
 * only reaches the default branch when the pull request is merged, and then
 * anything it listed that is neither in the seed file nor already in the
 * survey must have been deleted on purpose.
 */

/** Did this paper survive the review? */
const kept = (paper, seedText, coreIds) => {
  if (coreIds.has(paper.id)) return true;
  // The link is what the seed file carries, and the reader may have edited the
  // comment lines around it, so match on the link alone.
  return Boolean(paper.link) && seedText.includes(paper.link);
};

/**
 * Papers a merged batch proposed and the reader removed.
 *
 * `seedText` is the seed file as it stands after the merge, before the run
 * ingests it -- the run rewrites that file, so this has to be read first.
 */
export const rejectedFrom = ({ proposed, seedText, coreIds }) => {
  const core = coreIds instanceof Set ? coreIds : new Set(coreIds ?? []);
  const text = String(seedText ?? "");

  return (proposed ?? [])
    .filter((paper) => paper?.id && !kept(paper, text, core))
    .map((paper) => ({ id: paper.id, title: paper.title ?? "" }));
};
