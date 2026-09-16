/*
 * Tests for the row helpers shared by the table editor and the batch
 * "Process Table" runner: src/utils/transcriptionRows.js (the parser behind
 * "Load Project Transcription") and src/utils/tableRows.js (Auto Propagate).
 *
 * The project has no test runner, so this is a plain Node script with no
 * dependencies: run it with
 *     node tests/tableRows.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const utils = path.join(here, "..", "src", "utils");

const { buildRowsFromTranscription } = await import(
  path.join(utils, "transcriptionRows.js")
);
const { autoPropagateRows, supportsAutoPropagate, sequenceKeyOf } =
  await import(path.join(utils, "tableRows.js"));

// A minimal stand-in for ContentStructure: only the columns these helpers
// actually read, so the test does not depend on the full eCatalogus schema.
const structure = [
  { name: "id", type: "number" },
  { name: "formula_id", type: "number" },
  { name: "formula_text_from_ms", type: "text" },
  { name: "sequence_in_ms", type: "sequence" },
  { name: "where_in_ms_from", type: "string" },
  { name: "where_in_ms_to", type: "string" },
  { name: "digital_page_number", type: "number" },
  { name: "rite_name_from_ms", type: "string" },
  { name: "subrite_name_from_ms", type: "string" },
  { name: "rite_id", type: "number" },
  { name: "function_id", type: "string" },
  { name: "subfunction_id", type: "string" },
];

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

const img = (name, text) => ({ name, transcribed_text: text });
const texts = (rows) => rows.map((r) => r.formula_text_from_ms);

// --- transcription parsing -------------------------------------------------

test("⏎ splits a page into one row per prayer", () => {
  const rows = buildRowsFromTranscription(
    [img("f1r", "alpha⏎beta⏎gamma")],
    structure
  );
  assert.deepEqual(texts(rows), ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    rows.map((r) => r.sequence_in_ms),
    [1, 2, 3]
  );
});

test("markers become their own rows and close the formula before them", () => {
  const rows = buildRowsFromTranscription(
    [img("f1r", "alpha<red>Ordo baptismi</red>beta<func>OR</func><subrub>Sub</subrub>gamma")],
    structure
  );
  assert.deepEqual(texts(rows), ["alpha", "", "beta", "", "", "gamma"]);
  assert.equal(rows[1].rite_name_from_ms, "Ordo baptismi");
  assert.equal(rows[3].function_id, "OR");
  assert.equal(rows[4].subrite_name_from_ms, "Sub");
});

test("an unterminated tag stops the page instead of swallowing the rest", () => {
  const rows = buildRowsFromTranscription(
    [img("f1r", "alpha⏎beta<red>never closed")],
    structure
  );
  assert.deepEqual(texts(rows), ["alpha", "beta"]);
});

test("a page not ending in ⏎ continues into the next page", () => {
  const rows = buildRowsFromTranscription(
    [img("f1r", "first part of a prayer "), img("f1v", "and its ending⏎next")],
    structure
  );
  assert.deepEqual(texts(rows), [
    "first part of a prayer and its ending",
    "next",
  ]);
  // The merged row spans both pages.
  assert.equal(rows[0].where_in_ms_from, "f1r");
  assert.equal(rows[0].where_in_ms_to, "f1v");
  assert.equal(rows[1].where_in_ms_from, "f1v");
});

test("a page ending in ⏎ does not merge into the next page", () => {
  const rows = buildRowsFromTranscription(
    [img("f1r", "alpha⏎"), img("f1v", "beta")],
    structure
  );
  assert.deepEqual(texts(rows), ["alpha", "beta"]);
  assert.equal(rows[0].where_in_ms_to, "f1r");
});

test("blank pages contribute no rows", () => {
  assert.deepEqual(
    buildRowsFromTranscription([img("f1r", ""), img("f1v", null)], structure),
    []
  );
});

test("missing structure columns are filled in", () => {
  const [row] = buildRowsFromTranscription([img("f1r", "alpha")], structure);
  for (const col of structure) {
    assert.ok(col.name in row, `${col.name} missing`);
  }
});

// --- auto propagate --------------------------------------------------------

const propagate = (rows) =>
  autoPropagateRows(rows, structure, sequenceKeyOf(structure));

test("supportsAutoPropagate rejects a structure without the label columns", () => {
  assert.equal(supportsAutoPropagate(structure), true);
  assert.equal(
    supportsAutoPropagate(structure.filter((c) => c.name !== "rite_id")),
    false
  );
});

test("a function marker merges into the single formula below it", () => {
  const rows = propagate(
    buildRowsFromTranscription(
      [img("f1r", "<func>OR</func>alpha⏎beta")],
      structure
    )
  );
  assert.deepEqual(texts(rows), ["alpha", "beta"]);
  assert.equal(rows[0].function_id, "OR");
  assert.equal(rows[1].function_id, "");
});

test("a rite marker merges down and spreads over the formulas it covers", () => {
  const rows = propagate(
    buildRowsFromTranscription(
      [img("f1r", "<red>Ordo A</red>alpha⏎beta⏎<red>Ordo B</red>gamma")],
      structure
    )
  );
  assert.deepEqual(texts(rows), ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    rows.map((r) => r.rite_name_from_ms),
    ["Ordo A", "Ordo A", "Ordo B"]
  );
});

test("a subrite stops at the next rite, the rite carries on past it", () => {
  const rows = propagate(
    buildRowsFromTranscription(
      [img("f1r", "<red>Ordo A</red>alpha⏎<subrub>Sub</subrub>beta⏎gamma⏎<red>Ordo B</red>delta")],
      structure
    )
  );
  assert.deepEqual(texts(rows), ["alpha", "beta", "gamma", "delta"]);
  assert.deepEqual(
    rows.map((r) => r.rite_name_from_ms),
    ["Ordo A", "Ordo A", "Ordo A", "Ordo B"]
  );
  assert.deepEqual(
    rows.map((r) => r.subrite_name_from_ms),
    ["", "Sub", "Sub", ""]
  );
});

test("a trailing marker with nothing to label is dropped", () => {
  const rows = propagate(
    buildRowsFromTranscription([img("f1r", "alpha⏎<red>Ordo A</red>")], structure)
  );
  assert.deepEqual(texts(rows), ["alpha"]);
  assert.equal(rows.length, 1);
});

test("propagated rows keep their original sequence numbers", () => {
  // Merging a marker into the row below leaves the marker's number unused, so
  // the sequence has gaps afterwards. updateSequences is called with
  // preserveExisting, which keeps already-unique numbers rather than closing
  // them up - this is what the table editor's Auto Propagate has always done.
  const rows = propagate(
    buildRowsFromTranscription(
      [img("f1r", "<red>Ordo A</red>alpha⏎<func>OR</func>beta⏎gamma")],
      structure
    )
  );
  assert.deepEqual(
    rows.map((r) => r.sequence_in_ms),
    [1, 3, 5]
  );
});

console.log(`\n${passed}/${passed + failures.length} passed`);
process.exit(failures.length ? 1 : 0);
