import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Records a rejected paper so it is never suggested again.
 *
 * Called when a Rec's pull request is closed without merging. The id comes
 * from the branch name, which is why that name carries the paper's full
 * Semantic Scholar id rather than a shortened one: this list is matched
 * against `rec.id` exactly.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "data/dismissed.json");

const [id, title = ""] = process.argv.slice(2);
if (!id) {
  console.error("Usage: node scripts/dismiss.js <paperId> [title]");
  process.exit(1);
}

mkdirSync(dirname(PATH), { recursive: true });

let store = { ids: [], notes: {} };
if (existsSync(PATH)) {
  try {
    store = JSON.parse(readFileSync(PATH, "utf8"));
  } catch (err) {
    console.error(`data/dismissed.json is not valid JSON (${err.message}). Refusing to overwrite.`);
    process.exit(1);
  }
}
store.ids = Array.isArray(store.ids) ? store.ids : [];
store.notes = store.notes ?? {};

if (store.ids.includes(id)) {
  console.log(`${id} was already dismissed.`);
} else {
  store.ids.push(id);
  if (title) store.notes[id] = title.replace(/^Add:\s*/, "");
  writeFileSync(PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  console.log(`Dismissed ${id}${title ? ` (${title})` : ""}.`);
}
