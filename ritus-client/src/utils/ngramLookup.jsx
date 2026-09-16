/*
TITLE: ngramLookup.jsx
DESCRIPTION: "n-gram matcher" - word-n-gram text-reuse matching for looking up
  manuscript formulas in the reference corpus. Selectable alternative to the
  "legacy algorithm" (character-trigram Sorensen-Dice) in lookup.jsx.
DEPENDENCIES:
  - None
NOTES:
  Same two-stage shape as the legacy algorithm - a cheap prefilter narrows the
  corpus, then exact edit distance re-ranks the shortlist - but both stages are
  different:

  STAGE 1 - Word n-gram containment (buildNgramIndex / ngramCandidates):
  Entries are chopped into overlapping N-WORD chunks instead of 3-CHARACTER
  chunks, after a medieval-Latin-aware normalization pass (normalizeLatin).
  Candidates are scored by CONTAINMENT:
      containment = shared_ngrams / query_ngrams
  i.e. the fraction of the manuscript phrase's own n-grams found in the
  candidate. Containment is asymmetric on purpose: a reference formula much
  longer than the manuscript excerpt (a prayer quoted only in part, a responsory
  with its verse) is not penalised for its extra text - the case symmetric
  Sorensen-Dice handles badly.

  Both n=1 and n=2 are indexed (NGRAM_SIZES). n=2 supplies word-order evidence;
  n=1 keeps recall when OCR mangles a neighbouring word, which would otherwise
  break every bigram straddling it. Measured on Wr_Univ_I_F_366, n=[1,2] is what
  makes this stage match the legacy prefilter's accuracy exactly; n=[2] alone
  loses ~1.5 points, and passim's own n=10 default cannot match short incipits
  at all. Texts shorter than n words fall back to a single gram holding the
  whole phrase, so 3-word incipits still get indexed and queried.

  Grams occurring in more than MAX_GRAM_DF entries ("et", "deus", "domine") are
  skipped: they carry no discriminating power, and their posting lists are what
  made this stage slow. This is a pure speed measure - it was tuned to the
  largest value that costs nothing in accuracy.

  STAGE 2 - Bounded Levenshtein re-rank (rerankByLevenshtein):
  Containment is set overlap on EXACT n-grams, so alone it is blind to word
  order and fragile on short common phrases. The shortlist is therefore
  re-ranked by Levenshtein edit distance, which tolerates reordering and
  inflection. Because candidates arrive in containment order, a near-perfect
  match is usually scored first, and every later candidate only has to be
  checked against "can this possibly beat the best distance so far?" -
  boundedLevenshtein answers that with a banded DP that abandons a candidate as
  soon as it cannot. The result is identical to a full Levenshtein scan of the
  shortlist, just far cheaper.

  Distances are computed over NORMALIZED text (accents stripped, j->i, v->u,
  w->uu, ae/oe->e, punctuation and parentheticals dropped). In medieval Latin
  these are scribal/orthographic variants rather than real textual differences,
  so folding them makes the distance reflect actual divergence - and stops a
  correct match from being pushed under the similarity threshold by spelling
  alone.
USAGE:
  import { buildNgramIndex, ngramFindBestMatch } from "../utils/ngramLookup";
  const index = buildNgramIndex(entries);               // once per batch
  const best = ngramFindBestMatch(index, text, 60, cache); // per row
*/

// Word n-gram sizes indexed together. See the note above on why [1, 2].
export const NGRAM_SIZES = [1, 2];

// Skip n-grams that occur in more than this many entries - they cost a lot to
// probe and discriminate nothing. Tuned to the largest value with zero accuracy
// cost against an exhaustive Levenshtein scan of the whole corpus.
export const MAX_GRAM_DF = 2000;

const PAREN_RE = /\([^)]*\)/g;
const DIGIT_RE = /\d+/g;
const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;
const MARK_RE = /\p{M}+/gu;
const WS_RE = /\s+/g;

// Medieval-Latin-aware normalization, applied identically to corpus and query.
export const normalizeLatin = (text) => {
  if (!text) return "";
  return text
    .replace(PAREN_RE, " ")
    .normalize("NFKD")
    .replace(MARK_RE, "") // strip combining accents
    .toLowerCase()
    .replace(/j/g, "i")
    .replace(/v/g, "u")
    .replace(/w/g, "uu")
    .replace(/ae/g, "e")
    .replace(/oe/g, "e")
    .replace(DIGIT_RE, " ")
    .replace(PUNCT_RE, " ")
    .replace(WS_RE, " ")
    .trim();
};

