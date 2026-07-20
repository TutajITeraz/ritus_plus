const isValidFolio = (value) => {
  if (value === "" || value == null) return true;
  const regex = /^\d+(\.[12])?$|^\d+[rv]$/;
  return regex.test(value);
};

const validateFolio = (value, row, index) => {
  if (value === "" || value == null) return null;
  return isValidFolio(value) ? null : `Invalid folio at row ${index + 1}`;
};

const validateSelectOrList = (value, row, index) => {
  if (value == null || value === "") return null;
  // Validation is handled elsewhere using dictionaries
  return null;
};

const validateNumber = (value, row, index) =>
  value == null || value === ""
    ? null
    : isNaN(value)
    ? `Must be a number at row ${index + 1}`
    : null;

const validateSequence = (value, row, index) => {
  if (value == null || value === "") return `Must not be empty at row ${index + 1}`;
  if (isNaN(value) || !Number.isInteger(Number(value)))
    return `Must be an integer at row ${index + 1}`;
  return null;
};

const CantusStructure = [
  {
    name: "field_folio",
    display_name: "Folio",
    type: "text",
    editable: true,
    can_be_null: true,
    validationFunction: validateFolio,
  },
  {
    name: "field_sequence",
    display_name: "Sequence",
    type: "sequence",
    editable: true,
    can_be_null: false,
    validationFunction: validateSequence,
  },
  {
    name: "field_office",
    display_name: "Office",
    type: "select",
    dictionary: "cantus_office.tsv",
    dictionary_key_col: "key",
    dictionary_display_col: "label",
    dictionary_export_col: "key",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "field_genre",
    display_name: "Genre",
    type: "select",
    dictionary: "cantus_genre.tsv",
    dictionary_key_col: "name",
    dictionary_display_col: "name",
    dictionary_export_col: "name",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "field_position",
    display_name: "Position",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "field_cantus_id",
    display_name: "Cantus ID",
    type: "text",
    editable: true,
    can_be_null: true,
    dictionary_key_col: "id",
    dictionary_display_col: "id",
    dictionary_export_col: "id",
    dictionary: "cantus_ids.csv",
    lookupColumn: "field_full_text_original",
  },
  {
    name: "field_full_text",
    display_name: "Full text",
    type: "automatic",
    editable: false,
    can_be_null: true,
    parentColumn: "field_cantus_id",
    dictionary: "cantus_ids.csv",
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
    name: "field_full_text_original",
    display_name: "Fulltext Original",
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
    name: "field_feast",
    display_name: "Feast",
    type: "select",
    dictionary: "cantus_feasts.tsv",
    dictionary_key_col: "key",
    dictionary_display_col: "label",
    dictionary_export_col: "key",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "field_mode",
    display_name: "Mode",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "field_differentia",
    display_name: "Differentia",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "field_finalis",
    display_name: "Finalis",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "field_rubrics",
    display_name: "Rubrics",
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
    name: "field_differentia_database",
    display_name: "Differentia Database",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "field_marginalia",
    display_name: "Marginalia",
    type: "select",
    dictionary: "cantus_marginalia.tsv",
    dictionary_key_col: "key",
    dictionary_display_col: "label",
    dictionary_export_col: "key",
    editable: true,
    can_be_null: true,
    validationFunction: validateSelectOrList,
  },
  {
    name: "field_notes_chant",
    display_name: "Notes",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "field_imageref_from_chant",
    display_name: "Image",
    type: "number",
    editable: true,
    can_be_null: true,
    validationFunction: validateNumber,
  },
  {
    name: "field_image_link",
    display_name: "External Image Link",
    type: "text",
    editable: true,
    can_be_null: true,
  },
  {
    name: "field_melody",
    display_name: "Melody",
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
    name: "field_melody_id",
    display_name: "Melody ID",
    type: "text",
    editable: true,
    can_be_null: true,
  },
];

export default CantusStructure;
