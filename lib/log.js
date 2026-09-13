import { appendFileSync } from "node:fs";

const START = Date.now();
const isCI = Boolean(process.env.GITHUB_ACTIONS);

// Collected for the run summary that gets written to the Actions job page.
const notes = { warnings: [], errors: [], stats: {} };

const elapsed = () => `${((Date.now() - START) / 1000).toFixed(1)}s`;

const emit = (level, msg) => {
  const line = `[${elapsed().padStart(6)}] ${level.padEnd(5)} ${msg}`;
  console.log(line);
};

export const log = {
  info: (msg) => emit("INFO", msg),
  step: (msg) => {
    emit("STEP", `\u2500\u2500 ${msg}`);
  },
  debug: (msg) => {
    if (process.env.RUNNER_DEBUG === "1" || process.env.VERBOSE) emit("DEBUG", msg);
  },
  warn: (msg) => {
    notes.warnings.push(msg);
    // ::warning:: renders as an annotation on the Actions run page.
    if (isCI) console.log(`::warning::${msg}`);
    emit("WARN", msg);
  },
  error: (msg) => {
    notes.errors.push(msg);
    if (isCI) console.log(`::error::${msg}`);
    emit("ERROR", msg);
  },
  stat: (key, value) => {
    notes.stats[key] = value;
    emit("STAT", `${key} = ${value}`);
  },
  /**
   * Times one phase and records it as a stat.
   *
   * Worth having because "why was that run slow?" is otherwise unanswerable
   * from the job page: wall-clock is dominated by throttling backoff rather
   * than by how big the survey is, and the two are indistinguishable without
   * knowing which phase the time went to.
   */
  phase: async (key, fn) => {
    const began = Date.now();
    try {
      return await fn();
    } finally {
      const secs = Math.round((Date.now() - began) / 100) / 10;
      notes.stats[`${key} (seconds)`] = secs;
      emit("TIME", `${key} took ${secs}s`);
    }
  },
};

/**
 * Writes a markdown summary to the GitHub Actions run page, so a maintainer can
 * see what happened without expanding raw logs. No-ops outside CI.
 */
export const writeSummary = () => {
  const path = process.env.GITHUB_STEP_SUMMARY;

  const lines = ["## Living survey update", ""];
  const stats = Object.entries(notes.stats);
  if (stats.length) {
    lines.push("| Metric | Value |", "| --- | --- |");
    for (const [k, v] of stats) lines.push(`| ${k} | ${v} |`);
    lines.push("");
  }
  for (const [label, items] of [
    ["Warnings", notes.warnings],
    ["Errors", notes.errors],
  ]) {
    if (!items.length) continue;
    lines.push(`### ${label}`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push(`Completed in ${elapsed()}.`);

  const body = lines.join("\n");
  if (path) {
    try {
      appendFileSync(path, `${body}\n`);
    } catch (err) {
      emit("WARN", `Could not write job summary: ${err.message}`);
    }
  }
  return body;
};

export const summaryNotes = notes;
