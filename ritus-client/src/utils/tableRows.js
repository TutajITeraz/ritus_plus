// Row helpers shared by the table editor and the batch "Process Table" runner.
// They are pure functions over row arrays so the batch runner can reproduce
// exactly what the DataTable buttons do without mounting the table.

// Unique ID generator
let idCounter = 0;
export const getUniqueId = () => {
  return idCounter++;
};

// Update sequenceKey for sequential order
export const updateSequences = (
  rows,
  sequenceKey,
  preserveExisting = false,
  newRowIndex = null,
  targetSequence = null
) => {
  const newRows = [...rows];

  // Handle case with new row insertion
  if (newRowIndex != null && targetSequence != null) {
    newRows[newRowIndex][sequenceKey] = targetSequence;
    newRows.forEach((row, index) => {
      if (index !== newRowIndex) {
        let seq = row[sequenceKey];
        if (!isNaN(seq) && Number.isInteger(Number(seq))) {
          seq = Number(seq);
          if (seq >= targetSequence) {
            row[sequenceKey] = seq + 1;
          }
        } else {
          row[sequenceKey] = index + 1;
        }
      }
    });
    const sorted = newRows
      .map((row, index) => ({
        row,
        originalIndex: index,
        sequence:
          row[sequenceKey] != null && !isNaN(row[sequenceKey])
            ? Number(row[sequenceKey])
            : Infinity,
      }))
      .sort((a, b) => {
        if (a.sequence === b.sequence) return a.originalIndex - b.originalIndex;
        return a.sequence - b.sequence;
      })
      .map((item) => item.row);

    // Renumbering internalIds
    sorted.forEach((item, index) => {
      item._internalId = index;
      if ("id" in item) item.id = index;
    });

    return sorted;
  }

  // Handle case with preserveExisting
  if (preserveExisting) {
    const sequences = newRows.map((row) => row[sequenceKey]);
    const isValid =
      sequences.every(
        (seq) => seq != null && !isNaN(seq) && Number.isInteger(Number(seq))
      ) && new Set(sequences).size === sequences.length;

    if (isValid) {
      // If sequences are valid and unique, sort by sequence and preserve them
      return newRows
        .map((row, index) => ({
          row,
          originalIndex: index,
          sequence: Number(row[sequenceKey]),
        }))
        .sort((a, b) => {
          if (a.sequence === b.sequence)
            return a.originalIndex - b.originalIndex;
          return a.sequence - b.sequence;
        })
        .map((item) => item.row);
    }
  }

  // Renumber sequences sequentially (handles duplicates or invalid sequences)
  const sorted = newRows
    .map((row, index) => ({
      row,
      originalIndex: index,
      sequence:
        row[sequenceKey] != null && !isNaN(row[sequenceKey])
          ? Number(row[sequenceKey])
          : Infinity,
    }))
    .sort((a, b) => {
      if (a.sequence === b.sequence) return a.originalIndex - b.originalIndex;
      return a.sequence - b.sequence;
    })
    .map((item) => item.row);

  // Also renumbering of the id's and internal id's
  sorted.forEach((item, index) => {
    item._internalId = index;
    if ("id" in item) item.id = index;
  });

  return sorted.map((row, index) => ({ ...row, [sequenceKey]: index + 1 }));
};

// Combine a group of rows (already sorted by sequence) into a single row.
// For every column other than the text/sequence columns, the first non-blank
// value found across the group wins, so metadata split across the rows
// (e.g. a marker row's function_id and a content row's formula_id) survives.
export const mergeRowsData = (rowsToMerge, tableStructure, sequenceKey) => {
  const textColumn =
    tableStructure.find((col) => col.type === "text")?.name ||
    "formula_text_from_ms";
  const fromColumn = tableStructure.find(
    (col) => col.name === "where_in_ms_from"
  )?.name;
  const toColumn = tableStructure.find(
    (col) => col.name === "where_in_ms_to"
  )?.name;

  const firstRow = rowsToMerge[0];
  const lastRow = rowsToMerge[rowsToMerge.length - 1];
  const mergedText = rowsToMerge
    .map((row) => row?.[textColumn])
    .filter(Boolean)
    .join(" ");
  const mergeSequence =
    firstRow?.[sequenceKey] != null && !isNaN(firstRow[sequenceKey])
      ? Number(firstRow[sequenceKey])
      : Infinity;

  const newRow = {
    _internalId: getUniqueId(),
    [textColumn]: mergedText,
    [sequenceKey]: mergeSequence,
  };
  tableStructure.forEach((col) => {
    if (
      col.name !== textColumn &&
      col.name !== sequenceKey &&
      col.name !== "_internalId"
    ) {
      const sourceRow = rowsToMerge.find(
        (r) => r?.[col.name] != null && r[col.name] !== ""
      );
      newRow[col.name] = sourceRow?.[col.name] ?? col.value ?? "";
    }
  });
  if (fromColumn) {
    newRow[fromColumn] = firstRow?.[fromColumn] || "";
  }
  if (toColumn) {
    newRow[toColumn] = lastRow?.[toColumn] || "";
  }
  return newRow;
};

