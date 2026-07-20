export const ContentStructure_conv = {
  id: {
    UsuariumStructure: "id_usu",
  },
  rism_id: {
    UsuariumStructure: "SOURCE",
    mappingFunction: (row) => {
      const value = row.rism_id;
      return value ? `RISM:${value}` : "";
    },
    reverseMappingFunction: (row) => {
      const value = row.SOURCE;
      return value ? value.replace("RISM:", "") : "";
    },
  },
  text_standarization__usu_id: {
    UsuariumStructure: "STANDARD ITEM",
    mappingFunction: (row) => {
      const value = row.text_standarization__usu_id;
      if (!value || typeof value !== "string") {
        console.warn(`Invalid value for text_standarization__usu_id:`, {
          value,
          type: typeof value,
          stringified: JSON.stringify(value),
        });
        return "";
      }
      const match = value.match(/\((\w+)\)/);
      return match ? match[1] : "";
    },
    reverseMappingFunction: () => "", // No reverse conversion
  },
  formula_text_from_ms: {
    UsuariumStructure: "ITEM",
  },
  digital_page_number: {
    UsuariumStructure: "PAGE NUMBER (DIGITAL)",
  },
  where_in_ms_from: {
    UsuariumStructure: "PAGE NUMBER (ORIGINAL)",
    mappingFunction: (row) =>
      row.where_in_ms_to
        ? `${row.where_in_ms_from || ""} - ${row.where_in_ms_to || ""}`
        : row.where_in_ms_from || "",
    reverseMappingFunction: (row) => {
      const value = row["PAGE NUMBER (ORIGINAL)"];
      if (!value) return { where_in_ms_from: "", where_in_ms_to: "" };
      const [from, to] = value.split(" - ").map((s) => s.trim());
      return { where_in_ms_from: from || "", where_in_ms_to: to || "" };
    },
  },
  where_in_ms_to: {
    // Handled by where_in_ms_from mapping
  },
  genre: {
    UsuariumStructure: "GENRE",
  },
  function_id: {
    UsuariumStructure: "GENRE",
    mappingFile: "/data/mapping/function_id_to_genre.tsv",
  },
  subfunction_id: {
    UsuariumStructure: "GENRE",
    mappingFile: "/data/mapping/subfunction_id_to_genre.tsv",
  },
};

export const UsuariumStructure_conv = {
  id_usu: {
    ContentStructure: "id",
  },
  SOURCE: {
    ContentStructure: "rism_id",
    mappingFunction: (row) => {
      const value = row.SOURCE;
      return value ? value.replace("RISM:", "") : "";
    },
    reverseMappingFunction: (row) => {
      const value = row.rism_id;
      return value ? `RISM:${value}` : "";
    },
  },
  "STANDARD ITEM": {
    ContentStructure: "text_standarization__usu_id",
    mappingFunction: () => "", // No forward conversion
    reverseMappingFunction: (row) => {
      const value = row["STANDARD ITEM"];
      if (!value || typeof value !== "string") {
        console.warn(`Invalid value for STANDARD ITEM:`, {
          value,
          type: typeof value,
          stringified: JSON.stringify(value),
        });
        return "";
      }
      const match = value.match(/\((\w+)\)/);
      return match ? match[1] : "";
    },
  },
  ITEM: {
    ContentStructure: "formula_text_from_ms",
  },
  "PAGE NUMBER (DIGITAL)": {
    ContentStructure: "digital_page_number",
  },
  "PAGE NUMBER (ORIGINAL)": {
    ContentStructure: ["where_in_ms_from", "where_in_ms_to"],
    mappingFunction: (row) => {
      const value = row["PAGE NUMBER (ORIGINAL)"];
      if (!value) return { where_in_ms_from: "", where_in_ms_to: "" };
      const [from, to] = value.split("-").map((s) => s.trim());
      return { where_in_ms_from: from || "", where_in_ms_to: to || "" };
    },
    reverseMappingFunction: (row) => {
      return row.where_in_ms_to
        ? `${row.where_in_ms_from || ""} - ${row.where_in_ms_to || ""}`
        : row.where_in_ms_from || "";
    },
  },
  REMARK: {
    ContentStructure: "comments",
  },
  LAYER: {
    ContentStructure: "layer",
  },
  GENRE: {
    ContentStructure: ["genre", "function_id", "subfunction_id"],
    mappingFile: {
      genre: "/data/mapping/genre_to_genre.tsv",
      function_id: "/data/mapping/genre_to_function_id.tsv",
      subfunction_id: "/data/mapping/genre_to_subfunction_id.tsv",
    },
  },
};

// Cantus Index -> eCatalogus (Content) Structure.
// Only fields with a clear, unambiguous counterpart are mapped here.
// Fields left out (field_position, field_feast, field_mode, field_differentia,
// field_finalis, field_differentia_database, field_image_link, field_melody,
// field_melody_id, field_full_text) have no reliable equivalent in
// ContentStructure - see the conversion report for details.
export const CantusStructure_conv = {
  field_folio: {
    ContentStructure: "where_in_ms_from",
  },
  field_full_text_original: {
    ContentStructure: "formula_text_from_ms",
  },
  field_rubrics: {
    ContentStructure: "rite_name_from_ms",
  },
  field_notes_chant: {
    ContentStructure: "comments",
  },
  field_imageref_from_chant: {
    ContentStructure: "digital_page_number",
  },
  field_cantus_id: {
    ContentStructure: "reference_to_other_items",
    mappingFunction: (row) => {
      const value = row.field_cantus_id;
      return value ? `CANTUS:${value}` : "";
    },
  },
  // field_office uses Cantus Database hour codes (V, C, M, L, ...) while
  // ContentStructure's mass_hour uses a different code set (V1, C1, I, III, ...).
  // Only the codes that are unambiguous under both vocabularies are mapped;
  // the rest (e.g. "N" which could mean None or Nocturn) are left blank.
  field_office: {
    ContentStructure: "mass_hour",
    mappingFile: "/data/mapping/cantus_office_to_mass_hour.tsv",
  },
  // field_genre uses Cantus Database genre codes, which only partially overlap
  // with ContentStructure's genre/function_id vocabularies (rite-specific,
  // e.g. Ambrosian terms like "Ingressa"/"Confractorium"). Only exact,
  // unambiguous code matches are mapped; subfunction_id and
  // liturgical_genre_id are left unmapped as there is no reliable source data.
  field_genre: {
    ContentStructure: ["genre", "function_id"],
    mappingFile: {
      genre: "/data/mapping/cantus_genre_to_genre.tsv",
      function_id: "/data/mapping/cantus_genre_to_function_id.tsv",
    },
  },
  // field_marginalia records physical position (Left/Right/Top/Bottom) as well
  // as an explicit "Added" status. Only "Added" maps cleanly onto
  // original_or_added; positional codes don't imply originality either way.
  field_marginalia: {
    ContentStructure: "original_or_added",
    mappingFile: "/data/mapping/cantus_marginalia_to_original_or_added.tsv",
  },
};