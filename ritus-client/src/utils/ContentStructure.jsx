import { calculateLevenshteinSimilarity } from "../utils/lookup";

const isInteger = (value) => {
  if (value === "" || value == null) return true;
  return Number.isInteger(Number(value));
};

const isFloat = (value) => {
  if (value === "" || value == null) return true;
  return !isNaN(parseFloat(value)) && isFinite(parseFloat(value));
};

const isValidFolio = (value) => {
  if (value === "" || value == null) return true;
  const regex = /^\d+(\.[12])?$|^\d+[rv]$/;
  return regex.test(value);
};

const validateSelectOrList = (value, row, index) => {
  if (value == null || value === "") return null;
  // Validation is handled elsewhere using dictionaries
  return null;
};

const ContentStructure = [
  {
    name: "id",
    display_name: "ID",
    type: "number",
    editable: true,
    can_be_null: true,
    validationFunction: (value, row, index) =>
      value == null || value === ""
        ? null
        : isInteger(value)
        ? null
        : `Invalid integer at row ${index + 1}`,
  },
  {
    name: "manuscript_id",
    display_name: "Manuscript ID",
    type: "number",
    editable: true,
    can_be_null: true,
    validationFunction: (value) =>
      value == null || value === ""
        ? null
        : isNaN(value)
        ? "Must be a number"
        : null,
  },
  {
    name: "formula_id",
    display_name: "Formula ID",
    type: "number",
    editable: true,
    can_be_null: true,
    
    dictionary_key_col: "id",
    dictionary_display_col: "id",
    dictionary_export_col: "id",

    validationFunction: (value) =>
      value == null || value === ""
        ? null
        : isNaN(value)
        ? "Must be a number"
        : null,
    dictionary: "formulas.csv",
    lookupColumn: "formula_text_from_ms",
  },
  {
    name: "formula_text_from_ms",
    display_name: "Formula Text from MS",
    type: "text",
    editable: true,
    can_be_null: true,
    width: 300,
    style: {
      whiteSpace: "normal",
      wordWrap: "break-word",
    },
  },
  {
    name: "formula_standardized",
    display_name: "Formula Standardized",
    type: "automatic",
    editable: false,
    can_be_null: true,
    parentColumn: "formula_id",
    dictionary: "formulas.csv",
    dictionary_key_col: "id",
    dictionary_display_col: "text",
    dictionary_export_col: "text",
    width: 300,
    style: {
      whiteSpace: "normal",
      wordWrap: "break-word",
    },
  },
  {
    name: "levenshtein",
    display_name: "Levenshtein similarity",
    type: "text",
    editable: false,
    can_be_null: true,
    computeFunction: (content) => {
      const text1 = content.formula_text_from_ms || "";
      const text2 = content.formula_standardized || "";
      if (!text1 || !text2) return "N/A";
      const matches = calculateLevenshteinSimilarity(
        [{ id: "1", text: text2 }],
        text1,
        new Map()
      );
      if (!matches.length) return "N/A";
      const distance = matches[0].levenstein;
      const maxLength = Math.max(text1.length, text2.length);
      const similarity = maxLength
        ? ((maxLength - distance) / maxLength) * 100
        : 0;
      return `${similarity.toFixed(2)}%`;
    },
  },
  {
    name: "similarity_by_user",
    display_name: "Similarity by User",
    value: "",
    can_be_null: true,
    type: "select",
    display_element: (value) => {
      const options = ["", "0", "0.5", "1"];
      return options.includes(value) ? value : "";
    },
  },
  {
    name: "sequence_in_ms",
    display_name: "Sequence in MS",
    type: "sequence",
    editable: true,
    can_be_null: false,
    validationFunction: (value, row, index) => {
      if (value == null || value === "") return "Must not be empty";
      if (isNaN(value) || !Number.isInteger(Number(value)))
        return "Must be an integer";
      return null;
    },
  },
  {
    name: "where_in_ms_from",
    display_name: "Where in MS From",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "where_in_ms_to",
    display_name: "Where in MS To",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "rite_name_from_ms",
    display_name: "Rite Name from MS",
    value: "",
    can_be_null: true,
    type: "text",
    width: 200,
  },
  {
    name: "subrite_name_from_ms",
    display_name: "Subrite Name from MS",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "rite_id",
    display_name: "Rite ID",
    type: "number",
    editable: true,
    can_be_null: true,
    validationFunction: (value) =>
      value == null || value === ""
        ? null
        : isNaN(value)
        ? "Must be a number"
        : null,
    dictionary: "rite_names.csv",
    lookupColumn: "rite_name_from_ms",
    dictionary_key_col: "id",
    dictionary_display_col: "id",
    dictionary_export_col: "id",
  },
  {
    name: "rite_name_standarized",
    display_name: "Rite Name Standarized",
    type: "automatic",
    editable: false,
    can_be_null: true,
    parentColumn: "rite_id",
    dictionary: "rite_names.csv",
    dictionary_key_col: "id",
    dictionary_display_col: "text",
    dictionary_export_col: "text",
    validationFunction: (value, row, index) =>
      value == null || value === ""
        ? null
        : isInteger(value)
        ? null
        : `Invalid integer at row ${index + 1}`,
  },
  {
    name: "rite_sequence_in_the_MS",
    display_name: "Rite Sequence in MS",
    value: "",
    can_be_null: true,
    type: "number",
    validationFunction: (value, row, index) =>
      value == null || value === ""
        ? null
        : isInteger(value)
        ? null
        : `Invalid integer at row ${index + 1}`,
  },
  {
    name: "original_or_added",
    display_name: "Original or Added",
    value: "",
    can_be_null: true,
    type: "select",
    display_element: (value) => {
      const options = ["", "ORIGINAL", "ADDED"];
      return options.includes(value) ? value : "";
    },
  },
  {
    name: "biblical_reference",
    display_name: "Biblical Reference",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "reference_to_other_items",
    display_name: "Reference to Other Items",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "edition_index",
    display_name: "Edition Index",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "edition_subindex",
    display_name: "Edition Subindex",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "comments",
    display_name: "Comments",
    value: "",
    can_be_null: true,
    type: "text",
  },
  {
    name: "function_id",
    display_name: "Function ID",
    value: "",
    can_be_null: true,
    type: "select",
    dictionary: "functions.csv",
    validationFunction: (value, row, index) => {
      if (value == null || value === "") return null;
      // Validation is handled in validateRow using dictionaries
      return null;
    },
  },
  {
    name: "subfunction_id",
    display_name: "Subfunction ID",
    value: "",
    can_be_null: true,
    type: "select",
    dictionary: "functions.csv",
    validationFunction: (value, row, index) => {
      if (value == null || value === "") return null;
      // Validation is handled in validateRow using dictionaries
      return null;
    },
  },
  {
    name: "liturgical_genre_id",
    display_name: "Liturgical Genre ID",
    value: "",
    can_be_null: true,
    type: "select",
    dictionary: "liturgical_genres.tsv",
    dictionary_key_col: "id",
    dictionary_display_col: "name",
    dictionary_export_col: "id",
    validationFunction: (value, row, index) => {
      if (value == null || value === "") return null;
      // Validation is handled in validateRow using dictionaries
      return null;
    }
    },
  {
    name: "music_notation_id",
    display_name: "Music Notation ID",
    value: "",
    can_be_null: true,
    type: "select",
    dictionary: "music_notation.tsv",
    dictionary_key_col: "id",
    dictionary_display_col: "name",
    dictionary_export_col: "id",
    validationFunction: (value, row, index) => {
      if (value == null || value === "") return null;
      // Validation is handled in validateRow using dictionaries
      return null;
    }
  },
  {
    name: "quire_id",
    display_name: "Quire ID",
    value: "",
    can_be_null: true,
    type: "number",
    validationFunction: (value, row, index) =>
      value == null || value === ""
        ? null
        : isInteger(value)
        ? null
        : `Invalid integer at row ${index + 1}`,
  },
  {
    name: "section_id",
    display_name: "Section ID",
    value: "",
    can_be_null: true,
    type: "select",
    dictionary: "sections.tsv",
    dictionary_key_col: "id",
    dictionary_display_col: "name",
    dictionary_export_col: "id",
    validationFunction: (value, row, index) => {
      if (value == null || value === "") return null;
      // Validation is handled in validateRow using dictionaries
      return null;
    }
  },
  {
    name: "subsection_id",
    display_name: "Subsection ID",
    value: "",
    can_be_null: true,
    type: "select",
    dictionary: "sections.tsv",
    dictionary_key_col: "id",
    dictionary_display_col: "name",
    dictionary_export_col: "id",
    validationFunction: (value, row, index) => {
      if (value == null || value === "") return null;
      // Validation is handled in validateRow using dictionaries
      return null;
    }
  },
  {
    name: "contributor_id",
    display_name: "Contributor ID",
    value: "",
    can_be_null: true,
    type: "number",
    validationFunction: (value, row, index) =>
      value == null || value === ""
        ? null
        : isInteger(value)
        ? null
        : `Invalid integer at row ${index + 1}`,
  },
  {
    name: "entry_date",
    display_name: "Entry Date",
    value: "",
    can_be_null: true,
    type: "text",
  },


  // --- New fields from Content model ---
  {
    name: "digital_page_number",
    display_name: "Digital Page Number",
    type: "number",
    editable: true,
    can_be_null: true,
    value: "",
  },
  {
    name: "proper_texts",
    display_name: "Proper Texts",
    type: "boolean",
    editable: true,
    can_be_null: true,
    value: "",
  },
  {
    name: "layer",
    display_name: "Layer",
    type: "select",
    dictionary: "layer.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "mass_hour",
    display_name: "Mass/Hour",
    type: "select",
    dictionary: "mass_hour.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "genre",
    display_name: "Genre",
    type: "select",
    dictionary: "genre.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "season_month",
    display_name: "Season/Month",
    type: "select",
    dictionary: "season_month.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "week",
    display_name: "Week",
    type: "select",
    dictionary: "week.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "day",
    display_name: "Day",
    type: "select",
    dictionary: "day.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: 'text_standarization__usu_id',
    display_name: 'USU id',
    type: 'text',
    editable: true,
    can_be_null: true
  }

];

export default ContentStructure;
