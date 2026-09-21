// Character-level Levenshtein distance, single-row DP (O(n*m) time, O(min(n,m))
// space). Used only to label the "compare with automatic transcription"
// button - the actual side-by-side diff is rendered by levenshtein-diff.html.
export function levenshteinDistance(a, b) {
  const s1 = a || "";
  const s2 = b || "";
  if (s1 === s2) return 0;
  // Iterate over the shorter string so the row stays as small as possible.
  const [shorter, longer] = s1.length <= s2.length ? [s1, s2] : [s2, s1];
  if (shorter.length === 0) return longer.length;

  let previousRow = Array.from({ length: shorter.length + 1 }, (_, i) => i);
  for (let i = 1; i <= longer.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= shorter.length; j++) {
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          previousRow[j] + 1, // deletion
          currentRow[j - 1] + 1, // insertion
          previousRow[j - 1] + cost // substitution
        )
      );
    }
    previousRow = currentRow;
  }
  return previousRow[shorter.length];
}
