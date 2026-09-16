/*
 * Tests for the n-gram matcher used by Automatic Fill (src/utils/ngramLookup.jsx).
 *
 * The project has no test runner, so this is a plain Node script with no
 * dependencies: run it with
 *     node tests/ngramLookup.test.mjs
 * The modules under test are .jsx by project convention but contain no JSX, so
 * they are staged into a temp directory as .js before importing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src", "utils");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ritus-ngram-test-"));
for (const name of ["lookup", "ngramLookup"]) {
  const code = fs
    .readFileSync(path.join(src, `${name}.jsx`), "utf8")
    .replace(/from "\.\/(\w+)"/g, 'from "./$1.js"');
  fs.writeFileSync(path.join(stage, `${name}.js`), code);
}

const { levenshtein } = await import(path.join(stage, "lookup.js"));
const {
  normalizeLatin,
  collectGrams,
  buildNgramIndex,
  ngramCandidates,
  ngramFindBestMatch,
  ngramFindMatches,
  ngramPoolSize,
  boundedLevenshtein,
} = await import(path.join(stage, "ngramLookup.js"));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// --- normalization ---------------------------------------------------------

test("normalizeLatin folds medieval Latin orthography", () => {
  assert.equal(normalizeLatin("Jesu"), normalizeLatin("Iesu"));
  assert.equal(normalizeLatin("vivas"), normalizeLatin("uiuas"));
  assert.equal(normalizeLatin("caelorum"), normalizeLatin("celorum"));
  assert.equal(normalizeLatin("poena"), normalizeLatin("pena"));
});

test("normalizeLatin strips accents, punctuation, digits and parentheticals", () => {
  assert.equal(normalizeLatin("Dómine, exaudi!"), "domine exaudi");
  assert.equal(normalizeLatin("Confitebor (...) require"), "confitebor require");
  assert.equal(normalizeLatin("psalm 42 dixit"), "psalm dixit");
  assert.equal(normalizeLatin(""), "");
  assert.equal(normalizeLatin(null), "");
});

// --- n-grams ---------------------------------------------------------------

test("collectGrams produces sliding windows namespaced by size", () => {
  assert.deepEqual([...collectGrams(["a", "b", "c", "d"], [3])], ["3|a b c", "3|b c d"]);
  assert.deepEqual([...collectGrams(["a", "b"], [2])], ["2|a b"]);
});

test("collectGrams indexes several sizes at once without collision", () => {
  const grams = [...collectGrams(["a", "b"], [1, 2])];
  assert.deepEqual(grams, ["1|a", "1|b", "2|a b"]);
});

test("collectGrams falls back to the whole phrase when shorter than n", () => {
  assert.deepEqual([...collectGrams(["laudate", "dominum"], [3])], ["3|laudate dominum"]);
  assert.deepEqual([...collectGrams([], [3])], []);
});

// --- bounded Levenshtein ---------------------------------------------------

test("boundedLevenshtein equals plain Levenshtein within budget", () => {
  const alpha = "abcde ";
  const rnd = (n) =>
    Array.from({ length: n }, () => alpha[Math.floor(Math.random() * alpha.length)]).join("");
  for (let i = 0; i < 3000; i++) {
    const a = rnd(Math.floor(Math.random() * 14));
    const b = rnd(Math.floor(Math.random() * 14));
    const truth = levenshtein(a, b);
    for (const budget of [0, 1, 3, 7, 25]) {
      const expected = truth <= budget ? truth : budget + 1;
      assert.equal(
        boundedLevenshtein(a, b, budget),
        expected,
        `a=${JSON.stringify(a)} b=${JSON.stringify(b)} budget=${budget}`
      );
    }
  }
});

test("boundedLevenshtein rejects on length gap alone", () => {
  assert.equal(boundedLevenshtein("abc", "abcdefghij", 2), 3);
  assert.equal(boundedLevenshtein("", "abc", 5), 3);
  assert.equal(boundedLevenshtein("abc", "", 2), 3);
  assert.equal(boundedLevenshtein("abc", "abc", 0), 0);
});

// --- index + candidates ----------------------------------------------------

const entries = [
  { id: "1", text: "Dominus vobiscum et cum spiritu tuo" },
  { id: "2", text: "Oremus flectamus genua levate" },
  { id: "3", text: "Exorcizo te creatura salis per Deum vivum per Deum verum" },
  { id: "4", text: "Laudate Dominum omnes gentes" },
  { id: "5", text: "" },
  { id: "6", text: "Confitebor tibi Domine quoniam audisti" },
];

test("buildNgramIndex skips entries without text", () => {
  const index = buildNgramIndex(entries);
  assert.equal(index.records.length, 5);
  assert.ok(index.index.size > 0);
});

test("ngramCandidates finds the obvious match first", () => {
  const index = buildNgramIndex(entries);
  const c = ngramCandidates(index, "dominus vobiscum et cum spiritu tuo", 5);
  assert.equal(c[0].id, "1");
  assert.ok(c[0].match_score > 0.9);
});

test("ngramCandidates tolerates a garbled word via unigrams", () => {
  const index = buildNgramIndex(entries);
  // "vobiscvm" breaks every bigram straddling it; unigrams keep it findable
  const c = ngramCandidates(index, "dominus vobiscvm et cum spiritu tuo", 5);
  assert.equal(c[0].id, "1");
});

test("ngramCandidates returns nothing for text sharing no wording", () => {
  const index = buildNgramIndex(entries);
  assert.deepEqual(ngramCandidates(index, "zzzz yyyy xxxx", 5), []);
  assert.deepEqual(ngramCandidates(index, "", 5), []);
});

test("short incipits are findable", () => {
  const index = buildNgramIndex(entries);
  const best = ngramFindBestMatch(index, "laudate dominum omnes", 50, new Map());
  assert.equal(best.id, "4");
});

// --- best match ------------------------------------------------------------

test("ngramFindBestMatch returns an exact match at 100%", () => {
  const index = buildNgramIndex(entries);
  const best = ngramFindBestMatch(index, "Oremus flectamus genua levate", 50, new Map());
  assert.equal(best.id, "2");
  assert.equal(best.levenstein, 0);
  assert.equal(best.similarity, 100);
});

test("ngramFindBestMatch scores orthographic variants as near-identical", () => {
  const index = buildNgramIndex(entries);
  // v/u and ae/e folding means this should read as the same text
  const best = ngramFindBestMatch(index, "Oremus flectamvs genva levate", 50, new Map());
  assert.equal(best.id, "2");
  assert.ok(best.similarity > 95, `similarity was ${best.similarity}`);
});

test("ngramFindBestMatch returns null when nothing shares wording", () => {
  const index = buildNgramIndex(entries);
  assert.equal(ngramFindBestMatch(index, "zzzz yyyy xxxx", 50, new Map()), null);
});

test("the bounded search returns the same pick as scoring every candidate", () => {
  const index = buildNgramIndex(entries);
  const queries = [
    "dominus vobiscum et cum spiritu tuo",
    "exorciso te creatura salis per deum uiuum",
    "confitebor tibi domine quoniam",
    "oremus flectamus genua",
    "laudate dominum omnes gentes",
  ];
  for (const q of queries) {
    const best = ngramFindBestMatch(index, q, 50, new Map());
    const full = ngramFindMatches(index, q, 50, new Map());
    assert.equal(best.levenstein, full[0].levenstein, `distance differs for "${q}"`);
    assert.ok(
      Math.abs(best.similarity - full[0].similarity) < 1e-9,
      `similarity differs for "${q}"`
    );
  }
});

test("the cache does not change results", () => {
  const index = buildNgramIndex(entries);
  const cache = new Map();
  const q = "dominus vobiscum et cum spiritu tuo";
  const first = ngramFindBestMatch(index, q, 50, cache);
  const second = ngramFindBestMatch(index, q, 50, cache);
  assert.equal(first.id, second.id);
  assert.equal(first.levenstein, second.levenstein);
});

test("ngramPoolSize widens the pool for short, ambiguous queries", () => {
  assert.ok(ngramPoolSize(10) > ngramPoolSize(100));
  assert.ok(ngramPoolSize(100) > ngramPoolSize(500));
});

fs.rmSync(stage, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} passed`);
process.exit(failures.length ? 1 : 0);
