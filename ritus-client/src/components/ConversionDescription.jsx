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
  rite_name_from_ms: {
    UsuariumStructure: "RUBRICS",
  },
  rite_id: {
    UsuariumStructure: "CEREMONY",
    mappingFile: "/data/mapping/rite_id_to_ceremony.tsv",
  },
  comments: {
    UsuariumStructure: "REMARK",
  },
  layer: {
    UsuariumStructure: "LAYER",
  },
  mass_hour: {
    UsuariumStructure: "MASS/HOUR",
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
  section_id: {
    UsuariumStructure: "PART",
    mappingFile: "/data/mapping/section_id_to_part.tsv",
  },
  season_month: {
    UsuariumStructure: "SEASON/MONTH",
  },
  week: {
    UsuariumStructure: "WEEK",
  },
  day: {
    UsuariumStructure: "DAY",
  },
  contributor_id: {
    UsuariumStructure: "MADE BY",
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
  RUBRICS: {
    ContentStructure: "rite_name_from_ms",
  },
  CEREMONY: {
    ContentStructure: "rite_id",
    mappingFile: "/data/mapping/rite_id_to_ceremony.tsv",
  },
  REMARK: {
    ContentStructure: "comments",
  },
  LAYER: {
    ContentStructure: "layer",
  },
  "MASS/HOUR": {
    ContentStructure: "mass_hour",
  },
  GENRE: {
    ContentStructure: ["genre", "function_id", "subfunction_id"],
    mappingFile: {
      genre: "/data/mapping/genre_to_genre.tsv",
      function_id: "/data/mapping/genre_to_function_id.tsv",
      subfunction_id: "/data/mapping/genre_to_subfunction_id.tsv",
    },
  },
  PART: {
    ContentStructure: "section_id",
    mappingFile: "/data/mapping/section_id_to_part.tsv",
  },
  "SEASON/MONTH": {
    ContentStructure: "season_month",
  },
  WEEK: {
    ContentStructure: "week",
  },
  DAY: {
    ContentStructure: "day",
  },
  "MADE BY": {
    ContentStructure: "contributor_id",
  },
};