// Grams are namespaced by size ("2|dominus uobiscum") so one flat index can
// hold several n at once without unigrams colliding with bigrams. Texts shorter
// than n words fall back to a single gram holding the whole phrase.
export const collectGrams = (tokens, sizes) => {
  const grams = new Set();
  if (!tokens.length) return grams;
  for (const n of sizes) {
    if (tokens.length < n) {
      grams.add(`${n}|${tokens.join(" ")}`);
      continue;
    }
    for (let i = 0; i + n <= tokens.length; i++) {
      grams.add(`${n}|${tokens.slice(i, i + n).join(" ")}`);
    }
  }
  return grams;
};

/*
 * Builds the inverted index (n-gram -> entry positions) once for a whole batch.
 * Entries are the parsed dictionary rows ({ id, text, ... }). Normalized text is
 * kept alongside so the re-rank stage never re-normalizes 13k entries per row.
 */
export const buildNgramIndex = (
  entries,
  sizes = NGRAM_SIZES,
  maxGramDf = MAX_GRAM_DF
) => {
  const index = new Map();
  const records = [];
  entries.forEach((entry) => {
    if (!entry || !entry.text) return;
    const norm = normalizeLatin(entry.text);
    if (!norm) return;
    const tokens = norm.split(" ");
    const position = records.length;
    records.push({ entry, norm, wordCount: tokens.length });
    collectGrams(tokens, sizes).forEach((gram) => {
      const posting = index.get(gram);
      if (posting) posting.push(position);
      else index.set(gram, [position]);
    });
  });
  return { index, records, sizes, maxGramDf };
};

// Shortlist size by query length, mirroring the legacy algorithm's own sizing:
// short queries are inherently ambiguous and need a wide pool, long ones rank
// the true match near the top so a narrow pool suffices.
export const ngramPoolSize = (length) =>
  length < 30 ? 500 : length < 60 ? 300 : length < 150 ? 60 : length < 300 ? 30 : 20;

/*
 * Stage 1: up to `limit` candidates ranked by containment.
 * Each candidate carries match_score (containment) and word_count (shared
 * n-grams), mirroring the shape countMatchingWords returns so callers can treat
 * both algorithms interchangeably. `norm` is attached for the re-rank stage.
 */
export const ngramCandidates = (ngramIndex, textToFind, limit) => {
  const { index, records, sizes, maxGramDf } = ngramIndex;
  const norm = normalizeLatin(textToFind);
  if (!norm) return [];
  const tokens = norm.split(" ");
  const queryGrams = collectGrams(tokens, sizes);
  if (!queryGrams.size) return [];

  const shared = new Map();
  // Grams skipped for being too common are excluded from the denominator too,
  // so containment stays the fraction of ACTUALLY DISCRIMINATING grams matched.
  let denominator = 0;
  queryGrams.forEach((gram) => {
    const posting = index.get(gram);
    if (!posting) {
      denominator++; // a gram nothing in the corpus has still counts against us
      return;
    }
    if (posting.length > maxGramDf) return;
    denominator++;
    for (let i = 0; i < posting.length; i++) {
      const position = posting[i];
      shared.set(position, (shared.get(position) || 0) + 1);
    }
  });
  if (!shared.size || !denominator) return [];

  const queryWordCount = tokens.length;
  const scored = [];
  shared.forEach((sharedCount, position) => {
    const record = records[position];
    scored.push({
      ...record.entry,
      norm: record.norm,
      word_count: sharedCount,
      match_score: sharedCount / denominator,
      // Tie-break on length proximity: among candidates containing the same
      // share of the query, the one closest in length is the likelier source.
      lengthDiff: Math.abs(record.wordCount - queryWordCount),
    });
  });

  scored.sort(
    (a, b) =>
      b.match_score - a.match_score ||
      b.word_count - a.word_count ||
      a.lengthDiff - b.lengthDiff
  );
  return scored.slice(0, limit ?? ngramPoolSize(norm.length));
};

/*
 * Exact Levenshtein distance, abandoned early once it provably exceeds maxDist.
 * Returns the true distance when it is <= maxDist, otherwise maxDist + 1.
 *
 * Only cells within maxDist of the diagonal can lie on a path cheaper than
 * maxDist, so the inner loop walks a band of width 2*maxDist+1 instead of the
 * full row - O(maxDist * len) rather than O(len^2). When an entire row of the
 * band is already over budget, no continuation can come back under it, so the
 * candidate is abandoned outright.
 */
