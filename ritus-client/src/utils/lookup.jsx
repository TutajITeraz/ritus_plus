/*
TITLE: lookup.jsx
DESCRIPTION: Utility functions for text similarity calculations, including CSV parsing, reverse indexing, word matching, and Levenshtein distance. Used by DictionaryLookup and DataTable for lookup and autofill features.
DEPENDENCIES:
  - None
NOTES:
  - Extracted from DictionaryLookup.jsx for reusability.
  - Functions: parseCSV, createReverseIndex, countMatchingWords, levenshtein, calculateLevenshteinSimilarity.
USAGE:
  import { parseCSV, levenshtein } from "../utils/lookup";
*/
export const parseCSV = (csvText) => {
  csvText = csvText.toLowerCase();
  const lines = csvText.trim().split("\n");
  // Autodetect delimiter: comma or tab
  const headerLine = lines[0];
  const commaCount = (headerLine.match(/,/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const delimiter = tabCount > commaCount ? "\t" : ",";

  const headers = headerLine
    .split(delimiter)
    .map((header) => header.replace(/^"(.*)"$/, "$1").trim());

  // Build regex for matching values (handles quoted values)
  const valueRegex =
    delimiter === ","
      ? /(".*?"|[^",\s]+)(?=\s*,|\s*$)/g
      : /(".*?"|[^"\t\s]+)(?=\s*\t|\s*$)/g;

  const data = lines.slice(1).map((line) => {
    const values =
      line
        .match(valueRegex)
        ?.map((value) =>
          typeof value === "string"
            ? value.replace(/^"(.*)"$/, "$1").trim()
            : ""
        ) || [];
    return headers.reduce((obj, header, index) => {
      obj[header] = values[index] || "";
      return obj;
    }, {});
  });
  return data;
};

export const createReverseIndex = (entries) => {
  const index = {};
  entries.forEach((entry) => {
    if (entry.text) {
      const words = entry.text.split(/\s+/).filter((word) => word.length >= 3);
      words.forEach((word) => {
        if (!index[word]) {
          index[word] = [];
        }
        index[word].push(entry.id);
      });
    }
  });
  return index;
};

export const countMatchingWords = (entries, textToFind, slice_results = 15) => {
  const index = createReverseIndex(entries);
  const wordsToFind = textToFind
    .split(/\s+/)
    .filter((word) => word.length >= 3);
  const wordCountMap = {};

  let two_words_found_at_least_one_time = false;

  wordsToFind.forEach((word) => {
    if (index[word]) {
      const entriesIncluding = index[word];
      entriesIncluding.forEach((entryId) => {
        if (!wordCountMap[entryId]) {
          wordCountMap[entryId] = 1;
        } else {
          wordCountMap[entryId]++;
          two_words_found_at_least_one_time = true;
        }
      });
    }
  });

  //We will analyze all texts - they have same possibility to match with levenshtein
  if (!two_words_found_at_least_one_time) {
    for (let entryId in entries) {
      if (!wordCountMap[entryId]) {
        wordCountMap[entryId] = 0;
      }
    }
  }

  const wordCountEntries = {};
  Object.keys(wordCountMap).forEach((entryId) => {
    const entry = entries.find((e) => e.id === entryId);
    if (entry) {
      wordCountEntries[entryId] = {
        ...entry,
        word_count: wordCountMap[entryId],
      };
    }
  });

  const sortedResults = Object.values(wordCountEntries).sort(
    (a, b) => b.word_count - a.word_count
  );
  return sortedResults.slice(0, slice_results);
};

export const levenshtein = (a, b) => {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
};

export const calculateLevenshteinSimilarity = (matches, textToFind, cache) => {
  matches.forEach((match) => {
    const cacheKey = `${textToFind}||${match.text}`;
    if (cache.has(cacheKey)) {
      match.levenstein = cache.get(cacheKey);
    } else {
      match.levenstein = levenshtein(textToFind, match.text);
      cache.set(cacheKey, match.levenstein);
    }
  });
  return matches.sort((a, b) => a.levenstein - b.levenstein);
};