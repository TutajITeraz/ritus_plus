/*
TITLE: lookup.jsx
DESCRIPTION: Utility functions for text similarity calculations, including CSV parsing, reverse indexing, word matching, and Levenshtein distance. Used by DictionaryLookup and DataTable for lookup and autofill features.
DEPENDENCIES:
  - None
NOTES:
  - Extracted from DictionaryLookup.jsx for reusability.
  - Functions: parseCSV, createReverseIndex, countMatchingWords, levenshtein, calculateLevenshteinSimilarity.
  - Matching a typed/OCR'd text against thousands of dictionary entries runs in
    two stages, each using a different algorithm:

    STAGE 1 - Trigram + Sorensen-Dice prefilter (countMatchingWords):
    Every entry's text is chopped into overlapping 3-character chunks
    ("trigrams"), e.g. "salis" -> "sal", "ali", "lis". The query text is
    chopped the same way, and entries are scored by how many trigrams they
    share with the query, using the Sorensen-Dice formula:
        score = 2 * shared_trigrams / (query_trigrams + entry_trigrams)
    This score ranges 0 (nothing alike) to 1 (identical), and rewards entries
    that are similar relative to their own length, not just entries with the
    most raw matches. Because it compares small chunks instead of whole words,
    it still finds the right entry when OCR mangled a letter or a word ending
    changed (common in Latin). This stage is cheap, so it runs against every
    entry and keeps only the top N candidates.

    STAGE 2 - Levenshtein distance (levenshtein / calculateLevenshteinSimilarity):
    Levenshtein distance counts the minimum number of single-character edits
    (insertions, deletions, substitutions) needed to turn one string into the
    other - fewer edits means a closer match. It is exact and precise but too
    slow to run against every entry, so it only re-ranks the short list Stage
    1 already narrowed down, producing the final, most accurate ordering.

    Benchmarked against a full Levenshtein scan of formulas.csv (13k entries)
    and cantus_ids.csv (62k entries): index build ~0.3-0.8s, per-query
    prefilter ~10-30ms, vs. multi-second full scans.
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

// Builds the trigram index once so it can be reused across many
// countMatchingWords calls against the same entries (e.g. once per Automatic
// Fill batch, instead of once per row - rebuilding it per call cost
// 300-800ms on formulas.csv/cantus_ids.csv, dwarfing the matching itself).
export const buildLookupIndex = (entries) => {
  const { index, entryGramCount } = createReverseIndex(entries);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  return { index, entryGramCount, entriesById };
};

// Ranks candidates by Dice coefficient (2*matched / (queryLen + candidateLen))
// over shared character trigrams, so a short candidate with high relative
// overlap outranks a much longer one with more matches but low overlap, and
// OCR typos / inflectional endings (which break exact whole-word matching)
// still produce a meaningful similarity signal.
// Pass a prebuiltIndex (from buildLookupIndex) to skip rebuilding it on
// every call; otherwise one is built from entries as before.
export const countMatchingWords = (
  entries,
  textToFind,
  slice_results = 15,
  prebuiltIndex = null
) => {
  const { index, entryGramCount, entriesById } =
    prebuiltIndex || buildLookupIndex(entries);
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