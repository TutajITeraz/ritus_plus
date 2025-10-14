const isInteger = (value) => {
  if (value === "" || value == null) return true;
  return Number.isInteger(Number(value));
};

const validateNumber = (value, row, index) => {
  if (value == null || value === "") return null;
  return isInteger(value)
    ? null
    : `Invalid integer at row ${index + 1}`;
};

const validateNonEmptyInteger = (value, row, index) => {
  if (value == null || value === "") return `Must not be empty at row ${index + 1}`;
  return isInteger(value)
    ? null
    : `Invalid integer at row ${index + 1}`;
};

const validateNonEmptyText = (value, row, index) => {
  if (value == null || value === "") return `Must not be empty at row ${index + 1}`;
  return null;
};

const validateSelectOrList = (value, row, index) => {
  if (value == null || value === "") return null;
  // Validation is handled elsewhere using dictionaries
  return null;
};

const validateSequence = (value, row, index) => {
  if (value == null || value === "") return `Must not be empty at row ${index + 1}`;
  if (isNaN(value) || !Number.isInteger(Number(value)))
    return `Must be an integer at row ${index + 1}`;
  return null;
};

const UsuariumStructure = [
  {
    name: "TYPE",
    display_name: "TYPE",
    type: "select",
    dictionary: "type.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "PART",
    display_name: "PART",
    type: "select",
    dictionary: "part.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "SEASON/MONTH",
    display_name: "SEASON/MONTH",
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
    name: "WEEK",
    display_name: "WEEK",
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
    name: "DAY",
    display_name: "DAY",
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
    name: "FEAST",
    display_name: "FEAST",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "COMMUNE/VOTIVE",
    display_name: "COMMUNE/VOTIVE",
    type: "select",
    dictionary: "commune_votive.tsv",
    dictionary_key_col: "short_name",
    dictionary_display_col: "name",
    dictionary_export_col: "short_name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "TOPICS",
    display_name: "TOPICS",
    type: "list",
    dictionary: "topic.tsv",
    dictionary_key_col: "name",
    dictionary_display_col: "name",
    dictionary_export_col: "name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "MASS/HOUR",
    display_name: "MASS/HOUR",
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
    name: "CEREMONY",
    display_name: "CEREMONY",
    type: "select",
    dictionary: "ceremony.tsv",
    dictionary_key_col: "name",
    dictionary_display_col: "name",
    dictionary_export_col: "name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "MODULE",
    display_name: "MODULE",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "SEQUENCE",
    display_name: "SEQUENCE",
    type: "number",
    editable: true,
    can_be_null: true,
    validationFunction: validateNumber,
  },
  {
    name: "RUBRICS",
    display_name: "RUBRICS",
    type: "text",
    editable: true,
    can_be_null: true,
    alternative_name: "RUBRIC",
    width: 300,
    style: {
      whiteSpace: "normal",
      wordWrap: "break-word",
    },
  },
  {
    name: "LAYER",
    display_name: "LAYER",
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
    name: "GENRE",
    display_name: "GENRE",
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
    name: "SERIES",
    display_name: "SERIES",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "ITEM",
    display_name: "ITEM",
    type: "text",
    editable: true,
    can_be_null: false,
    width: 300,
    style: {
      whiteSpace: "normal",
      wordWrap: "break-word",
    },
    validationFunction: validateNonEmptyText,
  },
  {
    name: "STANDARD ITEM",
    display_name: "STANDARD ITEM",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "EXPLICIT",
    display_name: "EXPLICIT",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "PAGE NUMBER (DIGITAL)",
    display_name: "PAGE NUMBER (DIGITAL)",
    type: "number",
    editable: true,
    can_be_null: false,
    validationFunction: validateNonEmptyInteger,
  },
  {
    name: "PAGE NUMBER (ORIGINAL)",
    display_name: "PAGE NUMBER (ORIGINAL)",
    type: "text",
    editable: true,
    can_be_null: false,
    validationFunction: validateNonEmptyText,
  },
  {
    name: "PAGE LINK",
    display_name: "PAGE LINK",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "REMARK",
    display_name: "REMARK",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "MADE BY",
    display_name: "MADE BY",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "EDITION NUMBER",
    display_name: "EDITION NUMBER",
    type: "number",
    editable: true,
    can_be_null: true,
    validationFunction: validateNumber,
  },
  {
    name: "_global_sequence",
    display_name: "_global_sequence",
    type: "sequence",
    editable: false,
    can_be_null: false,
    validationFunction: validateSequence,
  },
];

export default UsuariumStructure;