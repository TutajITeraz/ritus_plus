/* node tests/cantusImport.test.mjs [path to a real export .json] */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const u = path.join(here, "..", "src", "utils");
const { parseCantusExport, chantToCantusRow, cantusRowsForSource, pagesForSource, projectNameForSource } =
  await import(path.join(u, "cantusImport.js"));

const sample = {
  format: "my_full_export_ritus/1",
  generated: "2026-01-01T00:00:00+00:00",
  sources: [
    { srcnid: 1, siglum: "PL-X 1  Test   book", images: [
      { nid: 5, label: "f2.jpg", url: "https://h/f2.jpg", order: 1 },
      { nid: 6, label: "f25.jpg.JPG", url: "https://h/f25.jpg.JPG", order: 2 },
      { nid: 7, label: "no-url.jpg", url: "", order: 3 },
    ] },
  ],
  chants: [
    { srcnid: 1, folio: "002r", sequence: 2, full_text: "b", cantus_id: "g1", genre: "A", office: "M", feast: null, marginalia: null },
    { srcnid: 1, folio: "001r", sequence: 1, full_text: "a", cantus_id: "g2", genre: "R", office: "V", feast: "Epiphania" },
  ],
};
const parsed = parseCantusExport(JSON.stringify(sample));
assert.equal(parsed.chantsBySource.get(1).length, 2);
assert.equal(chantToCantusRow(sample.chants[0]).field_feast, "");
assert.equal(chantToCantusRow(sample.chants[0]).field_sequence, "2");
assert.deepEqual(cantusRowsForSource(parsed.chantsBySource.get(1)).map((r) => r.field_full_text), ["a", "b"]);
assert.deepEqual(pagesForSource(sample.sources[0]).map((p) => p.label), ["f2", "f25"]);
assert.equal(projectNameForSource(sample.sources[0]), "PL-X 1 Test book");
assert.throws(() => parseCantusExport("{}"), /not a Cantus export/);
assert.throws(() => parseCantusExport("nope"), /not a JSON/);

const real = process.argv[2];
if (real) {
  const p = parseCantusExport(fs.readFileSync(real, "utf8"));
  let chants = 0;
  for (const s of p.sources) {
    const list = p.chantsBySource.get(s.srcnid) || [];
    chants += list.length;
    assert.equal(cantusRowsForSource(list).length, list.length);
    assert.ok(projectNameForSource(s).length <= 100);
    const labels = pagesForSource(s).map((x) => x.label);
    assert.ok(labels.every(Boolean));
  }
  assert.equal(chants, [...p.chantsBySource.values()].reduce((a, b) => a + b.length, 0));
  console.log(`real export: ${p.sources.length} sources, ${chants} chants OK`);
}
console.log("cantusImport tests passed");

// ---- page texts
{
  const { pageTextsForSource, pagesForSource } = await import(path.join(u, "cantusImport.js"));
  const src = { images: [{ nid: 10, label: "1r.jpg", url: "https://h/1r.jpg" }, { nid: 11, label: "1v.jpg", url: "https://h/1v.jpg" }, { nid: 12, label: "2r.jpg", url: "" }] };
  const ch = [
    { folio: "001v", sequence: 1, full_text: "Third  chant", image_nid: 11 },
    { folio: "001r", sequence: 2, full_text: "Second", image_nid: null },   // no image: its folio is on 10
    { folio: "001r", sequence: 1, full_text: "First", image_nid: 10 },
    { folio: "002r", sequence: 1, full_text: "No page", image_nid: 12 },     // image without url
    { folio: "001r", sequence: 3, full_text: "", image_nid: 10 },            // empty text
  ];
  const t = pageTextsForSource(src, ch);
  assert.equal(t.get(10), "First⏎Second⏎");
  assert.equal(t.get(11), "Third chant⏎");
  assert.equal(t.has(12), false);
  assert.deepEqual(pagesForSource(src, t).map((p) => p.text), ["First⏎Second⏎", "Third chant⏎"]);
  assert.equal("text" in pagesForSource(src)[0], false);
  if (process.argv[2]) {
    const p = parseCantusExport(fs.readFileSync(process.argv[2], "utf8"));
    let placed = 0, total = 0, pagesWithText = 0, pages = 0;
    for (const s of p.sources) {
      const list = p.chantsBySource.get(s.srcnid) || [];
      const texts = pageTextsForSource(s, list);
      const withImg = (s.images || []).some((i) => i.url);
      if (!withImg) continue;
      total += list.filter((c) => (c.full_text || "").trim()).length;
      placed += [...texts.values()].reduce((n, x) => n + x.split("⏎").length - 1, 0);
      pages += s.images.filter((i) => i.url).length;
      pagesWithText += texts.size;
    }
    console.log(`page texts: ${placed} of ${total} chants (sources with images) placed on pages; ${pagesWithText} of ${pages} pages have text`);
  }
}
console.log("page text tests passed");
