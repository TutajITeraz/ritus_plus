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
// Decisions (see ecatalogus_import_cantus/README.md for the full table):
//   mapped      folio, full_text, rubrics, notes, cantus_id, genre, marginalia,
//               feast, mode, differentia_database, melody
//   ignored     field_position (sequence replaces it), field_differentia (old),
//               field_finalis, field_full_text_original, field_melody_id
//   not a row   field_image_link (one URL per manuscript), field_imageref_from_chant
//               (a Cantus image node id, not a page number - see the report)
//   sequence    handled in Converter.jsx: rows are sorted by folio + per-folio
//               sequence and numbered 1..n as sequence_in_ms.
export const CantusStructure_conv = {
  field_folio: {
    ContentStructure: "where_in_ms_from",
  },
  field_full_text: {
    ContentStructure: "formula_text_from_ms",
  },
  field_rubrics: {
    ContentStructure: "subrite_name_from_ms",
  },
  field_notes_chant: {
    ContentStructure: "comments",
  },
  // Every Cantus ID is kept as the edition index.
  field_cantus_id: {
    ContentStructure: "edition_index",
  },
  // Cantus Office codes (V, C, M, L, P ...) are not eCatalogus Mass/Hour codes.
  // Only the codes that mean the same in both are mapped; the rest stay empty
  // until eCatalogus decides how to hold Cantus offices.
  field_office: {
    ContentStructure: "mass_hour",
    mappingFile: "/data/mapping/cantus_office_to_mass_hour.tsv",
  },
  // Cantus genre code -> eCatalogus content function (existing, or the name
  // proposed in 01_content_functions_to_create.tsv - it must be added to
  // eCatalogus before the data is uploaded).
  field_genre: {
    ContentStructure: "function_id",
    mappingFile: "/data/mapping/cantus_genre_to_function_id.tsv",
  },
  // Any value in Marginalia (Left/Right/Top/Bottom/Added) means the chant was
  // written in the margin, i.e. added later.
  field_marginalia: {
    ContentStructure: "original_or_added",
    mappingFunction: (row) => (String(row.field_marginalia ?? "").trim() ? "ADDED" : ""),
  },
  // Feast -> rite_id of the standardised rite name. Only feasts that already
  // exist in eCatalogus resolve; the rest are listed in 02a_rite_names_to_create.tsv.
  field_feast: {
    ContentStructure: "rite_id",
    mappingFile: "/data/mapping/cantus_feast_to_rite_id.tsv",
  },
  field_mode: {
    ContentStructure: "chant_mode",
  },
  field_differentia_database: {
    ContentStructure: "chant_differentia",
  },
  field_melody: {
    ContentStructure: "melody",
  },
};
