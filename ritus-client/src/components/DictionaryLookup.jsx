/*
TITLE: DictionaryLookup.jsx
DESCRIPTION: A modal component for looking up dictionary entries using Levenshtein similarity, with a textarea for input, a Find Text button with spinner, a scrollable table with checkbox selection and multiline word wrap for all columns, and a spinner during lookup. Allows selecting a result to update the main DataTable.
DEPENDENCIES:
  - @chakra-ui/react: ^3.14.2
  - ../utils/lookup.jsx: for similarity functions
NOTES:
  - Displays a textarea initialized with text from the lookupColumn.
  - Includes a Find Text button with loading spinner (loadingText="Searching...").
  - Performs automatic lookup with spinner if textarea has a default value.
  - Shows a spinner during lookup operations.
  - Limits to top 15 matches, sorted by word count and Levenshtein distance, in a scrollable table (maxH="400px") with multiline word wrap on all columns.
  - Adds a checkbox column for selection, with the best match checked by default.
  - Uses unmountOnExit, restoreFocus, and onExitComplete to prevent pointer-events issues.
  - Ensures formula_id is saved as a number using row._internalId.
  - Added multiline word wrap to ID, Similar Words, and Levenshtein Similarity columns.
  - Limited Text column to maxWidth: "200px" with dynamic row height based on content.
  - Includes Dialog.CloseTrigger with CloseButton for proper dialog closure.
USAGE:
  <DictionaryLookup
    isOpen={true}
    onClose={() => setIsOpen(false)}
    row={rowData}
    column={columnConfig}
    updateCell={(rowId, columnName, value) => updateCell(rowId, columnName, value)}
  />
*/
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Dialog,
  Portal,
  Textarea,
  Table,
  Button,
  VStack,
  CloseButton,
  Checkbox,
  Spinner,
  Text,
} from "@chakra-ui/react";
import {
  parseCSV,
  countMatchingWords,
  calculateLevenshteinSimilarity,
} from "../utils/lookup";

// Debounce utility
const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

// Calculate row height based on Text column content
const getRowHeight = (text) => {
  const maxWidth = 200; // Text column maxWidth
  const charsPerLine = 30; // Approx characters per line at 200px
  const lineHeight = 20; // Height per line
  const padding = 10; // Padding for cell
  const minHeight = 30; // Minimum height

  if (!text) return minHeight;

  const lineCount = Math.max(
    1,
    Math.ceil(text.length / charsPerLine) +
      (text.includes("\n") ? text.split("\n").length - 1 : 0)
  );
  return Math.max(lineCount * lineHeight + padding, minHeight);
};

// Memoized LookupRow component
const LookupRow = React.memo(
  ({ match, selectedEntry, handleCheckboxChange }) => (
    <Table.Row
      sx={{
        bg: selectedEntry?.id === match.id ? "blue.100" : "inherit",
        _hover: { bg: "gray.100" },
        height: `${getRowHeight(match.text)}px`,
      }}
    >
      <Table.Cell width="50px">
        <Checkbox.Root
          size="sm"
          checked={selectedEntry?.id === match.id}
          onCheckedChange={() => handleCheckboxChange(match)}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
        </Checkbox.Root>
      </Table.Cell>
      <Table.Cell
        whiteSpace="normal"
        overflowWrap="break-word"
        maxWidth="80px"
        minHeight="30px"
      >
        {match.id}
      </Table.Cell>
      <Table.Cell
        whiteSpace="normal"
        overflowWrap="break-word"
        maxWidth="300px"
        minHeight="30px"
      >
        {match.text}
      </Table.Cell>
      <Table.Cell
        whiteSpace="normal"
        overflowWrap="break-word"
        maxWidth="100px"
        minHeight="30px"
      >
        {match.word_count}
      </Table.Cell>
      <Table.Cell
        whiteSpace="normal"
        overflowWrap="break-word"
        maxWidth="100px"
        minHeight="30px"
      >
        {match.levenstein}
      </Table.Cell>
    </Table.Row>
  ),
  (prevProps, nextProps) =>
    prevProps.match.id === nextProps.match.id &&
    prevProps.match.text === nextProps.match.text &&
    prevProps.match.word_count === nextProps.match.word_count &&
    prevProps.match.levenstein === nextProps.match.levenstein &&
    prevProps.selectedEntry?.id === nextProps.selectedEntry?.id
);

