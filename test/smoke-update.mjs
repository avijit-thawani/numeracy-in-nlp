/**
 * Runs scripts/update.js end to end with the network stubbed out, against the
 * repository's real data. Not part of `npm test`: it rewrites data/ and views/
 * in place, so it is a local check rather than a test.
 *
 *   node test/smoke-update.mjs
 *
 * The stub answers from data/recs.json and data/core.json, which between them
 * already hold every record a normal run would look up.
 */
import { readFileSync } from "node:fs";

const known = new Map();
for (const [file, key] of [
  ["data/core.json", "core"],
  ["data/recs.json", "recs"],
]) {
  for (const paper of JSON.parse(readFileSync(file, "utf8"))[key] ?? []) {
    known.set(paper.id, paper);
  }
}

const asApiRecord = (paper) => ({
  paperId: paper.id,
  title: paper.title,
  externalIds: { DOI: paper.doi, ArXiv: paper.arxivId },
  url: paper.url,
  tldr: { text: paper.summary },
  venue: paper.venue,
  year: paper.year,
  publicationDate: paper.publicationDate,
  authors: (paper.authors ?? []).map((name) => ({ name })),
  citationCount: paper.citationCount,
  referenceCount: paper.referenceCount,
  influentialCitationCount: paper.influentialCitationCount,
  openAccessPdf: paper.pdf ? { url: paper.pdf } : null,
});

let calls = 0;
globalThis.fetch = async (url, options) => {
  calls++;
  const target = String(url);

  if (target.includes("/paper/batch")) {
    const ids = JSON.parse(options.body).ids;
    const body = ids.map((id) => (known.has(id) ? asApiRecord(known.get(id)) : null));
    return new Response(JSON.stringify(body), { status: 200 });
  }
  // Nothing else should be reached: the graph cache is fresh and there are no
  // new links to resolve. Fail loudly rather than silently going to the wire.
  throw new Error(`unexpected network call to ${target}`);
};

console.log(`Stub ready with ${known.size} known papers.\n`);
await import("../scripts/update.js");
console.log(`\nStub served ${calls} request(s).`);
