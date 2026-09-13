import { log } from "./log.js";

/**
 * Parsers for the two formats every reference manager can export: BibTeX and
 * RIS. Written by hand rather than pulled from npm so the Action needs no
 * install step.
 *
 * Neither parser tries to be complete. We only need enough to identify each
 * entry -- a DOI, an arXiv id, a URL, or failing those a title to look up.
 */

/**
 * Strips TeX braces and escapes from a field value.
 *
 * Order matters, and getting it wrong ate a word. Stripping braces first turns
 * BibTeX's literal-brace escape `{\{}PMI{\}}` into `\PMI`, which the macro
 * rule then reads as a TeX command and deletes -- so
 * "{\{}PMI{\}}-Masking: Principled masking of correlated spans" reached the
 * title search as "\-Masking: Principled masking of correlated spans" and
 * could never match. Escaped characters are resolved first, so by the time
 * braces go, nothing looks like a macro that is not one.
 */
const clean = (value) =>
  String(value ?? "")
    // Escaped punctuation: \{ \} \& \_ \% \$ \# all stand for themselves.
    .replace(/\\([{}&_%$#])/g, "$1")
    // Accents and similar, where the letter to keep is inside the braces:
    // \"{o} -> o, \'{e} -> e.
    .replace(/\\[`'"^~=.]\s*\{?([a-zA-Z])\}?/g, "$1")
    // Remaining commands carry no content we want.
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    // A command at the start can leave the title opening on punctuation.
    .replace(/^[\s:,;.\-]+/, "")
    .trim();

/**
 * Splits a .bib file into entries by tracking brace depth, which handles the
 * nested braces BibTeX uses to protect capitalisation (`{BERT}`).
 */
const splitBibEntries = (text) => {
  const entries = [];
  const re = /@(\w+)\s*\{/g;
  let match;

  while ((match = re.exec(text))) {
    const type = match[1].toLowerCase();
    if (type === "comment" || type === "preamble" || type === "string") continue;

    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    entries.push(text.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return entries;
};

/** Pulls `field = {value}` / `field = "value"` / `field = value` pairs. */
const parseBibFields = (body) => {
  const fields = {};
  const re = /(\w+)\s*=\s*/g;
  let match;

  while ((match = re.exec(body))) {
    const key = match[1].toLowerCase();
    let i = re.lastIndex;
    while (i < body.length && /\s/.test(body[i])) i++;

    let value = "";
    if (body[i] === "{" || body[i] === '"') {
      const open = body[i];
      const close = open === "{" ? "}" : '"';
      let depth = 1;
      i++;
      const start = i;
      while (i < body.length && depth > 0) {
        if (open === "{" && body[i] === "{") depth++;
        else if (body[i] === close) depth--;
        if (depth > 0) i++;
      }
      value = body.slice(start, i);
      i++;
    } else {
      const start = i;
      while (i < body.length && body[i] !== ",") i++;
      value = body.slice(start, i);
    }
    fields[key] = clean(value);
    re.lastIndex = i;
  }
  return fields;
};

/** Turns one entry's fields into something we can look up. */
const identify = (fields) => {
  const title = fields.title || fields.t1 || "";

  if (fields.doi) return { id: `DOI:${fields.doi.replace(/^https?:\/\/doi\.org\//i, "")}`, title };

  // arXiv entries usually carry eprint, sometimes with an archivePrefix.
  const eprint = fields.eprint || fields.arxivid || fields.arxiv;
  if (eprint && (!fields.archiveprefix || /arxiv/i.test(fields.archiveprefix))) {
    return { id: `arXiv:${eprint.replace(/^arxiv:/i, "")}`, title };
  }

  // Exports from Google Scholar and friends bury the identifier in prose, as
  // in journal={arXiv preprint arXiv:2304.07359}. Worth digging out: the
  // alternative is a title search, which is slower and can match the wrong
  // paper. Scanning every field catches note=, howpublished= and the rest.
  const haystack = Object.values(fields).join(" ");
  const loose = haystack.match(/arXiv[:\s]\s*(\d{4}\.\d{4,5})/i);
  if (loose) return { id: `arXiv:${loose[1]}`, title };

  const looseDoi = haystack.match(/\b(10\.\d{4,9}\/[^\s,}]+)/);
  if (looseDoi) return { id: `DOI:${looseDoi[1].replace(/[.,;]+$/, "")}`, title };

  if (fields.url) return { url: fields.url, title };

  // No identifier at all: fall back to matching on the title.
  if (title) return { title, needsTitleMatch: true };

  return null;
};

export const parseBibTeX = (text) => {
  const out = [];
  for (const body of splitBibEntries(text)) {
    const entry = identify(parseBibFields(body));
    if (entry) out.push(entry);
  }
  return out;
};

/**
 * RIS is line-oriented: a two-letter tag, two spaces, a hyphen, then the value.
 * `ER` ends each record.
 */
export const parseRIS = (text) => {
  const out = [];
  let current = {};

  const flush = () => {
    if (Object.keys(current).length) {
      const entry = identify(current);
      if (entry) out.push(entry);
    }
    current = {};
  };

  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/);
    if (!match) continue;
    const [, tag, value] = match;

    if (tag === "ER") {
      flush();
      continue;
    }
    if (tag === "DO") current.doi = clean(value);
    else if (tag === "TI" || tag === "T1") current.title = clean(value);
    else if (tag === "UR" && !current.url) current.url = clean(value);
  }
  flush();
  return out;
};

/** Dispatches on file extension. */
export const parseBibliography = (filename, text) => {
  const isRis = /\.ris$/i.test(filename);
  const entries = isRis ? parseRIS(text) : parseBibTeX(text);
  log.info(`Parsed ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${filename}.`);
  return entries;
};
