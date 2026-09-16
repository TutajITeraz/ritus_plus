// Turns a project's per-image transcriptions into eCatalogus table rows.
//
// The transcription markup is: <red>…</red> for rite names, <func>…</func> for
// functions, <subrub>…</subrub> for subrites, and "⏎" as a prayer separator.
// Each marker closes the formula text accumulated so far and becomes a row of
// its own; Auto Propagate later folds those marker rows into the formulas they
// label.
//
// Shared by the table editor's "Load Project Transcription" button and the
// batch "Process Table" runner on the projects list.

const parseTranscribedText = (text, startSequence) => {
  const rows = [];
  let sequenceCounter = startSequence;
  let currentFormulaText = "";
  let i = 0;

  const pushIfNotEmpty = (row) => {
    const hasContent = Object.values(row).some(
      (v) => typeof v === "string" && v.trim() !== ""
    );
    if (hasContent) {
      rows.push(row);
      return 1;
    } else return 0;
  };

  const emitMarker = (field, value) => {
    sequenceCounter += pushIfNotEmpty({
      id: sequenceCounter,
      sequence_in_ms: sequenceCounter,
      formula_text_from_ms: "",
      rite_name_from_ms: "",
      subrite_name_from_ms: "",
      function_id: "",
      [field]: value,
    });
  };

  const flushFormula = () => {
    sequenceCounter += pushIfNotEmpty({
      id: sequenceCounter,
      sequence_in_ms: sequenceCounter,
      formula_text_from_ms: currentFormulaText,
      rite_name_from_ms: "",
      subrite_name_from_ms: "",
      function_id: "",
    });
    currentFormulaText = "";
  };

  const tags = [
    { open: "<red>", close: "</red>", field: "rite_name_from_ms" },
    { open: "<func>", close: "</func>", field: "function_id" },
    { open: "<subrub>", close: "</subrub>", field: "subrite_name_from_ms" },
  ];

  outer: while (i < text.length) {
    for (const tag of tags) {
      if (text.slice(i, i + tag.open.length) !== tag.open) continue;
      flushFormula();
      i += tag.open.length;
      const endIndex = text.indexOf(tag.close, i);
      // An unterminated tag means the rest of the page is unusable markup;
      // stop here rather than swallowing it into the next formula.
      if (endIndex === -1) break outer;
      emitMarker(tag.field, text.slice(i, endIndex).trim());
      i = endIndex + tag.close.length;
      continue outer;
    }
    if (text[i] === "⏎") {
      flushFormula();
      i++;
    } else {
      currentFormulaText += text[i];
      i++;
    }
  }

  flushFormula();
  return { rows, nextSequence: sequenceCounter };
};

/**
 * Build table rows out of a project's images.
 *
 * @param images          array from fetchImages() – uses transcribed_text and name
 * @param tableStructure  the target structure, used to fill in missing columns
 * @returns array of rows (possibly empty)
 */
export const buildRowsFromTranscription = (images, tableStructure) => {
  let sequenceCounter = 1;
  let allParsedRows = [];
  let imageIndex = 0;

  // First pass: parse each image's text
  for (const img of images) {
    const text = img.transcribed_text || "";
    const { rows: parsedRows, nextSequence } = parseTranscribedText(
      text,
      sequenceCounter
    );
    sequenceCounter = nextSequence;
    img.endsWithReturn = text.endsWith("⏎");
    parsedRows.forEach((row) => {
      row._imageIndex = imageIndex;
      row._img = img;
    });
    allParsedRows = allParsedRows.concat(parsedRows);
    imageIndex++;
  }

  // Second pass: merge rows across pages where no "⏎" separates them
  const mergedRows = [];
  let i = 0;
  while (i < allParsedRows.length) {
    let currentRow = { ...allParsedRows[i] };
    const fromImg = currentRow._img;
    let toImg = currentRow._img;

    // Merge with subsequent rows from different images if no "⏎" at end of previous image
    while (
      i + 1 < allParsedRows.length &&
      allParsedRows[i]._imageIndex !== allParsedRows[i + 1]._imageIndex &&
      !allParsedRows[i]._img.endsWithReturn
    ) {
      const nextRow = allParsedRows[i + 1];
      currentRow.formula_text_from_ms += nextRow.formula_text_from_ms;
      if (!currentRow.rite_name_from_ms)
        currentRow.rite_name_from_ms = nextRow.rite_name_from_ms;
      if (!currentRow.subrite_name_from_ms)
        currentRow.subrite_name_from_ms = nextRow.subrite_name_from_ms;
      if (!currentRow.function_id) currentRow.function_id = nextRow.function_id;
      toImg = nextRow._img;
      i++;
    }

    const row = {
      _internalId: Date.now() + i * 1000,
      where_in_ms_from: fromImg.name || "",
      where_in_ms_to: toImg.name || "",
      formula_text_from_ms: currentRow.formula_text_from_ms,
      rite_name_from_ms: currentRow.rite_name_from_ms,
      subrite_name_from_ms: currentRow.subrite_name_from_ms,
      function_id: currentRow.function_id,
      sequence_in_ms: currentRow.sequence_in_ms,
      digital_page_number: fromImg.page_number || 1,
    };

    // Fill in any missing columns from the structure
    tableStructure.forEach((col) => {
      if (!(col.name in row)) {
        row[col.name] = col.value ?? "";
      }
    });

    mergedRows.push(row);
    i++;
  }

  return mergedRows;
};
