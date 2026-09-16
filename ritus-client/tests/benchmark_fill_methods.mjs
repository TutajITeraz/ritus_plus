/*
 * Accuracy + speed benchmark for Automatic Fill: n-gram matcher vs legacy algorithm.
 *
 * Drives the REAL production code from src/utils (lookup.jsx and
 * ngramLookup.jsx) over every manuscript row in
 * ritus-server/tests/Wr_Univ_I_F_366_automatic_fill.csv, exactly as
 * DataTable.handleAutoFill drives it.
 *
 * Precision is measured against an exhaustive Levenshtein scan of all 13,228
 * formulas. Generate that first (needs the server venv, ~25s):
 *
 *     cd ritus-server && python tests/build_fill_oracle.py
 *
 * then:
 *
 *     cd ritus-client && node tests/benchmark_fill_methods.mjs
 *     node tests/benchmark_fill_methods.mjs --oracle-dir /path/to/oracles
 *
 * Takes about a minute: the legacy algorithm is the slow half.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const srvTests = path.join(repo, "ritus-server", "tests");

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const oracleDir = argOf("--oracle-dir", srvTests);
// Manuscript table to benchmark on. Any project CSV with a formula_text_from_ms
// column works; the oracle in --oracle-dir must have been built from the SAME file.
const sourceCsv = argOf("--source", path.join(srvTests, "Wr_Univ_I_F_366_automatic_fill.csv"));
// Optional per-row dump: rowIndex, text, and each method's pick + similarity,
// so individual disagreements can be inspected outside this script.
const dumpPath = argOf("--dump-rows", null);
const THRESHOLD = Number(argOf("--threshold", "60"));

// The modules are .jsx by project convention but contain no JSX; stage them as
// .js so Node can import them directly.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ritus-fill-bench-"));
for (const name of ["lookup", "ngramLookup"]) {
  fs.writeFileSync(
    path.join(stage, `${name}.js`),
    fs.readFileSync(path.join(here, "..", "src", "utils", `${name}.jsx`), "utf8")
      .replace(/from "\.\/(\w+)"/g, 'from "./$1.js"')
  );
}
const { parseCSV, buildLookupIndex, countMatchingWords, calculateLevenshteinSimilarity } =
  await import(path.join(stage, "lookup.js"));
const { buildNgramIndex, ngramFindBestMatch, ngramPoolSize, normalizeLatin, boundedLevenshtein } =
  await import(path.join(stage, "ngramLookup.js"));

for (const f of ["oracle_raw.json", "oracle_norm.json"]) {
  if (!fs.existsSync(path.join(oracleDir, f))) {
    console.error(
      `Missing ${path.join(oracleDir, f)}.\n` +
      `Generate it first:  cd ritus-server && python tests/build_fill_oracle.py`
    );
    process.exit(2);
  }
}
const oracleRaw = JSON.parse(fs.readFileSync(path.join(oracleDir, "oracle_raw.json"), "utf8"));
const oracleNorm = JSON.parse(fs.readFileSync(path.join(oracleDir, "oracle_norm.json"), "utf8"));

// --- inputs ----------------------------------------------------------------
const entries = parseCSV(
  fs.readFileSync(path.join(repo, "ritus-server", "static", "data", "formulas.csv"), "utf8")
);

function parseTable(file) {
  const raw = fs.readFileSync(file, "utf8");
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const table = parseTable(sourceCsv);
const TEXT_COL = table[0].indexOf("formula_text_from_ms");
const queries = [];
table.slice(1).forEach((r, i) => {
  const t = (r[TEXT_COL] || "").trim();
  if (t) queries.push({ rowIndex: i, text: t.toLowerCase() });
});
console.log(`\nsource: ${path.basename(sourceCsv)}`);
console.log(`corpus: ${entries.length} formulas | manuscript rows with text: ${queries.length}`);
console.log(`similarity threshold: ${THRESHOLD}%\n`);

// Legacy's adaptive shortlist size, copied from DataTable.handleAutoFill.
const legacyPool = (len) =>
  len < 30 ? 500 : len < 60 ? 300 : len < 150 ? 60 : len < 300 ? 30 : 20;

function runLegacy() {
  const t0 = performance.now();
  const index = buildLookupIndex(entries);
  const tBuilt = performance.now();
  const cache = new Map();
  const picks = queries.map((q) => {
    const matches = countMatchingWords(entries, q.text, legacyPool(q.text.length), index);
    const ranked = calculateLevenshteinSimilarity(matches, q.text, cache);
    if (!ranked.length) return { ...q, id: null, similarity: 0 };
    const maxLen = Math.max(q.text.length, ranked[0].text.length);
    return {
      ...q,
      id: ranked[0].id,
      similarity: maxLen ? ((maxLen - ranked[0].levenstein) / maxLen) * 100 : 100,
    };
  });
  const t1 = performance.now();
  return { picks, buildMs: tBuilt - t0, matchMs: t1 - tBuilt, totalMs: t1 - t0 };
}

function runNgram() {
  const t0 = performance.now();
  const index = buildNgramIndex(entries);
  const tBuilt = performance.now();
  const cache = new Map();
  const picks = queries.map((q) => {
    const best = ngramFindBestMatch(
      index, q.text, ngramPoolSize(normalizeLatin(q.text).length), cache);
    return best
      ? { ...q, id: best.id, similarity: best.similarity }
      : { ...q, id: null, similarity: 0 };
  });
  const t1 = performance.now();
  return { picks, buildMs: tBuilt - t0, matchMs: t1 - tBuilt, totalMs: t1 - t0 };
}

// --- scoring ---------------------------------------------------------------
function report(label, run, oracle) {
  // "a real match exists" = the exhaustive scan found something >= 60% similar.
  // Below that the corpus-best is essentially arbitrary among near-ties and no
  // usable threshold would ever accept it, so it measures noise, not quality.
  let realHit = 0, realTot = 0, allHit = 0, allTot = 0;
  for (const p of run.picks) {
    const o = oracle[String(p.rowIndex)];
    if (!o) continue;
    const ok = p.id !== null && String(p.id) === String(o.formula_id);
    allTot++; if (ok) allHit++;
    if (o.similarity >= 60) { realTot++; if (ok) realHit++; }
  }
  let filled = 0, correct = 0;
  for (const p of run.picks) {
    if (p.id === null || p.similarity < THRESHOLD) continue;
    filled++;
    const o = oracle[String(p.rowIndex)];
    if (o && String(o.formula_id) === String(p.id)) correct++;
  }
  console.log(`=== ${label} ===`);
  console.log(`  time: index ${run.buildMs.toFixed(0)}ms + matching ${run.matchMs.toFixed(0)}ms` +
              ` = ${(run.totalMs / 1000).toFixed(2)}s`);
  console.log(`  rows filled at ${THRESHOLD}%:              ${filled}`);
  console.log(`  of those, the corpus-best formula:  ${correct}/${filled} = ` +
              `${((correct / filled) * 100).toFixed(2)}%   <- precision`);
  console.log(`  found corpus-best where one exists: ${realHit}/${realTot} = ` +
              `${((realHit / realTot) * 100).toFixed(2)}%`);
  console.log(`  found corpus-best over all rows:    ${allHit}/${allTot} = ` +
              `${((allHit / allTot) * 100).toFixed(2)}%`);
  return { filled, correct, precision: (correct / filled) * 100, realHit, realTot };
}

const legacy = runLegacy();
const ngram = runNgram();
const L = report("LEGACY ALGORITHM", legacy, oracleRaw);
console.log();
const N = report("N-GRAM MATCHER", ngram, oracleNorm);

// --- head to head ----------------------------------------------------------
const ngramByRow = new Map(ngram.picks.map((p) => [p.rowIndex, p]));
let both = 0, agree = 0, legacyOnly = 0, ngramOnly = 0;
const extras = [];
for (const p of legacy.picks) {
  const n = ngramByRow.get(p.rowIndex);
  const lOk = p.similarity >= THRESHOLD, nOk = n.similarity >= THRESHOLD;
  if (lOk && nOk) { both++; if (String(p.id) === String(n.id)) agree++; }
  else if (lOk) legacyOnly++;
  else if (nOk) { ngramOnly++; extras.push(n); }
}
const extrasCorrect = extras.filter((n) => {
  const o = oracleNorm[String(n.rowIndex)];
  return o && String(o.formula_id) === String(n.id);
}).length;

// Which pick is textually closer, judged by a single neutral metric so neither
// method is scored on its own terms.
const normById = new Map();
entries.forEach((e) => { if (e && e.text) normById.set(String(e.id), normalizeLatin(e.text)); });
const closeness = (query, id) => {
  const c = normById.get(String(id));
  if (c === undefined) return null;
  const q = normalizeLatin(query);
  const maxLen = Math.max(q.length, c.length);
  return maxLen ? (maxLen - boundedLevenshtein(q, c, maxLen)) / maxLen : 1;
};
let ngramCloser = 0, legacyCloser = 0;
for (const p of legacy.picks) {
  const n = ngramByRow.get(p.rowIndex);
  if (!(p.similarity >= THRESHOLD && n.similarity >= THRESHOLD)) continue;
  if (String(p.id) === String(n.id)) continue;
  const a = closeness(p.text, p.id), b = closeness(n.text, n.id);
  if (a === null || b === null) continue;
  if (b > a) ngramCloser++; else if (a > b) legacyCloser++;
}

console.log(`\n=== HEAD TO HEAD ===`);
console.log(`  speed:      ${(legacy.totalMs / 1000).toFixed(2)}s -> ${(ngram.totalMs / 1000).toFixed(2)}s` +
            `  (${(legacy.totalMs / ngram.totalMs).toFixed(2)}x faster)`);
console.log(`  precision:  ${L.precision.toFixed(2)}% -> ${N.precision.toFixed(2)}%`);
console.log(`  rows filled: ${L.filled} -> ${N.filled}`);
console.log(`\n  both filled ${both} rows, agreeing on ${agree} (${((agree / both) * 100).toFixed(2)}%)`);
console.log(`  legacy-only ${legacyOnly}, n-gram-only ${ngramOnly}`);
if (extras.length) {
  console.log(`  of the ${extras.length} rows only the n-gram matcher fills, ` +
              `${extrasCorrect} are the exhaustive-scan best match ` +
              `(${((extrasCorrect / extras.length) * 100).toFixed(1)}%)`);
}
console.log(`  where they disagree: n-gram's pick closer ${ngramCloser}x, legacy's closer ${legacyCloser}x`);

// --- assertions: the n-gram matcher must not regress -----------------------
// The two reports above each score a method against the oracle IT optimises,
// which is the fair way to describe a method on its own terms - but the two
// oracles have different denominators (a row can have a >=60% match under Latin
// normalisation and not under raw text, or the reverse), so comparing those two
// ratios against each other is not apples-to-apples and can report a regression
// where the n-gram matcher actually got strictly more rows right. The gate
// therefore scores BOTH methods against BOTH oracles.
// `thresholded` is what the user actually gets: a pick scoring under the
// threshold is discarded and the row stays empty, so it was not "found". The
// unfiltered figure is reported too because it isolates the ranking quality
// from where the cutoff happens to sit.
const hitRate = (run, oracle, thresholded) => {
  let hit = 0, tot = 0;
  for (const p of run.picks) {
    const o = oracle[String(p.rowIndex)];
    if (!o || o.similarity < 60) continue;
    tot++;
    if (thresholded && p.similarity < THRESHOLD) continue;
    if (p.id !== null && String(p.id) === String(o.formula_id)) hit++;
  }
  return { hit, tot, pct: tot ? (hit / tot) * 100 : 0 };
};
console.log(`\n=== SCORED ON A COMMON BASIS (both methods, same oracle) ===`);
const common = [["raw oracle", oracleRaw], ["norm oracle", oracleNorm]].map(([name, o]) => {
  const l = hitRate(legacy, o, true), n = hitRate(ngram, o, true);
  const lu = hitRate(legacy, o, false), nu = hitRate(ngram, o, false);
  console.log(`  ${name}, filled at ${THRESHOLD}%: legacy ${l.hit}/${l.tot} = ${l.pct.toFixed(2)}%   ` +
              `n-gram ${n.hit}/${n.tot} = ${n.pct.toFixed(2)}%`);
  console.log(`  ${name}, best pick regardless of threshold: legacy ${lu.pct.toFixed(2)}%   ` +
              `n-gram ${nu.pct.toFixed(2)}%`);
  return { name, l, n };
});

console.log(`\n=== CHECKS ===`);
const checks = [
  ["n-gram precision >= legacy precision", () => assert.ok(N.precision >= L.precision,
    `n-gram ${N.precision.toFixed(2)}% < legacy ${L.precision.toFixed(2)}%`)],
  ...common.map(({ name, l, n }) => [
    `n-gram finds corpus-best at least as often where one exists (${name})`,
    () => assert.ok(n.pct >= l.pct,
      `n-gram ${n.pct.toFixed(2)}% < legacy ${l.pct.toFixed(2)}%`)]),
  ["n-gram fills at least as many rows", () => assert.ok(N.filled >= L.filled,
    `n-gram ${N.filled} < legacy ${L.filled}`)],
  ["n-gram is faster", () => assert.ok(ngram.totalMs < legacy.totalMs,
    `n-gram ${ngram.totalMs.toFixed(0)}ms >= legacy ${legacy.totalMs.toFixed(0)}ms`)],
];
let failed = 0;
for (const [name, fn] of checks) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}
if (dumpPath) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["row_index,text,legacy_id,legacy_similarity,ngram_id,ngram_similarity,oracle_raw_id,oracle_norm_id,agree"];
  for (const p of legacy.picks) {
    const n = ngramByRow.get(p.rowIndex);
    const lId = p.similarity >= THRESHOLD ? p.id : "";
    const nId = n.similarity >= THRESHOLD ? n.id : "";
    lines.push([
      p.rowIndex, esc(p.text), esc(lId), p.similarity.toFixed(2),
      esc(nId), n.similarity.toFixed(2),
      esc(oracleRaw[String(p.rowIndex)]?.formula_id ?? ""),
      esc(oracleNorm[String(p.rowIndex)]?.formula_id ?? ""),
      String(lId) === String(nId) ? "1" : "0",
    ].join(","));
  }
  fs.writeFileSync(dumpPath, lines.join("\n") + "\n");
  console.log(`\nwrote per-row comparison -> ${dumpPath}`);
}
fs.rmSync(stage, { recursive: true, force: true });
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
