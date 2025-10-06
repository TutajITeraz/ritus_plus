import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from "react";
import {
  Button,
  ActionBar,
  Portal,
  Kbd,
  Dialog,
  HStack,
  FileUpload,
  Icon,
  CloseButton,
  VStack,
  Spinner,
  Text,
  Input,
  Textarea,
  Select,
  Checkbox,
  NumberInput,
  Progress,
  createListCollection,
} from "@chakra-ui/react";
import { FaTrash, FaSearch } from "react-icons/fa";
import { LuUpload } from "react-icons/lu";
import { RiSave3Fill } from "react-icons/ri";
import { MdUploadFile, MdVisibility } from "react-icons/md";
import { TbBadgesFilled } from "react-icons/tb";
import { GrValidate } from "react-icons/gr";
import { BiSolidError } from "react-icons/bi";
import { DataGrid, SelectColumn } from "react-data-grid";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import DictionaryLookup from "./DictionaryLookup";
import {
  parseCSV,
  countMatchingWords,
  calculateLevenshteinSimilarity,
} from "../utils/lookup";
import "react-data-grid/lib/styles.css";
import "./DataTable.css";

// ErrorBoundary for rendering errors
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: "red", padding: "16px" }}>
          Error: {this.state.error?.message || "An unexpected error occurred"}
          <pre>{JSON.stringify(this.state.errorInfo, null, 2)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// Unique ID generator
let idCounter = 0;
const getUniqueId = () => {
  return idCounter++;
};

// Update sequenceKey for sequential order
const updateSequences = (
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

// EditableTextarea component for multiline editing with text selection handling
const EditableTextarea = ({ value, onChange, onBlur, rowId, setSelection }) => {
  const textareaRef = useRef(null);
  const isClickingCell = useRef(false);

  const handleSelection = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const selectedText = textarea.value.slice(
      textarea.selectionStart,
      textarea.selectionEnd
    );
    if (selectedText.trim()) {
      setSelection({ text: selectedText, rowId });
      console.log("Textarea selection updated:", { selectedText, rowId });
    } else {
      setSelection(null);
      console.log("Textarea selection cleared:", { rowId });
    }
  }, [rowId, setSelection]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      // Ensure onSelect is triggered even after focus
      textarea.addEventListener("select", handleSelection);
      return () => {
        textarea.removeEventListener("select", handleSelection);
      };
    }
  }, [handleSelection]);

  return (
    <Textarea
      ref={textareaRef}
      className="rdg-text-editor"
      value={value}
      onChange={(event) => {
        onChange(event);
        // Trigger handleSelection after change to catch any new selection
        handleSelection();
      }}
      onBlur={(e) => {
        const relatedTarget = e.relatedTarget;
        if (relatedTarget?.dataset.testid === "split-button") {
          console.log("Focus moved to split button, preserving selection");
          return;
        }
        if (isClickingCell.current) {
          console.log("Skipping blur handling due to cell click", { rowId });
          return;
        }
        console.log("Textarea blurred:", { rowId });
        onBlur(e);
        setSelection(null);
      }}
      onSelect={handleSelection}
      onMouseUp={() => {
        // Trigger selection handling on mouse up to catch drag selections
        handleSelection();
      }}
      resize="none"
      style={{
        width: "100%",
        height: "100%",
        overflowY: "auto",
        overflowX: "hidden",
        display: "block",
        boxSizing: "border-box",
        padding: "2px",
        fontFamily: '"Courier New", monospace',
        fontSize: "14px",
        lineHeight: "22px",
      }}
      onMouseDown={() => {
        isClickingCell.current = false;
      }}
    />
  );
};

// Estimate row height based on text content
const getRowHeight = (row, tableStructure, dictionaries) => {
  const lineHeight = 22;
  const padding = 16;
  const defaultWidth = 100;
  const charsPerLine = {
    300: 40,
    200: 25,
    100: 12,
  };

  let maxLines = 1;
  tableStructure.forEach((col) => {
    const isMultiline =
      col.style?.wordWrap === "break-word" ||
      col.style?.overflowWrap === "break-word";
    if (!isMultiline) return;

    let text = "";
    if (
      col.type === "automatic" &&
      dictionaries[col.name] &&
      col.parentColumn
    ) {
      text = String(dictionaries[col.name][row[col.parentColumn]] || "");
    } else if (col.computeFunction) {
      const content = tableStructure.reduce((acc, c) => {
        if (c.type === "automatic" && dictionaries[c.name] && c.parentColumn) {
          acc[c.name] = dictionaries[c.name][row[c.parentColumn]] || "";
        } else {
          acc[c.name] = row[c.name] ?? "";
        }
        return acc;
      }, {});
      text = String(col.computeFunction(content) || "");
    } else {
      text = String(row[col.name] ?? "");
    }
    if (!text) return;

    const width = col.width || defaultWidth;
    const charsPerLineForWidth = charsPerLine[width] || 12;
    const lines = text.split("\n");
    const lineCount = lines.reduce((sum, line) => {
      return sum + Math.max(1, Math.ceil(line.length / charsPerLineForWidth));
    }, 0);
    const clampedLineCount = Math.min(20, Math.max(1, lineCount));
    maxLines = Math.max(maxLines, clampedLineCount);
  });

  return Math.max(maxLines * lineHeight, 30) + padding;
};