const DictionaryLookup = ({ isOpen, onClose, row, column, updateCell }) => {
  const [lookupText, setLookupText] = useState(
    column.lookupColumn ? row[column.lookupColumn] || "" : ""
  );
  const [entries, setEntries] = useState([]);
  const [matches, setMatches] = useState([]);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [performLookup, setPerformLookup] = useState(
    !!(column.lookupColumn && row[column.lookupColumn])
  );
  const [loadingLookup, setLoadingLookup] = useState(false);
  const levenshteinCache = useMemo(() => new Map(), []);

  // Load dictionary CSV
  useEffect(() => {
    const loadDictionary = async () => {
      try {
        const response = await fetch(`/data/${column.dictionary}`);
        if (!response.ok) {
          throw new Error(`Failed to load CSV: ${response.statusText}`);
        }
        const csvText = await response.text();
        const parsedEntries = parseCSV(csvText);
        setEntries(parsedEntries);
      } catch (error) {
        console.error("Error loading dictionary CSV:", error);
      }
    };
    if (column.dictionary) {
      loadDictionary();
    }
  }, [column.dictionary]);

  // Memoized lookup calculation
  const performSearch = useCallback(
    (text, entries) => {
      if (!text || entries.length === 0) {
        setMatches([]);
        setSelectedEntry(null);
        setLoadingLookup(false);
        return;
      }
      setLoadingLookup(true);

      const how_many_matches = text.length < 60 ? 9999 : 15;
      const wordMatches = countMatchingWords(
        entries,
        text.toLowerCase(),
        how_many_matches
      );
      const bestMatches = calculateLevenshteinSimilarity(
        wordMatches,
        text.toLowerCase(),
        levenshteinCache
      );
      setMatches(bestMatches);
      if (bestMatches.length > 0 && !selectedEntry) {
        setSelectedEntry(bestMatches[0]);
      }
      setLoadingLookup(false);
    },
    [selectedEntry, levenshteinCache]
  );

  // Debounced lookup
  const debouncedSearch = useMemo(
    () => debounce((text, entries) => performSearch(text, entries), 300),
    [performSearch]
  );

  // Perform lookup when performLookup is true
  useEffect(() => {
    if (performLookup) {
      debouncedSearch(lookupText, entries);
    }
  }, [lookupText, entries, performLookup, debouncedSearch]);

  // Cleanup pointer-events on unmount
  useEffect(() => {
    return () => {
      document.body.style.pointerEvents = "auto";
    };
  }, []);

  const handleFindText = () => {
    setPerformLookup(true);
  };

  const handleSave = () => {
    if (selectedEntry) {
      console.log("Saving formula_id:", selectedEntry.id, "for row:", {
        dataId: row.id,
        internalId: row._internalId,
      });
      updateCell(row._internalId, column.name, Number(selectedEntry.id));
    } else {
      console.warn("No selected entry to save");
    }
    onClose();
  };

  const handleCheckboxChange = useCallback((entry) => {
    setSelectedEntry(entry);
  }, []);

  return (
    <Dialog.Root
      open={isOpen}
      unmountOnExit
      restoreFocus
      onExitComplete={() => {
        onClose();
        document.body.style.pointerEvents = "auto";
      }}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="1800px">
            <Dialog.Header>
              <Dialog.Title>Dictionary Lookup</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack spacing={4} align="stretch">
                <Textarea
                  size="md"
                  placeholder="Enter text to search"
                  value={lookupText}
                  onChange={(e) => {
                    setLookupText(e.target.value);
                    setPerformLookup(false);
                  }}
                />
                <Button
                  onClick={handleFindText}
                  loading={loadingLookup && performLookup}
                  loadingText="Searching..."
                >
                  Find Text
                </Button>
                {loadingLookup && performLookup ? (
                  <VStack colorPalette="teal">
                    <Spinner color="colorPalette.600" />
                    <Text color="colorPalette.600">Loading...</Text>
                  </VStack>
                ) : (
                  <Table.ScrollArea maxH="400px">
                    <Table.Root size="sm" variant="outline" stickyHeader>
                      <Table.ColumnGroup>
                        <Table.Column htmlWidth="10%" />
                        <Table.Column htmlWidth="10%" />
                        <Table.Column
                          htmlWidth="200"
                          wordBreak="break-word"
                          maxWidth="200px"
                          whiteSpace="normal"
                          minHeight="30px"
                        />
                        <Table.Column htmlWidth="10%" />
                        <Table.Column htmlWidth="10%" />
                      </Table.ColumnGroup>

                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader>Select</Table.ColumnHeader>
                          <Table.ColumnHeader>ID</Table.ColumnHeader>
                          <Table.ColumnHeader>Text</Table.ColumnHeader>
                          <Table.ColumnHeader>Similar Words</Table.ColumnHeader>
                          <Table.ColumnHeader>
                            Levenshtein Similarity
                          </Table.ColumnHeader>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {matches.slice(0, 15).map((match) => (
                          <LookupRow
                            key={match.id}
                            match={match}
                            selectedEntry={selectedEntry}
                            handleCheckboxChange={handleCheckboxChange}
                          />
                        ))}
                      </Table.Body>
                    </Table.Root>
                  </Table.ScrollArea>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorScheme="blue"
                onClick={handleSave}
                isDisabled={!selectedEntry}
              >
                Save
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" onClick={onClose} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default DictionaryLookup;