// Columns Auto Propagate needs: without them there is nothing to propagate.
export const AUTO_PROPAGATE_COLUMNS = [
  "formula_text_from_ms",
  "formula_id",
  "function_id",
  "subfunction_id",
  "rite_name_from_ms",
  "subrite_name_from_ms",
  "rite_id",
];

export const supportsAutoPropagate = (tableStructure) =>
  AUTO_PROPAGATE_COLUMNS.every((name) =>
    tableStructure.some((col) => col.name === name)
  );

export const sequenceKeyOf = (tableStructure) =>
  tableStructure.find((col) => col.type === "sequence")?.name ||
  "sequence_in_ms";

// Fold marker rows (a row carrying only a function/rite/subrite label) into the
// content row below them and spread rite/subrite labels forward over the rows
// they cover. Returns the rewritten, resequenced rows; caller must have checked
// supportsAutoPropagate first.
export const autoPropagateRows = (data, tableStructure, sequenceKey) => {
  const isBlank = (value) => value == null || value === "";
  const isMarkerRow = (row, fields) =>
    fields.some((f) => !isBlank(row[f])) &&
    isBlank(row.formula_text_from_ms) &&
    isBlank(row.formula_id);

  let rows = data.map((row) => ({ ...row }));

  // Merges rows[index] with rows[index + 1] in place; returns false if
  // there is no row below to merge with.
  const mergeAt = (index) => {
    if (index < 0 || index + 1 >= rows.length) return false;
    const merged = mergeRowsData(
      [rows[index], rows[index + 1]],
      tableStructure,
      sequenceKey
    );
    rows.splice(index, 2, merged);
    return true;
  };

  // Step 1: function_id / subfunction_id markers merge with the single
  // row below them (a function/subfunction only ever labels one formula).
  {
    let i = 0;
    while (i < rows.length) {
      if (isMarkerRow(rows[i], ["function_id", "subfunction_id"])) {
        mergeAt(i);
      }
      i++;
    }
  }

  // Step 2: subrite_name_from_ms markers merge with the row below, then
  // propagate their value forward until the next subrite or rite marker.
  {
    let i = 0;
    while (i < rows.length) {
      if (isMarkerRow(rows[i], ["subrite_name_from_ms"])) {
        const subriteValue = rows[i].subrite_name_from_ms;
        if (mergeAt(i)) {
          let j = i + 1;
          while (
            j < rows.length &&
            isBlank(rows[j].rite_name_from_ms) &&
            isBlank(rows[j].subrite_name_from_ms)
          ) {
            if (!isBlank(rows[j].formula_text_from_ms)) {
              rows[j] = {
                ...rows[j],
                subrite_name_from_ms: subriteValue,
              };
            }
            j++;
          }
        }
      }
      i++;
    }
  }

  // Step 3: rite_name_from_ms / rite_id markers merge with the row below,
  // then propagate forward (through subrite-anchored rows too) until the
  // next rite marker, since one rite can span many subrites.
  {
    let i = 0;
    while (i < rows.length) {
      if (isMarkerRow(rows[i], ["rite_name_from_ms", "rite_id"])) {
        const riteName = rows[i].rite_name_from_ms;
        const riteId = rows[i].rite_id;
        if (mergeAt(i)) {
          let j = i + 1;
          while (j < rows.length && isBlank(rows[j].rite_name_from_ms)) {
            const isTarget =
              !isBlank(rows[j].formula_text_from_ms) ||
              !isBlank(rows[j].subrite_name_from_ms);
            if (isTarget) {
              const updated = { ...rows[j] };
              if (!isBlank(riteName) && isBlank(updated.rite_name_from_ms)) {
                updated.rite_name_from_ms = riteName;
              }
              if (!isBlank(riteId) && isBlank(updated.rite_id)) {
                updated.rite_id = riteId;
              }
              rows[j] = updated;
            }
            j++;
          }
        }
      }
      i++;
    }
  }

  // Step 4: clean up any marker rows that never found content to merge
  // with (e.g. a marker as the very last row).
  rows = rows.filter(
    (row) =>
      !isMarkerRow(row, [
        "function_id",
        "subfunction_id",
        "rite_name_from_ms",
        "subrite_name_from_ms",
        "rite_id",
      ])
  );

  return updateSequences(rows, sequenceKey, true);
};
