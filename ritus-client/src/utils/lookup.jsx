/*
TITLE: lookup.jsx
DESCRIPTION: Utility functions for text similarity calculations, including CSV parsing, reverse indexing, word matching, and Levenshtein distance. Used by DictionaryLookup and DataTable for lookup and autofill features.
DEPENDENCIES:
  - None
NOTES:
  - Extracted from DictionaryLookup.jsx for reusability.
  - Functions: parseCSV, createReverseIndex, countMatchingWords, levenshtein, calculateLevenshteinSimilarity.
  - countMatchingWords indexes/matches on character trigrams (not whole words) and
    ranks candidates by Dice coefficient (match_score = 2*matched / (queryLen +
    candidateLen)). Trigrams make the prefilter tolerant of OCR typos and Latin
    inflectional endings that would break exact whole-word matching, while the
    Dice score keeps overlap judged relative to both text lengths rather than
    raw match count. Benchmarked against a full Levenshtein scan of formulas.csv
    (13k entries) and cantus_ids.csv (62k entries): index build ~0.3-0.8s,
    per-query prefilter ~10-30ms, vs. multi-second full scans.
USAGE:
  import { parseCSV, levenshtein } from "../utils/lookup";
*/

const N_GRAM_SIZE = 3;

const generateNGrams = (text) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const grams = new Set();
  for (let i = 0; i <= normalized.length - N_GRAM_SIZE; i++) {
    grams.add(normalized.slice(i, i + N_GRAM_SIZE));
  }
  return grams;
};
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
  const entryGramCount = {};
  entries.forEach((entry) => {
    if (entry.text) {
      const grams = generateNGrams(entry.text);
      entryGramCount[entry.id] = grams.size;
      grams.forEach((gram) => {
        if (!index[gram]) {
          index[gram] = [];
        }
        index[gram].push(entry.id);
      });
    }
  });
  return { index, entryGramCount };
};

// Ranks candidates by Dice coefficient (2*matched / (queryLen + candidateLen))
// over shared character trigrams, so a short candidate with high relative
// overlap outranks a much longer one with more matches but low overlap, and
// OCR typos / inflectional endings (which break exact whole-word matching)
// still produce a meaningful similarity signal.
export const countMatchingWords = (entries, textToFind, slice_results = 15) => {
  const { index, entryGramCount } = createReverseIndex(entries);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const queryGrams = generateNGrams(textToFind);
  const matchCountMap = {};

  queryGrams.forEach((gram) => {
    const entriesIncluding = index[gram];
    if (entriesIncluding) {
      entriesIncluding.forEach((entryId) => {
        matchCountMap[entryId] = (matchCountMap[entryId] || 0) + 1;
      });
    }
  });

  // No trigram matched anything (e.g. near-empty text) - let every entry
  // through so Levenshtein still gets a chance to find the closest text.
  const noOverlap = Object.keys(matchCountMap).length === 0;
  if (noOverlap) {
    entries.forEach((entry) => {
      matchCountMap[entry.id] = 0;
    });
  }

  const scoredResults = Object.keys(matchCountMap)
    .map((entryId) => {
      const entry = entriesById.get(entryId);
      if (!entry) return null;
      const matched = matchCountMap[entryId];
      const candidateLen = entryGramCount[entryId] || 0;
      const denom = queryGrams.size + candidateLen;
      const match_score = denom > 0 ? (2 * matched) / denom : 0;
      return {
        ...entry,
        word_count: matched,
        match_score,
      };
    })
    .filter(Boolean);

  scoredResults.sort(
    (a, b) => b.match_score - a.match_score || b.word_count - a.word_count
  );

  // When nothing matched at all, match_score can't rank anything
  // meaningfully - slicing here would hand Levenshtein an arbitrary subset
  // instead of the full dictionary, hiding the real best match.
  return noOverlap ? scoredResults : scoredResults.slice(0, slice_results);
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