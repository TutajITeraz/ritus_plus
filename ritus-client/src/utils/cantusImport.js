// Import of manuscripts from the Cantus Planus in Poloniae database.
//
// Input is the file made by the Drupal module my_full_export_ritus
// (cantus_modules/my_full_export_ritus): { format, sources: [...], chants: [...] }.
// A source becomes a project: its chants become the table, its page images
// become the images of the project.

import { sortCantusRows } from "./cantusSequence.js";

export const CANTUS_EXPORT_FORMAT = "my_full_export_ritus/";

export const parseCantusExport = (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("This is not a JSON file.");
  }
  if (
    !data ||
    typeof data.format !== "string" ||
    !data.format.startsWith(CANTUS_EXPORT_FORMAT) ||
    !Array.isArray(data.sources) ||
    !Array.isArray(data.chants)
  ) {
    throw new Error(
      "This is not a Cantus export. Generate it in the Cantus admin panel: Full export for Ritus+."
    );
  }
  const chantsBySource = new Map();
  for (const chant of data.chants) {
    if (!chantsBySource.has(chant.srcnid)) chantsBySource.set(chant.srcnid, []);
    chantsBySource.get(chant.srcnid).push(chant);
  }
  return {
    generated: data.generated,
    sources: data.sources,
    chantsBySource,
  };
};

const text = (v) => (v == null ? "" : String(v));

// Export chant -> a row of the "Cantus Index" table structure (CantusStructure).
export const chantToCantusRow = (c) => ({
  field_folio: text(c.folio),
  field_sequence: text(c.sequence),
  field_office: text(c.office),
  field_genre: text(c.genre),
  field_position: text(c.position),
  field_cantus_id: text(c.cantus_id),
  field_full_text: text(c.full_text),
  field_feast: text(c.feast),
  field_mode: text(c.mode),
  field_finalis: text(c.finalis),
  field_rubrics: text(c.rubrics),
  field_differentia_database: text(c.differentia),
  field_marginalia: text(c.marginalia),
  field_notes_chant: text(c.notes),
  field_melody: text(c.melody),
});

// Rows in book order (folio, then per-folio sequence), ready for convertRows.
export const cantusRowsForSource = (chants) =>
  sortCantusRows(chants.map(chantToCantusRow));

// File name without extension: the image name in Ritus+ (and the page label).
const pageLabel = (label) =>
  String(label || "page")
    .replace(/\.(jpe?g|png|tiff?|bmp)$/i, "")
    .replace(/\.(jpe?g|png)$/i, "") // "f25.jpg.JPG"
    .trim() || "page";

// Pages to download. With `texts` (see pageTextsForSource) each page also
// carries the transcription text made from its chants.
export const pagesForSource = (source, texts = null) =>
  (source.images || [])
    .filter((img) => img.url)
    .map((img) => ({
      label: pageLabel(img.label),
      url: img.url,
      ...(texts && texts.get(img.nid) ? { text: texts.get(img.nid) } : {}),
    }));

// The Transcription text of a page is its chants' full texts, one after another,
// each closed with the prayer separator (the same markup the transcription
// uses, so "Load Project Transcription" turns it into table rows).
//
// A chant belongs to the page of its image_nid. Chants without one (not all
// have it) go to the page that the other chants of the same folio are on.
// Returns Map(image nid -> text).
export const pageTextsForSource = (source, chants) => {
  const pageNids = new Set((source.images || []).filter((i) => i.url).map((i) => i.nid));

  const votes = new Map(); // folio -> Map(nid -> count)
  for (const c of chants) {
    if (!c.folio || !pageNids.has(c.image_nid)) continue;
    if (!votes.has(c.folio)) votes.set(c.folio, new Map());
    const v = votes.get(c.folio);
    v.set(c.image_nid, (v.get(c.image_nid) || 0) + 1);
  }
  const nidOfFolio = new Map();
  for (const [folio, v] of votes) {
    nidOfFolio.set(folio, [...v.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }

  const ordered = sortCantusRows(
    chants.map((c) => ({ field_folio: text(c.folio), field_sequence: text(c.sequence), chant: c }))
  );
  const texts = new Map();
  for (const { chant: c } of ordered) {
    const body = text(c.full_text).replace(/\s+/g, " ").trim();
    if (!body) continue;
    const nid = pageNids.has(c.image_nid) ? c.image_nid : nidOfFolio.get(c.folio);
    if (nid == null) continue;
    texts.set(nid, (texts.get(nid) || "") + body + "⏎");
  }
  return texts;
};

// Project name: the Project.name column holds 100 characters.
export const projectNameForSource = (source) =>
  String(source.siglum || `Cantus source ${source.srcnid}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
