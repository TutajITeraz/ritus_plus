// Cantus numbers chants per folio (field_sequence restarts at 1 on every
// folio); eCatalogus needs one running sequence_in_ms for the whole
// manuscript. sortCantusRows puts rows in book order - folio first, then the
// per-folio sequence - and the converter then numbers them 1..n.

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

const romanToInt = (s) => {
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN[s[i]];
    const next = ROMAN[s[i + 1]];
    total += next > cur ? -cur : cur;
  }
  return total;
};

// "001r" -> 1.0, "001v" -> 1.5, "12" -> 12, "12.2" -> 12.2 (kept as is),
// "IV" -> front matter, sorted before folio 1. Anything else -> null.
export const folioSortKey = (folio) => {
  const s = String(folio ?? "").trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+)\s*([rv])$/);
  if (m) return Number(m[1]) + (m[2] === "v" ? 0.5 : 0);
  m = s.match(/^\d+(\.\d+)?$/);
  if (m) return Number(s);
  if (/^[ivxlcdm]+$/.test(s)) return romanToInt(s) - 10000;
  return null;
};

const seqOf = (row) => {
  const n = Number(row.field_sequence);
  return row.field_sequence === "" || row.field_sequence == null || isNaN(n)
    ? Infinity
    : n;
};

// Stable sort by (folio, field_sequence). A row whose folio cannot be read
// (empty, "[Lacuna]", ...) inherits the key of the row above it, so it stays
// where it was instead of jumping to the start or the end.
export const sortCantusRows = (rows) => {
  let last = -Infinity;
  const keyed = rows.map((row, index) => {
    const k = folioSortKey(row.field_folio);
    if (k != null) last = k;
    return { row, index, folio: last, seq: seqOf(row) };
  });
  keyed.sort(
    (a, b) => a.folio - b.folio || a.seq - b.seq || a.index - b.index
  );
  return keyed.map((k) => k.row);
};
