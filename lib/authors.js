import { log } from "./log.js";
import { fetchAuthorName, fetchAuthorPapers, searchAuthors } from "./semanticScholar.js";

/**
 * Seeding a survey from a person rather than from a pile of links.
 *
 * "These are my papers, now tell me what to read" is the shape most people
 * arrive with, and a profile page is the one artefact they already have. One
 * line names the profile; every paper on it becomes Core, and the survey grows
 * itself from there. It also keeps working: the author publishes, the daily run
 * notices, and the new paper joins Core without anyone editing a file.
 *
 * Whatever the line names, the papers themselves always come from Semantic
 * Scholar, for two reasons. It is the only one of these with a keyless
 * publication-list endpoint, and it is the graph the ranking already runs on,
 * so a paper arriving by this route is indistinguishable from one pasted in by
 * hand. OpenAlex is used only for single-record lookups that translate an id
 * into a name, never for `filter=` list queries -- see the note in
 * `lib/openalex.js` for why that distinction is load-bearing.
 */

const OPENALEX = "https://api.openalex.org";

const ORCID = /^(?:https?:\/\/(?:www\.)?orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i;
const OPENALEX_ID = /^(?:openalex:|https?:\/\/(?:api\.)?openalex\.org\/(?:authors\/)?)?(A\d{4,})$/i;

/**
 * Works out what kind of profile a line names. Pure string handling, so the
 * shapes it accepts can be tested without touching the network.
 *
 * Returns `{ kind, value, label }`, or `{ kind: "unsupported" }` with a reason
 * for profiles nobody can query.
 */
export const parseAuthorTarget = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  // Google Scholar has no API, and its profile ids are opaque: the URL carries
  // a user id and not even the person's name, so there is nothing to fall back
  // on. Say that, and say what to paste instead, rather than failing vaguely.
  if (/scholar\.google\./i.test(text)) {
    return {
      kind: "unsupported",
      label: text,
      reason:
        "Google Scholar has no public API and its profile URLs do not contain the author's name. " +
        "Use the Semantic Scholar or OpenAlex profile instead, or just the author's name.",
    };
  }

  const orcid = text.match(ORCID);
  if (orcid) return { kind: "orcid", value: orcid[1].toUpperCase(), label: `ORCID ${orcid[1]}` };

  const openalex = text.match(OPENALEX_ID);
  if (openalex) return { kind: "openalex", value: openalex[1].toUpperCase(), label: `OpenAlex ${openalex[1]}` };

  // Semantic Scholar author pages are /author/<slug>/<numeric id>; the slug is
  // decoration and the id is what the API wants.
  const s2 = text.match(/semanticscholar\.org\/author\/(?:[^/]*\/)?(\d+)/i);
  if (s2) return { kind: "semanticScholar", value: s2[1], label: `Semantic Scholar author ${s2[1]}` };

  if (/^\d{4,}$/.test(text)) {
    return { kind: "semanticScholar", value: text, label: `Semantic Scholar author ${text}` };
  }

  // Anything left that is not a URL is taken as a name to search for.
  if (/^https?:\/\//i.test(text) || text.includes("://")) {
    return {
      kind: "unsupported",
      label: text,
      reason: "That is not a profile this understands. Paste a Semantic Scholar or OpenAlex author page, an ORCID, or the author's name.",
    };
  }

  return { kind: "name", value: text, label: text };
};

/**
 * Turns an OpenAlex author id or an ORCID into a name.
 *
 * Both are single-record lookups, which are the free, unmetered half of the
 * OpenAlex API. Asking OpenAlex for the person's *works* would be a `filter=`
 * query, which is billed, so the name is all we take: Semantic Scholar finds
 * the publication list from there.
 */
const nameFromOpenAlex = async (target, email) => {
  const path = target.kind === "orcid" ? `authors/orcid:${target.value}` : `authors/${target.value}`;
  const url = `${OPENALEX}/${path}` + (email ? `?mailto=${encodeURIComponent(email)}` : "");

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      log.warn(`OpenAlex could not resolve ${target.label} (HTTP ${res.status}).`);
      return null;
    }
    const data = await res.json();
    const name = data?.display_name ?? null;
    if (name) log.info(`${target.label} is ${name}.`);
    return name;
  } catch (err) {
    log.warn(`OpenAlex lookup for ${target.label} failed: ${err.message}`);
    return null;
  }
};

/**
 * Resolves one profile line to a Semantic Scholar author id and their papers.
 *
 * Returns `null` when the profile could not be resolved or the lookup failed.
 * A failure is never reported as an author with no papers: the caller would
 * take that at face value and a throttled run would look like an empty career.
 */
export const resolveAuthorPapers = async ({
  target,
  email,
  search = searchAuthors,
  papersFor = fetchAuthorPapers,
  nameFor = fetchAuthorName,
}) => {
  if (!target || target.kind === "unsupported") {
    if (target?.reason) log.warn(`Cannot seed from "${target.label}". ${target.reason}`);
    return null;
  }

  let authorId = null;
  let name = null;

  if (target.kind === "semanticScholar") {
    authorId = target.value;
  } else {
    // OpenAlex and ORCID give us a name; a bare name already is one. Either
    // way the publication list comes from a Semantic Scholar profile.
    name = target.kind === "name" ? target.value : await nameFromOpenAlex(target, email);
    if (!name) return null;

    // Most published first. Semantic Scholar splits one person across several
    // profiles more often than it merges two people into one, so the fullest
    // profile is the better guess at "the" author.
    const matches = [...(await search(name))].sort((a, b) => (b.paperCount ?? 0) - (a.paperCount ?? 0));
    if (!matches.length) {
      log.warn(`Semantic Scholar has no author profile matching "${name}".`);
      return null;
    }

    authorId = matches[0].authorId;
    name = matches[0].name;

    // Two people share a name far more often than anyone expects, and the
    // consequence here is a survey full of a stranger's work. Show the losers
    // so a wrong pick is obvious and fixable by pasting the profile URL.
    if (matches.length > 1) {
      const others = matches
        .slice(1, 4)
        .map((m) => `${m.name} (${m.paperCount} papers, id ${m.authorId})`)
        .join("; ");
      log.warn(
        `"${target.value}" matched ${matches.length} Semantic Scholar profiles. Using ${name} ` +
          `(${matches[0].paperCount} papers, id ${authorId}). Also matched: ${others}. ` +
          `If that is the wrong person, replace the line with their profile URL.`
      );
    }
  }

  const papers = await papersFor(authorId);
  if (papers === null) {
    log.warn(`Could not read the publication list for ${name ?? target.label}; leaving the survey as it is.`);
    return null;
  }

  // A profile named by id or URL has no name yet, and the publication list
  // does not carry one. Ask for it, but never let that failure sink a
  // successful lookup: a missing name costs a nicer label, nothing more.
  if (!name) name = await nameFor(authorId).catch(() => null);

  return { authorId, name, papers };
};