export const boundedLevenshtein = (a, b, maxDist) => {
  const la = a.length;
  const lb = b.length;
  const over = maxDist + 1;
  if (maxDist < 0) return over;
  if (Math.abs(la - lb) > maxDist) return over; // length gap alone exceeds budget
  if (la === 0) return lb <= maxDist ? lb : over;
  if (lb === 0) return la <= maxDist ? la : over;

  let prev = new Int32Array(lb + 2);
  let cur = new Int32Array(lb + 2);
  for (let j = 0; j <= lb; j++) prev[j] = j <= maxDist ? j : over;
  prev[lb + 1] = over;

  for (let i = 1; i <= la; i++) {
    const lo = Math.max(1, i - maxDist);
    const hi = Math.min(lb, i + maxDist);
    cur[0] = i <= maxDist ? i : over;
    if (lo > 1) cur[lo - 1] = over; // left of the band: unreachable within budget
    const ac = a.charCodeAt(i - 1);
    let rowMin = over;
    for (let j = lo; j <= hi; j++) {
      const substitute = prev[j - 1] + (ac === b.charCodeAt(j - 1) ? 0 : 1);
      const remove = prev[j] + 1;
      const insert = cur[j - 1] + 1;
      let value = substitute < remove ? substitute : remove;
      if (insert < value) value = insert;
      if (value > over) value = over;
      cur[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (hi < lb) cur[hi + 1] = over; // right of the band
    if (rowMin > maxDist) return over; // whole band over budget - give up
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const distance = prev[lb];
  return distance > maxDist ? over : distance;
};

const similarityOf = (distance, queryNorm, candidateNorm) => {
  const maxLength = Math.max(queryNorm.length, candidateNorm.length);
  return maxLength ? ((maxLength - distance) / maxLength) * 100 : 100;
};

/*
 * Stage 2 (single best): walks the containment shortlist keeping the smallest
 * edit distance seen, and only ever asks later candidates whether they can beat
 * it. Identical result to scoring every candidate in full.
 * Returns { ...entry, levenstein, similarity } or null.
 */
export const ngramFindBestMatch = (ngramIndex, textToFind, limit, cache) => {
  const candidates = ngramCandidates(ngramIndex, textToFind, limit);
  if (!candidates.length) return null;
  const queryNorm = normalizeLatin(textToFind);

  let best = null;
  let bestDistance = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const candidateNorm = candidate.norm ?? normalizeLatin(candidate.text);
    const cacheKey = cache ? `${queryNorm}||${candidateNorm}` : null;

    let distance;
    if (cacheKey !== null && cache.has(cacheKey)) {
      distance = cache.get(cacheKey);
    } else {
      // Budget: strictly better than the best so far. On the first candidate
      // there is no bound yet, so the worst possible distance is used.
      const budget =
        bestDistance === Infinity
          ? Math.max(queryNorm.length, candidateNorm.length)
          : bestDistance - 1;
      distance = boundedLevenshtein(queryNorm, candidateNorm, budget);
      // Only cache exact values - a result at budget+1 is "at least this", not
      // the true distance, and would poison a later comparison.
      if (cacheKey !== null && distance <= budget) cache.set(cacheKey, distance);
    }

    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      best.levenstein = distance;
      best.similarity = similarityOf(distance, queryNorm, candidateNorm);
      if (distance === 0) break; // cannot do better than identical
    }
  }
  return best;
};

/*
 * Stage 2 (full list): scores the whole shortlist and returns it sorted
 * best-first, each match carrying `levenstein` and `similarity`. Used where the
 * caller shows a ranked list of alternatives rather than taking a single pick.
 */
export const rerankByLevenshtein = (matches, textToFind, cache) => {
  const queryNorm = normalizeLatin(textToFind);
  matches.forEach((match) => {
    const candidateNorm = match.norm ?? normalizeLatin(match.text);
    const cacheKey = cache ? `${queryNorm}||${candidateNorm}` : null;
    let distance;
    if (cacheKey !== null && cache.has(cacheKey)) {
      distance = cache.get(cacheKey);
    } else {
      distance = boundedLevenshtein(
        queryNorm,
        candidateNorm,
        Math.max(queryNorm.length, candidateNorm.length)
      );
      if (cacheKey !== null) cache.set(cacheKey, distance);
    }
    match.levenstein = distance;
    match.similarity = similarityOf(distance, queryNorm, candidateNorm);
  });
  return matches.sort((a, b) => a.levenstein - b.levenstein);
};

/*
 * Convenience wrapper running both stages and returning the ranked shortlist.
 */
export const ngramFindMatches = (ngramIndex, textToFind, limit, cache) => {
  const candidates = ngramCandidates(ngramIndex, textToFind, limit);
  if (!candidates.length) return [];
  return rerankByLevenshtein(candidates, textToFind, cache);
};