const DataTable = ({ tableStructure, data = [], setData }) => {
  const [selection, setSelection] = useState(null);
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [validationErrors, setValidationErrors] = useState([]);
  const [cellErrors, setCellErrors] = useState(new Map());
  const [visibleColumns, setVisibleColumns] = useState(
    tableStructure.reduce((acc, col) => ({ ...acc, [col.name]: true }), {})
  );
  const [dictionaries, setDictionaries] = useState({});
  const [lookupConfig, setLookupConfig] = useState(null);
  const [loadingCSV, setLoadingCSV] = useState(false);
  const [csvParseError, setCsvParseError] = useState(null);
  const [isPostImport, setIsPostImport] = useState(false);
  const [autoFillOpen, setAutoFillOpen] = useState(false);
  const [autoFillColumn, setAutoFillColumn] = useState(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [similarityThreshold, setSimilarityThreshold] = useState(50);
  const [updatedRows, setUpdatedRows] = useState(0);
  const [changedRows, setChangedRows] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [autoFillLoading, setAutoFillLoading] = useState(false);
  const csvDialogRef = useRef(null);
  const errorDialogRef = useRef(null);
  const autoFillDialogRef = useRef(null);
  const autoFillContentRef = useRef(null);
  const gridRef = useRef(null);
  const [selectedCell, setSelectedCell] = useState(null);
  const dictionaryCache = useRef(new Map());
  const levenshteinCache = useRef(new Map());
  const isClickingCell = useRef(false);

  const sequenceKey =
    tableStructure.find((col) => col.type === "sequence")?.name ||
    "sequence_in_ms";

  const rowKeyGetter = useCallback((row) => row._internalId, []);

  // Reset visible columns when tableStructure changes
  useEffect(() => {
    setVisibleColumns(
      tableStructure.reduce((acc, col) => ({ ...acc, [col.name]: true }), {})
    );
  }, [tableStructure]);

  const validateUniqueIds = useCallback((newData) => {
    const idSet = new Set();
    newData.forEach((row) => {
      if (idSet.has(row._internalId)) {
        console.error("Duplicate _internalId detected:", row._internalId);
      }
      idSet.add(row._internalId);
    });
  }, []);

  const validateRow = useCallback(
    (row, rowIndex) => {
      const errors = [];
      tableStructure.forEach((col) => {
        if (col.computeFunction) return; // Skip computed columns
        const value = row[col.name];
        if (!col.can_be_null && (value == null || value === "")) {
          errors.push({
            rowId: row._internalId,
            columnName: col.name,
            message: `Row ${rowIndex + 1}: ${col.display_name} cannot be empty`,
            rowIndex,
          });
        }
        if (col.validationFunction) {
          const error = col.validationFunction(value, row, rowIndex);
          if (error) {
            errors.push({
              rowId: row._internalId,
              columnName: col.name,
              message: `Row ${rowIndex + 1}: ${col.display_name}: ${error}`,
              rowIndex,
            });
          }
        }
        if (col.type === "sequence" && value != null && value !== "") {
          const otherRows = data.filter(
            (r) => r._internalId !== row._internalId
          );
          if (otherRows.some((r) => r[col.name] === value)) {
            errors.push({
              rowId: row._internalId,
              columnName: col.name,
              message: `Row ${rowIndex + 1}: ${
                col.display_name
              } must be unique`,
              rowIndex,
            });
          }
        }
        if (
          col.type === "select" &&
          col.dictionary &&
          value != null &&
          value !== ""
        ) {
          const options = dictionaries[col.name]?.items || [];
          if (!options.some((opt) => opt.value === value)) {
            errors.push({
              rowId: row._internalId,
              columnName: col.name,
              message: `Row ${rowIndex + 1}: ${
                col.display_name
              } must be a valid option from ${col.dictionary}`,
              rowIndex,
            });
          }
        }
        if (
          col.type === "list" &&
          col.dictionary &&
          value != null &&
          value !== ""
        ) {
          const parts = value.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
          const validValues = (dictionaries[col.name]?.items || []).map((opt) => opt.value);
          const invalid = parts.filter((p) => !validValues.includes(p));
          if (invalid.length > 0) {
            errors.push({
              rowId: row._internalId,
              columnName: col.name,
              message: `Row ${rowIndex + 1}: ${col.display_name}: Invalid values: ${invalid.join(", ")}`,
              rowIndex,
            });
          }
        }
        if (
          col.type === "number" &&
          col.dictionary &&
          !col.parentColumn && // it is parent, because it does not have parent
          value != null &&
          value !== ""
        ) {
          const options = dictionaries[col.name] || {};
          if (!Object.prototype.hasOwnProperty.call(options, value)) {
            errors.push({
              rowId: row._internalId,
              columnName: col.name,
              message: `Row ${rowIndex + 1}: ${
                col.display_name
              } must be a valid id from ${col.dictionary}`,
              rowIndex,
            });
          }
        }
      });
      return errors;
    },
    [tableStructure, data, dictionaries]
  );

  const validateTable = useCallback(() => {
    const allErrors = data.flatMap((row, index) => validateRow(row, index));
    const newCellErrors = new Map();
    allErrors.forEach((error) => {
      const key = `${error.rowId}-${error.columnName}`;
      newCellErrors.set(key, error.message);
    });
    setValidationErrors(allErrors);
    setCellErrors(newCellErrors);
    console.log("Validation errors updated:", {
      totalErrors: allErrors.length,
      cellErrors: Array.from(newCellErrors.entries()),
    });
  }, [data, validateRow]);

  const onRowsChange = useCallback(
    (newRows, { indexes, column }) => {
      console.log("onRowsChange called:", { indexes, columnKey: column.key });
      const newData = newRows.map((row) => ({ ...row }));
      const editedRowIds = indexes.map((index) => newData[index]._internalId);

      const newCellErrors = new Map(cellErrors);
      editedRowIds.forEach((rowId) => {
        tableStructure.forEach((col) => {
          const key = `${rowId}-${col.name}`;
          newCellErrors.delete(key);
        });
      });

      const rowErrors = indexes.flatMap((index) =>
        validateRow(newData[index], index)
      );
      rowErrors.forEach((error) => {
        const key = `${error.rowId}-${error.columnName}`;
        newCellErrors.set(key, error.message);
      });

      const newValidationErrors = validationErrors.filter(
        (error) => !editedRowIds.includes(error.rowId)
      );
      newValidationErrors.push(...rowErrors);

      setValidationErrors(newValidationErrors);
      setCellErrors(newCellErrors);
      setData(newData);
      console.log("Row validation updated:", {
        editedRows: indexes.length,
        newErrors: rowErrors.length,
        totalErrors: newValidationErrors.length,
        cellErrors: Array.from(newCellErrors.entries()),
      });
    },
    [data, validateRow, validationErrors, cellErrors, tableStructure]
  );

  const handleDelete = useCallback(() => {
    const newData = data.filter((row) => !selectedRows.has(row._internalId));
    const updatedData = updateSequences(newData, sequenceKey, true);
    validateUniqueIds(updatedData);
    setData(updatedData);
    setSelectedRows(new Set());
    setValidationErrors((prev) =>
      prev.filter((e) => !selectedRows.has(e.rowId))
    );
    setCellErrors((prev) => {
      const newMap = new Map(prev);
      for (const key of newMap.keys()) {
        if (selectedRows.has(key.split("-")[0])) {
          newMap.delete(key);
        }
      }
      return newMap;
    });
  }, [data, selectedRows, sequenceKey, validateUniqueIds]);

  const handleSplit = useCallback(() => {
    console.log("handleSplit called with selection:", selection);
    if (!selection || !selection.text?.trim() || selection.rowId == null) {
      console.warn("Invalid selection data:", selection);
      return;
    }
    const rowIndex = data.findIndex(
      (row) => row._internalId === selection.rowId
    );
    if (rowIndex === -1) {
      console.warn("Row not found for ID:", selection.rowId);
      return;
    }
    const row = data[rowIndex];
    const textColumn =
      tableStructure.find((col) => col.type === "text")?.name ||
      "formula_text_from_ms";
    if (
      !textColumn ||
      !row[textColumn] ||
      typeof row[textColumn] !== "string"
    ) {
      console.warn("No valid text column or text data found:", {
        textColumn,
        row,
      });
      return;
    }
    const selText = selection.text;
    const startIndex = row[textColumn].indexOf(selText);
    if (startIndex === -1) {
      console.warn("Selected text not found in row:", {
        selText,
        rowText: row[textColumn],
      });
      return;
    }
    const endIndex = startIndex + selText.length;
    const leftPart = row[textColumn].substring(0, startIndex).trim();
    const rightPart = row[textColumn].substring(endIndex).trim();

    const newRows = [];
    if (leftPart) {
      newRows.push({
        ...row,
        _internalId: getUniqueId(),
        [textColumn]: leftPart,
      });
    }
    newRows.push({ ...row, _internalId: getUniqueId(), [textColumn]: selText });
    if (rightPart) {
      newRows.push({
        ...row,
        _internalId: getUniqueId(),
        [textColumn]: rightPart,
      });
    }
    const newData = [
      ...data.slice(0, rowIndex),
      ...newRows,
      ...data.slice(rowIndex + 1),
    ];
    const updatedData = updateSequences(newData, sequenceKey, true);
    validateUniqueIds(updatedData);
    setData(updatedData);
    setSelection(null);
    validateTable();
  }, [
    data,
    selection,
    tableStructure,
    sequenceKey,
    validateTable,
    validateUniqueIds,
  ]);

  const handleMerge = useCallback(() => {
    if (selectedRows.size < 2) return;
    const textColumn =
      tableStructure.find((col) => col.type === "text")?.name ||
      "formula_text_from_ms";
    const mergedText = Array.from(selectedRows)
      .map((id) => data.find((row) => row._internalId === id)?.[textColumn])
      .filter(Boolean)
      .join(" ");
    const mergeSequence = Math.min(
      ...Array.from(selectedRows).map(
        (id) =>
          data.find((row) => row._internalId === id)?.[sequenceKey] || Infinity
      )
    );
    const baseRowId = Array.from(selectedRows).sort(
      (a, b) =>
        (data.find((row) => row._internalId === a)?.[sequenceKey] || Infinity) -
        (data.find((row) => row._internalId === b)?.[sequenceKey] || Infinity)
    )[0];
    const baseRow = data.find((row) => row._internalId === baseRowId);
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
        newRow[col.name] = baseRow?.[col.name] || col.value || "";
      }
    });
    const firstRowIndex = data.findIndex(
      (row) => row._internalId === baseRowId
    );
    const newData = [
      ...data.filter((row) => !selectedRows.has(row._internalId)),
    ];
    newData.splice(firstRowIndex, 0, newRow);
    const updatedData = updateSequences(newData, sequenceKey, true);
    validateUniqueIds(updatedData);
    setData(updatedData);
    setSelectedRows(new Set());
    setValidationErrors((prev) =>
      prev.filter((e) => !selectedRows.has(e.rowId))
    );
    setCellErrors((prev) => {
      const newMap = new Map(prev);
      for (const key of newMap.keys()) {
        if (selectedRows.has(key.split("-")[0])) {
          newMap.delete(key);
        }
      }
      return newMap;
    });
    validateTable();
  }, [
    data,
    selectedRows,
    tableStructure,
    sequenceKey,
    validateTable,
    validateUniqueIds,
  ]);

  const handleInsertAbove = useCallback(() => {
    if (selectedRows.size !== 1) return;
    const selectedRowId = Array.from(selectedRows)[0];
    const rowIndex = data.findIndex((row) => row._internalId === selectedRowId);
    if (rowIndex === -1) {
      console.warn("Selected row not found:", selectedRowId);
      return;
    }
    const selectedRow = data[rowIndex];
    // Set targetSequence to match the selected row's sequence (or default to rowIndex + 1)
    const targetSequence =
      selectedRow[sequenceKey] != null && !isNaN(selectedRow[sequenceKey])
        ? Number(selectedRow[sequenceKey])
        : rowIndex + 1;
    const newRow = {
      _internalId: getUniqueId(),
      [sequenceKey]: targetSequence,
    };
    tableStructure.forEach((col) => {
      if (col.name !== sequenceKey) {
        newRow[col.name] = col.value ?? "";
      }
    });
    const newData = [
      ...data.slice(0, rowIndex),
      newRow,
      ...data.slice(rowIndex),
    ];
    const updatedData = updateSequences(
      newData,
      sequenceKey,
      false,
      rowIndex,
      targetSequence
    );
    validateUniqueIds(updatedData);
    setData(updatedData);
    setSelectedRows(new Set([newRow._internalId]));
    validateTable();
  }, [
    data,
    selectedRows,
    tableStructure,
    sequenceKey,
    validateTable,
    validateUniqueIds,
  ]);

  const handleInsertBelow = useCallback(() => {
    if (selectedRows.size !== 1) return;
    const selectedRowId = Array.from(selectedRows)[0];
    const rowIndex = data.findIndex((row) => row._internalId === selectedRowId);
    if (rowIndex === -1) {
      console.warn("Selected row not found:", selectedRowId);
      return;
    }
    const selectedRow = data[rowIndex];
    const targetSequence = (selectedRow[sequenceKey] || rowIndex + 1) + 1;
    const newRow = {
      _internalId: getUniqueId(),
      [sequenceKey]: targetSequence,
    };
    tableStructure.forEach((col) => {
      if (col.name !== sequenceKey) {
        newRow[col.name] = col.value ?? "";
      }
    });
    const newData = [
      ...data.slice(0, rowIndex + 1),
      newRow,
      ...data.slice(rowIndex + 1),
    ];
    const updatedData = updateSequences(
      newData,
      sequenceKey,
      false,
      rowIndex + 1,
      targetSequence
    );
    validateUniqueIds(updatedData);
    setData(updatedData);
    setSelectedRows(new Set([newRow._internalId]));
    validateTable();
  }, [
    data,
    selectedRows,
    tableStructure,
    sequenceKey,
    validateTable,
    validateUniqueIds,
  ]);

  const handleSave = useCallback(() => {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    saveAs(blob, "tableData.json");
  }, [data]);

  const handleCSVExport = useCallback(() => {
    const visibleCols = tableStructure.filter(
      (col) => visibleColumns[col.name]
    );
    const headers = visibleCols.map((col) => col.name);
    const csvData = data.map((row, index) => {
      const content = tableStructure.reduce((acc, col) => {
        if (col.type === "automatic" && dictionaries[col.name] && col.parentColumn) {
          acc[col.name] = dictionaries[col.name][row[col.parentColumn]] || "N/A";
        } else if (col.computeFunction) {
          acc[col.name] =
            col.computeFunction({
              ...row,
              ...tableStructure.reduce((computed, c) => {
                if (c.type === "automatic" && dictionaries[c.name] && c.parentColumn) {
                  computed[c.name] = dictionaries[c.name][row[c.parentColumn]] || "N/A";
                }
                return computed;
              }, {}),
            }) || "N/A";
        } else if (col.type === "select") {
          const selected = row[col.name] ?? "";
          console.log("Exporting select column:", {
            column: col.name,
            rowIndex: index,
            internalId: row._internalId,
            rawValue: selected,
            dictionary: col.dictionary,
            hasDictionary: !!col.dictionary,
          });
          acc[col.name] = selected;
        } else if (col.type === "list") {
          const selected = row[col.name] ?? "";
          acc[col.name] = selected;
        } else {
          acc[col.name] = row[col.name] ?? "";
        }
        return acc;
      }, {});
      return visibleCols.map((col) => content[col.name]);
    });
    const csv = Papa.unparse({
      fields: headers,
      data: csvData,
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    saveAs(blob, "tableData.csv");
  }, [tableStructure, visibleColumns, dictionaries, data]);

  const handleCSVImport = useCallback(
    (files) => {
      if (files.length === 0) return;
      setLoadingCSV(true);
      setCsvParseError(null);
      setIsPostImport(true);
      const file = files[0];
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const csvColumns = results.meta.fields || [];
          const newVisibleColumns = tableStructure.reduce((acc, col) => {
            acc[col.name] = csvColumns.includes(col.name);
            return acc;
          }, {});
          setVisibleColumns(newVisibleColumns);

          const sequenceCol = tableStructure.find(
            (col) => col.type === "sequence"
          )?.name;
          let hasValidSequence = false;
          if (sequenceCol && csvColumns.includes(sequenceCol)) {
            const sequences = results.data
              .map((row) => row[sequenceCol])
              .filter((seq) => seq != null && seq !== "");
            hasValidSequence =
              sequences.length === results.data.length &&
              sequences.every(
                (seq) => !isNaN(seq) && Number.isInteger(Number(seq))
              ) &&
              new Set(sequences).size === sequences.length;
          }

          const newData = results.data.map((row, index) => {
            const newRow = { _internalId: getUniqueId() };
            tableStructure.forEach((col) => {
              if (col.type !== "automatic" && !col.computeFunction) {
                let value;
                if (col.type === "number") {
                  value =
                    (row[col.name] === "" || row[col.name] == null) && col.can_be_null
                      ? null
                      : Number(row[col.name]);
                } else if (col.type === "boolean") {
                  const raw = row[col.name];
                  if (raw === "" || raw == null) {
                    value = null;
                  } else if (
                    raw === "1" ||
                    raw === 1 ||
                    raw.toString().toLowerCase() === "true"
                  ) {
                    value = true;
                  } else if (
                    raw === "0" ||
                    raw === 0 ||
                    raw.toString().toLowerCase() === "false"
                  ) {
                    value = false;
                  } else {
                    value = null; // fallback if something weird
                  }
                } else {
                  value = row[col.name];
                }
                newRow[col.name] = value ?? col.value ?? "";
              }
            });
            if (!hasValidSequence && sequenceCol) {
              newRow[sequenceCol] = index + 1;
            }
            return newRow;
          });

          const updatedData = hasValidSequence
            ? newData
            : updateSequences(newData, sequenceCol, true);
          validateUniqueIds(updatedData);
          setData(updatedData);
          setLoadingCSV(false);
          validateTable();
          csvDialogRef.current
            ?.querySelector("[data-part='close-trigger']")
            ?.click();
        },
        error: () => {
          setCsvParseError("Failed to parse CSV file");
          setLoadingCSV(false);
          setIsPostImport(false);
        },
      });
    },
    [sequenceKey, tableStructure, validateUniqueIds, validateTable]
  );

  const toggleColumnVisibility = useCallback((columnName) => {
    setVisibleColumns((prev) => ({
      ...prev,
      [columnName]: !prev[columnName],
    }));
  }, []);

  const openLookup = useCallback((row, column) => {
    console.log("openLookup called:", {
      dataId: row.id,
      internalId: row._internalId,
      column: column.name,
    });
    setLookupConfig({ row, column });
  }, []);

  const closeLookup = useCallback(() => {
    setLookupConfig(null);
    console.log("Closing lookup");
  }, []);

  const scrollToError = useCallback(
    (error) => {
      const rowIndex = data.findIndex((row) => row._internalId === error.rowId);
      if (rowIndex === -1) {
        console.warn(`Row not found: ${error.rowId}`);
        return;
      }
      if (!visibleColumns[error.columnName]) {
        setVisibleColumns((prev) => ({
          ...prev,
          [error.columnName]: true,
        }));
      }
      const visibleCols = tableStructure.filter(
        (col) => visibleColumns[col.name] || col.name === error.columnName
      );
      const colIndex = visibleCols.findIndex(
        (col) => col.name === error.columnName
      );
      if (colIndex === -1) {
        console.warn(`Column not found: ${error.columnName}`);
        return;
      }
      if (gridRef.current) {
        gridRef.current.scrollToCell({ rowIdx: rowIndex, idx: colIndex + 1 });
        gridRef.current.selectCell({ rowIdx: rowIndex, idx: colIndex + 1 });
        console.log("Scrolled and selected cell:", {
          rowIdx: rowIndex,
          colIdx: colIndex + 1,
        });
      }
      errorDialogRef.current
        ?.querySelector("[data-part='close-trigger']")
        ?.click();
    },
    [data, tableStructure, visibleColumns]
  );

  const handleFill = useCallback(({ columnKey, sourceRow, targetRow }) => {
    console.log("Fill applied:", { columnKey, sourceRow, targetRow });
    if (columnKey === SelectColumn.key) return targetRow;
    return { ...targetRow, [columnKey]: sourceRow[columnKey] };
  }, []);

  const handleAutoFill = useCallback(async () => {
    if (!autoFillColumn || !autoFillColumn.dictionary) return;
    setAutoFillLoading(true);
    setUpdatedRows(0);
    setChangedRows(0);
    setTotalRows(0);

    try {
      const response = await fetch(`/data/${autoFillColumn.dictionary}`);
      if (!response.ok) {
        console.error("Failed to load dictionary CSV:", response.statusText);
        return;
      }
      const csvText = await response.text();
      const entries = parseCSV(csvText);

      setTotalRows(data.length);

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        if (
          !replaceExisting &&
          row[autoFillColumn.name] != null &&
          row[autoFillColumn.name] !== ""
        ) {
          console.log("Skipping row (existing value):", {
            rowIndex: i,
            internalId: row._internalId,
            column: autoFillColumn.name,
            existingValue: row[autoFillColumn.name],
          });

          setUpdatedRows((prev) => prev + 1);
          continue;
        }
        const text = row[autoFillColumn.lookupColumn]?.toLowerCase() || "";
        if (!text) {
          console.log("Skipping row (no lookup text):", {
            rowIndex: i,
            internalId: row._internalId,
            column: autoFillColumn.name,
          });

          setUpdatedRows((prev) => prev + 1);
          continue;
        }

        const how_many_matches = text.length < 60 ? 9999 : 15;

        const matches = countMatchingWords(entries, text, how_many_matches);
        const bestMatches = calculateLevenshteinSimilarity(
          matches,
          text,
          levenshteinCache.current
        );
        if (bestMatches.length > 0) {
          const distance = bestMatches[0].levenstein;
          const maxLength = Math.max(text.length, bestMatches[0].text.length);
          const similarity = maxLength
            ? ((maxLength - distance) / maxLength) * 100
            : 100;
          if (similarity >= similarityThreshold) {
            console.log("Before update:", {
              rowIndex: i,
              internalId: row._internalId,
              column: autoFillColumn.name,
              currentData: data.map((r) => ({
                internalId: r._internalId,
                [autoFillColumn.name]: r[autoFillColumn.name],
              })),
            });
            setChangedRows((prev) => prev + 1);

            setData((prevData) => {
              const newData = [...prevData];
              newData[i] = {
                ...newData[i],
                [autoFillColumn.name]: Number(bestMatches[0].id),
              };
              console.log("After update:", {
                rowIndex: i,
                internalId: row._internalId,
                column: autoFillColumn.name,
                updatedValue: bestMatches[0].id,
                newData: newData.map((r) => ({
                  internalId: r._internalId,
                  [autoFillColumn.name]: r[autoFillColumn.name],
                })),
              });
              return newData;
            });

            console.log("Row updated:", {
              rowIndex: i,
              internalId: row._internalId,
              column: autoFillColumn.name,
              value: bestMatches[0].id,
              similarity,
            });
          } else {
            console.log("Row skipped (low similarity):", {
              rowIndex: i,
              internalId: row._internalId,
              column: autoFillColumn.name,
              similarity,
            });
          }
        } else {
          console.log("Row skipped (no matches):", {
            rowIndex: i,
            internalId: row._internalId,
            column: autoFillColumn.name,
          });
        }

        setUpdatedRows((prev) => prev + 1);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      setData((prevData) => {
        const updatedData = updateSequences(prevData, sequenceKey, true);
        validateUniqueIds(updatedData);
        console.log("Final data after sequence update:", {
          data: updatedData.map((r) => ({
            internalId: r._internalId,
            [autoFillColumn.name]: r[autoFillColumn.name],
          })),
        });
        return updatedData;
      });
      validateTable();
    } catch (error) {
      console.error("Error during autofill:", error);
    } finally {
      setAutoFillLoading(false);
      autoFillDialogRef.current
        ?.querySelector("[data-part='close-trigger']")
        ?.click();
    }
  }, [
    autoFillColumn,
    replaceExisting,
    similarityThreshold,
    data,
    sequenceKey,
    validateTable,
    validateUniqueIds,
  ]);

  const columns = useMemo(() => {
    const visibleCols = tableStructure.filter(
      (col) => visibleColumns[col.name]
    );
    const defaultWidth = 100;
    const charsPerLine = {
      300: 40,
      200: 25,
      100: 12,
    };

    return [
      {
        ...SelectColumn,
        width: 50,
        frozen: true,
        resizable: false,
      },
      ...visibleCols.map((col) => ({
        key: col.name,
        name: col.display_name,
        width: col.width || defaultWidth,
        minWidth: 50,
        resizable: true,
        editable: col.editable !== false,
        cellClass: (row) =>
          cellErrors.has(`${row._internalId}-${col.name}`) ? "error-cell" : "",
        renderCell: ({ row, rowIdx }) => {
          const cellError = cellErrors.get(`${row._internalId}-${col.name}`);
          const isMultiline =
            col.style?.wordWrap === "break-word" ||
            col.style?.overflowWrap === "break-word";
          const content = tableStructure.reduce((acc, c) => {
            if (
              c.type === "automatic" &&
              dictionaries[c.name] &&
              c.parentColumn
            ) {
              acc[c.name] = dictionaries[c.name][row[c.parentColumn]] || "N/A";
            } else {
              acc[c.name] = row[c.name] ?? "";
            }
            return acc;
          }, {});
          let value = col.computeFunction
            ? col.computeFunction(content) || "N/A"
            : col.type === "automatic" &&
              dictionaries[col.name] &&
              col.parentColumn
            ? dictionaries[col.name][row[col.parentColumn]] || "N/A"
            : col.display_element
            ? col.display_element(row[col.name] ?? "")
            : row[col.name] ?? "";
          if (col.dictionary && col.type === "select") {
            const selected = row[col.name];
            if (selected) {
              const entry = dictionaries[col.name]?.items.find((o) => o.value === selected);
              value = entry?.label || selected;
            } else {
              value = "";
            }
          }
          if (col.dictionary && col.type === "list") {
            const parts = (row[col.name] || "").split(/[,;]/).map((p) => p.trim()).filter(Boolean);
            const labels = parts.map((p) => {
              const opt = dictionaries[col.name]?.items.find((o) => o.value === p);
              return opt?.label || p;
            });
            value = labels.join(", ");
          }
          return (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                height: "100%",
                width: "100%",
                whiteSpace: isMultiline ? "pre-line" : "normal",
                overflowWrap: isMultiline ? "break-word" : "normal",
                fontFamily: '"Courier New", monospace',
                fontSize: "14px",
                lineHeight: "22px",
                ...col.style,
              }}
              onMouseUp={() => {
                if (col.type === "text") {
                  const selectedText = window.getSelection()?.toString() || "";
                  if (selectedText) {
                    setSelection({
                      text: selectedText,
                      rowId: row._internalId,
                    });
                    console.log("Selection updated:", {
                      text: selectedText,
                      dataId: row.id,
                      internalId: row._internalId,
                    });
                  } else {
                    setSelection(null);
                  }
                }
              }}
              title={cellError || ""}
            >
              {col.type === "boolean" && row[col.name] != null && row[col.name] !== "" ? (
                <input
                  type="checkbox"
                  checked={!!row[col.name]}
                  readOnly
                  style={{ margin: "2px" }}
                />
              ) : (
                <span
                  className="rdg-cell-content"
                  style={{
                    flex: 1,
                    display: "block",
                    maxHeight: "100%",
                    overflowY: "auto",
                    overflowX: "hidden",
                    padding: "2px",
                  }}
                >
                  {value}
                </span>
              )}
              {col.lookupColumn !== undefined && (
                <FaSearch
                  onClick={() => {
                    console.log("FaSearch clicked:", {
                      dataId: row.id,
                      internalId: row._internalId,
                      column: col.name,
                    });
                    openLookup(row, col);
                  }}
                  style={{
                    cursor: "pointer",
                    marginLeft: "4px",
                    flexShrink: 0,
                    alignSelf: "flex-start",
                    marginTop: "2px",
                  }}
                />
              )}
            </div>
          );
        },

        renderEditCell:
          col.editable === false
            ? undefined
            : ({ row, onRowChange }) => {
                if (col.type === "select") {
                  let options = [];
                  if (col.dictionary) {
                    options = dictionaries[col.name]?.items || [];
                  } else if (col.display_element) {
                    // Extract options from display_element by calling it with possible values
                    const testValues = ["", "0", "0.5", "1", "ORIGINAL", "ADDED"];
                    options = testValues
                      .map((val) => {
                        const label = col.display_element(val);
                        return label ? { value: val, label } : null;
                      })
                      .filter(Boolean);
                    // Ensure unique options
                    options = Array.from(new Set(options.map(opt => opt.value)))
                      .map(val => ({
                        value: val,
                        label: col.display_element(val),
                      }));
                    console.log("Select options derived from display_element:", {
                      column: col.name,
                      options,
                    });
                  } else {
                    options = (col.options || ["", "0", "0.5", "1"]).map((opt) => ({
                      value: opt,
                      label: opt === "" ? "(null)" : opt,
                    }));
                  }
                  return (
                    <select
                      className="rdg-text-editor"
                      value={row[col.name] ?? ""}
                      onChange={(event) => {
                        console.log("Select changed:", {
                          dataId: row.id,
                          internalId: row._internalId,
                          field: col.name,
                          value: event.target.value,
                        });
                        onRowChange({ ...row, [col.name]: event.target.value }, true);
                      }}
                      onBlur={() => {
                        console.log("Select blurred:", {
                          dataId: row.id,
                          internalId: row._internalId,
                          field: col.name,
                        });
                        onRowChange({ ...row }, true);
                      }}
                      style={{
                        width: "100%",
                        height: "100%",
                        padding: "2px",
                        fontFamily: '"Courier New", monospace',
                        fontSize: "14px",
                      }}
                    >
                      {options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  );
                }
                if (col.type === "list") {
                  const currentValues = (row[col.name] || "").split(/[,;]/).map((p) => p.trim()).filter(Boolean);
                  const collection = dictionaries[col.name];
                  return (
                    <Select.Root
                      multiple
                      collection={collection}
                      value={currentValues}
                      onValueChange={(details) => {
                        const newValue = details.value.join(", ");
                        console.log("List select changed:", {
                          dataId: row.id,
                          internalId: row._internalId,
                          field: col.name,
                          value: newValue,
                        });
                        onRowChange({ ...row, [col.name]: newValue }, true);
                      }}
                      size="sm"
                    >
                      <Select.HiddenSelect />
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select options" />
                        </Select.Trigger>
                        <Select.IndicatorGroup>
                          <Select.Indicator />
                        </Select.IndicatorGroup>
                      </Select.Control>
                      <Portal>
                        <Select.Positioner>
                          <Select.Content minW="80">
                            {collection.items.map((item) => (
                              <Select.Item item={item} key={item.value}>
                                {item.label}
                                <Select.ItemIndicator />
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Portal>
                    </Select.Root>
                  );
                }
                if (col.type === "boolean") {
                  return (
                    <input
                      type="checkbox"
                      checked={!!row[col.name]}
                      onChange={(event) => {
                        console.log("Checkbox changed:", {
                          dataId: row.id,
                          internalId: row._internalId,
                          field: col.name,
                          value: event.target.checked,
                        });
                        onRowChange(
                          { ...row, [col.name]: event.target.checked },
                          true
                        );
                      }}
                      style={{ width: "100%", height: "100%", padding: "2px" }}
                    />
                  );
                }
                const isMultiline =
                  col.style?.wordWrap === "break-word" ||
                  col.style?.overflowWrap === "break-word";
                if (isMultiline) {
                  const text = row[col.name] ?? "";
                  console.log("Textarea rendered:", {
                    column: col.name,
                    textLength: text.length,
                    fontFamily: '"Courier New", monospace',
                    fontSize: "14px",
                    lineHeight: "22px",
                    height: "100%",
                    overflowY: "auto",
                  });
                  return (
                    <EditableTextarea
                      value={text}
                      onChange={(event) => {
                        console.log("Textarea changed:", {
                          dataId: row.id,
                          internalId: row._internalId,
                          field: col.name,
                          value: event.target.value,
                        });
                        onRowChange({ ...row, [col.name]: event.target.value });
                      }}
                      onBlur={() => {
                        console.log("Textarea blurred:", {
                          dataId: row.id,
                          internalId: row._internalId,
                          field: col.name,
                        });
                        onRowChange({ ...row }, true);
                      }}
                      rowId={row._internalId}
                      setSelection={setSelection}
                    />
                  );
                }
                return (
                  <Input
                    className="rdg-text-editor"
                    defaultValue={row[col.name] ?? ""}
                    onChange={(event) => {
                      console.log("Input changed:", {
                        dataId: row.id,
                        internalId: row._internalId,
                        field: col.name,
                        value: event.target.value,
                      });
                      onRowChange({ ...row, [col.name]: event.target.value });
                    }}
                    onBlur={() => {
                      console.log("Input blurred:", {
                        dataId: row.id,
                        internalId: row._internalId,
                        field: col.name,
                      });
                      onRowChange({ ...row }, true);
                    }}
                    ref={(input) => {
                      if (input) {
                        input.focus();
                      }
                    }}
                    style={{ width: "100%", height: "100%", padding: "2px" }}
                  />
                );
              },
      })),
    ];
  }, [
    tableStructure,
    visibleColumns,
    dictionaries,
    cellErrors,
    openLookup,
    setSelection,
  ]);

  useEffect(() => {
    const loadDictionaries = async () => {
      const newDictionaries = {};
      const dictionaryColumns = tableStructure.filter(
        (col) =>
          col.dictionary &&
          (col.type === "automatic" ||
            col.lookupColumn ||
            col.type === "select" ||
            col.type === "list") &&
          visibleColumns[col.name]
      );
      for (const col of dictionaryColumns) {
        if (dictionaryCache.current.has(col.dictionary)) {
          newDictionaries[col.name] = dictionaryCache.current.get(
            col.dictionary
          );
        } else {
          const response = await fetch(`/data/${col.dictionary}`);
          const csvText = await response.text();
          const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true }).data;
          const keyCol = col.dictionary_key_col || (col.type === "select" || col.type === "list" ? "name" : "id");
          const displayCol = col.dictionary_display_col || (col.type === "select" || col.type === "list" ? "name" : "text");
          const items = parsed
            .filter((row) => row[keyCol] && row[displayCol])
            .map((row) => ({
              value: row[keyCol],
              label: row[displayCol],
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
          const collection = createListCollection({ items });
          dictionaryCache.current.set(col.dictionary, collection);
          newDictionaries[col.name] = collection;
        }
      }
      setDictionaries(newDictionaries);
    };
    loadDictionaries();
  }, [tableStructure, visibleColumns]);

  useEffect(() => {
    if (isPostImport && validationErrors.length > 0) {
      const errorTrigger = errorDialogRef.current?.querySelector(
        "[data-part='trigger']"
      );
      if (errorTrigger) {
        errorTrigger.click();
      }
      setIsPostImport(false);
    }
  }, [validationErrors, isPostImport]);

  useEffect(() => {
    console.log("Lookup config updated:", {
      dataId: lookupConfig?.row?.id,
      internalId: lookupConfig?.row?._internalId,
      column: lookupConfig?.column?.name,
    });
  }, [lookupConfig]);

  useEffect(() => {
    console.log("DataTable rendered");
    const grid = document.querySelector(".rdg");
    console.log("DataGrid computed height:", grid?.offsetHeight);
  }, []);

  const selectItems = useMemo(() => {
    return tableStructure
      .filter(
        (col) =>
          col.lookupColumn &&
          tableStructure.some((c) => c.name === col.lookupColumn)
      )
      .map((col) => {
        const lookupCol = tableStructure.find(
          (c) => c.name === col.lookupColumn
        );
        return {
          label: `${col.display_name} based on ${
            lookupCol?.display_name || "Unknown"
          }`,
          value: col.name,
        };
      });
  }, [tableStructure]);

  const selectCollection = useMemo(() => {
    return createListCollection({
      items: selectItems,
    });
  }, [selectItems]);

  return (
    <VStack width="full" gap="5" alignItems="start">
      <HStack mb={2}>
        <Button onClick={handleSave} colorPalette="gray">
          <RiSave3Fill />
          Save JSON
        </Button>
        <Button onClick={handleCSVExport} colorPalette="gray">
          <RiSave3Fill />
          Export CSV
        </Button>
        <Dialog.Root
          placement="center"
          motionPreset="slide-in-bottom"
          unmountOnExit
          ref={csvDialogRef}
          onOpenChange={(e) => {
            if (!e.open) {
              setLoadingCSV(false);
              setCsvParseError(null);
              setIsPostImport(false);
              validateTable();
            }
          }}
        >
          <Dialog.Trigger asChild>
            <Button colorPalette="gray">
              <MdUploadFile />
              Import CSV
            </Button>
          </Dialog.Trigger>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Import CSV</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  {loadingCSV ? (
                    <VStack colorPalette="teal">
                      <Spinner color="colorPalette.600" />
                      <Text color="colorPalette.600">Loading...</Text>
                    </VStack>
                  ) : (
                    <>
                      <FileUpload.Root
                        maxW="xl"
                        alignItems="stretch"
                        accept={["text/csv"]}
                      >
                        <FileUpload.HiddenInput
                          onChange={(e) => handleCSVImport(e.target.files)}
                        />
                        <FileUpload.Dropzone>
                          <Icon size="md" color="fg.muted">
                            <LuUpload />
                          </Icon>
                          <FileUpload.DropzoneContent>
                            <div>Drag and drop CSV file here</div>
                            <div style={{ color: "#718096" }}>
                              .csv files only
                            </div>
                          </FileUpload.DropzoneContent>
                        </FileUpload.Dropzone>
                      </FileUpload.Root>
                      {csvParseError && (
                        <div style={{ marginTop: "16px", color: "red" }}>
                          <strong>Error:</strong> {csvParseError}
                        </div>
                      )}
                    </>
                  )}
                </Dialog.Body>
                {!loadingCSV && (
                  <Dialog.Footer>
                    <Dialog.ActionTrigger asChild>
                      <Button variant="outline">Cancel</Button>
                    </Dialog.ActionTrigger>
                  </Dialog.Footer>
                )}
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
        <Dialog.Root
          placement="center"
          motionPreset="slide-in-bottom"
          unmountOnExit
          onOpenChange={(e) => {
            if (e.open) {
              setAutoFillColumn(null);
              setReplaceExisting(false);
              setSimilarityThreshold(50);
              setUpdatedRows(0);
              setTotalRows(0);
              setAutoFillLoading(false);
            }
          }}
          ref={autoFillDialogRef}
        >
          <Dialog.Trigger asChild>
            <Button colorPalette="blue">
              <TbBadgesFilled />
              Automatic Fill
            </Button>
          </Dialog.Trigger>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content ref={autoFillContentRef}>
                <Dialog.Header>
                  <Dialog.Title>Automatic Fill</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  <VStack spacing={4} align="stretch">
                    <Text>Column to autofill:</Text>
                    <Select.Root
                      collection={selectCollection}
                      value={
                        autoFillColumn?.name ? [autoFillColumn.name] : ["Content Structure"]
                      }
                      onValueChange={(details) => {
                        const col = tableStructure.find(
                          (c) => c.name === details.value[0]
                        );
                        setAutoFillColumn(col || null);
                        console.log("Structure select changed:", {
                          selectedValue: details.value[0],
                          previousValue: autoFillColumn?.name,
                          columnDetails: col,
                        });
                      }}
                    >
                      <Select.HiddenSelect />
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Content Structure" />
                        </Select.Trigger>
                        <Select.IndicatorGroup>
                          <Select.Indicator />
                        </Select.IndicatorGroup>
                      </Select.Control>
                      <Portal container={autoFillContentRef}>
                        <Select.Positioner>
                          <Select.Content>
                            {selectItems.map((item) => (
                              <Select.Item item={item} key={item.value}>
                                {item.label}
                                <Select.ItemIndicator />
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Portal>
                    </Select.Root>
                    <Checkbox.Root
                      checked={replaceExisting}
                      onCheckedChange={(e) => setReplaceExisting(e.checked)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>Replace existing</Checkbox.Label>
                    </Checkbox.Root>
                    <NumberInput.Root
                      defaultValue={50}
                      min={0}
                      max={1}
                      step={0.05}
                      formatOptions={{ style: "percent" }}
                      onValueChange={(details) =>
                        setSimilarityThreshold(details.valueAsNumber)
                      }
                    >
                      <NumberInput.Label>
                        Similarity threshold
                      </NumberInput.Label>
                      <NumberInput.Control />
                      <NumberInput.Input />
                    </NumberInput.Root>
                    {(autoFillLoading || updatedRows != 0) && (
                      <Progress.Root
                        value={
                          autoFillLoading
                            ? (updatedRows / totalRows) * 100 || 0
                            : 100
                        }
                        maxW="sm"
                      >
                        <HStack gap="5">
                          <Progress.Label>Processing</Progress.Label>
                          <Progress.Track flex="1">
                            <Progress.Range />
                          </Progress.Track>
                          <Progress.ValueText>{`${updatedRows}/${totalRows} - ${changedRows} rows updated`}</Progress.ValueText>
                        </HStack>
                      </Progress.Root>
                    )}
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <Dialog.ActionTrigger asChild>
                    <Button variant="outline" disabled={autoFillLoading}>
                      Cancel
                    </Button>
                  </Dialog.ActionTrigger>
                  <Button
                    onClick={handleAutoFill}
                    disabled={!autoFillColumn || autoFillLoading}
                  >
                    Lookup All
                  </Button>
                </Dialog.Footer>
                <Dialog.CloseTrigger asChild disabled={autoFillLoading}>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
        <Dialog.Root
          placement="center"
          motionPreset="slide-in-bottom"
          unmountOnExit
        >
          <Dialog.Trigger asChild>
            <Button variant="outline">
              <MdVisibility />
              Show/Hide Columns
            </Button>
          </Dialog.Trigger>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Show/Hide Columns</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  <VStack align="start">
                    {tableStructure.map((col) => (
                      <label
                        key={col.name}
                        style={{ display: "flex", alignItems: "center" }}
                      >
                        <input
                          type="checkbox"
                          checked={visibleColumns[col.name]}
                          onChange={() => toggleColumnVisibility(col.name)}
                          style={{ marginRight: "8px" }}
                        />
                        {col.display_name}
                      </label>
                    ))}
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <Dialog.ActionTrigger asChild>
                    <Button variant="outline">Close</Button>
                  </Dialog.ActionTrigger>
                </Dialog.Footer>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>

        <Button onClick={validateTable} colorPalette="yellow">
          <GrValidate />
          Validate
        </Button>
        {validationErrors.length > 0 && (
          <Dialog.Root
            placement="center"
            motionPreset="slide-in-bottom"
            unmountOnExit
            ref={errorDialogRef}
          >
            <Dialog.Trigger asChild>
              <Button colorPalette="red">
                <BiSolidError />
                {validationErrors.length} Errors
              </Button>
            </Dialog.Trigger>
            <Portal>
              <Dialog.Backdrop />
              <Dialog.Positioner>
                <Dialog.Content>
                  <Dialog.Header>
                    <Dialog.Title>Validation Errors</Dialog.Title>
                  </Dialog.Header>
                  <Dialog.Body>
                    <div style={{ maxHeight: "200px", overflowY: "auto" }}>
                      <ul>
                        {validationErrors.map((error, index) => (
                          <li
                            key={index}
                            style={{ cursor: "pointer" }}
                            onClick={() => scrollToError(error)}
                          >
                            {error.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Dialog.Body>
                  <Dialog.Footer>
                    <Dialog.ActionTrigger asChild>
                      <Button variant="outline">Close</Button>
                    </Dialog.ActionTrigger>
                  </Dialog.Footer>
                  <Dialog.CloseTrigger asChild>
                    <CloseButton size="sm" />
                  </Dialog.CloseTrigger>
                </Dialog.Content>
              </Dialog.Positioner>
            </Portal>
          </Dialog.Root>
        )}
      </HStack>
      <div
        style={{
          height: "calc(100vh - 220px)",
          width: "100%",
          overflow: "auto",
        }}
      >
        <DataGrid
          ref={gridRef}
          columns={columns}
          rows={data}
          rowKeyGetter={rowKeyGetter}
          onRowsChange={onRowsChange}
          onFill={handleFill}
          selectedRows={selectedRows}
          onSelectedRowsChange={setSelectedRows}
          rowHeight={(row) =>
            getRowHeight(row, tableStructure, dictionaries)
          }
          headerRowHeight={40}
          className="fill-grid rdg-light"
          rowClass={(row) =>
            selectedRows.has(row._internalId) ? "selected-row" : ""
          }
          onCellClick={(args, event) => {
            event.stopPropagation();
            isClickingCell.current = true;
            console.log("Cell clicked:", {
              dataId: args.row.id,
              internalId: rowKeyGetter(args.row),
              column: args.column.key,
              rowIdx: args.rowIdx,
            });
            setTimeout(() => {
              if (gridRef.current) {
                gridRef.current.selectCell({
                  rowIdx: args.rowIdx,
                  idx: args.column.idx,
                });
                gridRef.current.scrollToCell({
                  rowIdx: args.rowIdx,
                  idx: args.column.idx,
                });
                const cellElement = document.querySelector(
                  `.rdg-cell[row-idx="${args.rowIdx}"][column-idx="${args.column.idx}"]`
                );
                if (cellElement) {
                  cellElement.focus();
                  console.log("Focused cell element:", {
                    rowIdx: args.rowIdx,
                    colIdx: args.column.idx,
                  });
                }
              }
              setSelectedCell({
                rowIdx: args.rowIdx,
                columnKey: args.column.key,
              });
              if (
                args.column.editable &&
                args.column.key !== SelectColumn.key
              ) {
                event.preventGridDefault();
                args.selectCell(true);
              }
              console.log("Selected cell:", {
                ".rowIdx": args.rowIdx,
                ".column.key": args.column.key,
                ".row.id": args.row.id,
                "rowKeyGetter(.row.id)": rowKeyGetter(args.row),
              });
              isClickingCell.current = false;
            }, 0);
          }}
          style={{ height: "100%" }}
          aria-label="Data Table"
        />
      </div>
      <ActionBar.Root open={selectedRows.size > 0}>
        <Portal>
          <ActionBar.Positioner sx={{ zIndex: 1000 }}>
            <ActionBar.Content>
              <div style={{ marginRight: "16px" }}>
                {selectedRows.size} selected
              </div>
              <Button
                onClick={handleInsertAbove}
                disabled={selectedRows.size !== 1}
                mr={2}
              >
                Insert new row above
              </Button>
              <Button
                onClick={handleInsertBelow}
                disabled={selectedRows.size !== 1}
                mr={2}
              >
                Insert new row below
              </Button>
              <Button
                onClick={handleMerge}
                disabled={selectedRows.size < 2}
                mr={2}
              >
                Merge <Kbd>M</Kbd>
              </Button>
              <Button onClick={handleDelete} mr={2} colorScheme="red">
                Delete <Kbd>Del</Kbd>
              </Button>
              <Button onClick={() => setSelectedRows(new Set())}>
                Deselect <Kbd>D</Kbd>
              </Button>
            </ActionBar.Content>
          </ActionBar.Positioner>
        </Portal>
      </ActionBar.Root>
      <ActionBar.Root open={!!selection?.text?.trim()}>
        <Portal>
          <ActionBar.Positioner sx={{ zIndex: 1000 }}>
            <ActionBar.Content>
              <Button onClick={handleSplit} data-testid="split-button">
                Split selection
              </Button>
            </ActionBar.Content>
          </ActionBar.Positioner>
        </Portal>
      </ActionBar.Root>
      {lookupConfig && (
        <DictionaryLookup
          isOpen={!!lookupConfig}
          onClose={closeLookup}
          row={lookupConfig.row}
          column={lookupConfig.column}
          updateCell={(rowId, columnName, value) => {
            const rowIndex = data.findIndex((r) => r._internalId === rowId);
            console.log("DictionaryLookup updating cell:", {
              dataId: data[rowIndex]?.id,
              internalId: rowId,
              rowIndex,
              columnName,
              value,
            });
            if (rowIndex === -1) {
              console.warn("Row not found for updateCell:", {
                rowId,
                columnName,
              });
              return;
            }
            const newData = [...data];
            newData[rowIndex] = {
              ...newData[rowIndex],
              [columnName]: value,
            };
            setData(newData);
            const rowErrors = validateRow(newData[rowIndex], rowIndex);
            const newCellErrors = new Map(cellErrors);
            tableStructure.forEach((col) => {
              const key = `${rowId}-${col.name}`;
              newCellErrors.delete(key);
            });
            rowErrors.forEach((error) => {
              const key = `${error.rowId}-${error.columnName}`;
              newCellErrors.set(key, error.message);
            });
            setCellErrors(newCellErrors);
            setValidationErrors((prev) =>
              prev.filter((e) => e.rowId !== rowId).concat(rowErrors)
            );
            console.log("Cell updated, validation run:", {
              rowId,
              columnName,
              newErrors: rowErrors.length,
              cellErrors: Array.from(newCellErrors.entries()),
            });
          }}
        />
      )}
    </VStack>
  );
};

export default DataTable;