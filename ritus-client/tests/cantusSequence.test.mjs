/* node tests/cantusSequence.test.mjs */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { folioSortKey, sortCantusRows } = await import(
  path.join(here, "..", "src", "utils", "cantusSequence.js")
);

assert.equal(folioSortKey("001r"), 1);
assert.equal(folioSortKey("001v"), 1.5);
assert.equal(folioSortKey("12"), 12);
assert.ok(folioSortKey("IV") < folioSortKey("001r"));
assert.equal(folioSortKey("[Lacuna]"), null);
assert.equal(folioSortKey(""), null);

// sequence restarts per folio -> global order is folio, then sequence
const rows = [
  { id: "a", field_folio: "002r", field_sequence: "2" },
  { id: "b", field_folio: "001v", field_sequence: "1" },
  { id: "c", field_folio: "002r", field_sequence: "1" },
  { id: "d", field_folio: "001r", field_sequence: "1" },
  { id: "e", field_folio: "", field_sequence: "2" }, // inherits 001r
  { id: "f", field_folio: "001r", field_sequence: "2" },
];
assert.deepEqual(
  sortCantusRows(rows).map((r) => r.id),
  ["d", "e", "f", "b", "c", "a"] // e ties with f on (001r, 2): input order wins
);
// ties keep input order
const same = [
  { id: "x", field_folio: "001r", field_sequence: "1" },
  { id: "y", field_folio: "001r", field_sequence: "1" },
];
assert.deepEqual(sortCantusRows(same).map((r) => r.id), ["x", "y"]);
console.log("cantusSequence tests passed");
