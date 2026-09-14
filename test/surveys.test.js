import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSurveys, surveyName, surveyByName } from "../lib/surveys.js";
import { renderIndexBlock, applyIndex, INDEX_START, INDEX_END } from "../lib/renderReadme.js";

/** Builds a throwaway repo layout: each path gets a survey.config.json. */
const repo = (dirs, fn) => {
  const root = mkdtempSync(join(tmpdir(), "surveys-"));
  try {
    for (const dir of dirs) {
      const full = dir === "." ? root : join(root, dir);
      mkdirSync(full, { recursive: true });
      writeFileSync(join(full, "survey.config.json"), "{}");
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a repo with one survey at the root is not an index", () => {
  repo(["."], (root) => {
    const { surveys, index } = findSurveys(root);
    assert.equal(index, false);
    assert.deepEqual(surveys, [root]);
    assert.equal(surveyName(root, surveys[0]), ".");
  });
});

test("an empty repo still offers the root, so a first run has somewhere to write", () => {
  repo([], (root) => {
    const { surveys, index } = findSurveys(root);
    assert.equal(index, false);
    assert.deepEqual(surveys, [root]);
  });
});

test("nested surveys are found and named by their path", () => {
  repo(["demos/dean", "demos/bengio"], (root) => {
    const { surveys, index } = findSurveys(root);
    assert.equal(index, true);
    assert.deepEqual(surveys.map((d) => surveyName(root, d)), ["demos/bengio", "demos/dean"]);
  });
});

/**
 * The template repo is exactly this: a config left at the root from when it
 * was a single survey, plus the demos. Treating the root as a survey too would
 * render an empty table over the landing page every run.
 */
test("a root config is ignored once any survey is nested", () => {
  repo([".", "demos/dean"], (root) => {
    const { surveys, index } = findSurveys(root);
    assert.equal(index, true);
    assert.deepEqual(surveys.map((d) => surveyName(root, d)), ["demos/dean"]);
  });
});

test("a survey's own folders are not searched for more surveys", () => {
  repo(["demos/dean"], (root) => {
    mkdirSync(join(root, "demos/dean/data"), { recursive: true });
    writeFileSync(join(root, "demos/dean/data/survey.config.json"), "{}");
    const { surveys } = findSurveys(root);
    assert.deepEqual(surveys.map((d) => surveyName(root, d)), ["demos/dean"]);
  });
});

test("the code's own directories are never mistaken for surveys", () => {
  repo(["."], (root) => {
    for (const dir of ["lib", "scripts", "node_modules", ".git"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "survey.config.json"), "{}");
    }
    const { surveys, index } = findSurveys(root);
    assert.equal(index, false);
    assert.deepEqual(surveys, [root]);
  });
});

test("a name from an issue only resolves to a survey that exists", () => {
  repo(["demos/dean"], (root) => {
    const { surveys } = findSurveys(root);
    assert.equal(surveyByName(root, surveys, "demos/dean"), join(root, "demos/dean"));
    assert.equal(surveyByName(root, surveys, "./demos/dean/"), join(root, "demos/dean"));
    assert.equal(surveyByName(root, surveys, "demos/elsewhere"), null);
    assert.equal(surveyByName(root, surveys, ""), null);
  });
});

// ---- The index block --------------------------------------------------

const rows = [
  { name: "demos/dean", title: "Jeff Dean", description: "Systems", core: 37, recs: 25, updated: "2026-09-13" },
  { name: "demos/bengio", title: "", description: "", core: 812, recs: 0, updated: null },
];

test("the index links each survey by folder and shows its counts", () => {
  const block = renderIndexBlock(rows);
  assert.match(block, /\[Jeff Dean\]\(demos\/dean\/\)/);
  assert.match(block, /\*\*37\*\* in your list/);
  assert.match(block, /\*\*25\*\* Recs/);
  assert.match(block, /\[demos\/bengio\]\(demos\/bengio\/\)/, "no title falls back to the folder");
  assert.doesNotMatch(block, /\*\*0\*\* Recs/, "a survey with no Recs yet says nothing rather than zero");
});

test("the index replaces itself rather than stacking up", () => {
  let text = `# Repo\n\n${INDEX_START}\nold\n${INDEX_END}\n\nProse below.\n`;
  for (let i = 0; i < 3; i++) text = applyIndex(text, renderIndexBlock(rows));
  assert.equal(text.match(/Jeff Dean/g).length, 1);
  assert.match(text, /Prose below\./, "prose outside the markers survives");
});

/**
 * No markers means the owner has not asked for an index, and a README is the
 * one page a repo has to explain itself with. Returning null lets the caller
 * leave it alone rather than prepending a table to it.
 */
test("a README without markers is left alone", () => {
  assert.equal(applyIndex("# My repo\n\nHand written.\n", renderIndexBlock(rows)), null);
});
