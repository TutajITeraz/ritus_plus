// Row conversion between table structures (e.g. Cantus Index -> eCatalogus).
// Shared by the Converter dialog and by the Cantus import, so both produce the
// same rows. The mapping rules live in components/ConversionDescription.jsx.

import Papa from "papaparse";

// fetchMappingFile(path) -> Map(source -> target). The *promise* is cached, so
// the thousands of rows converted in parallel share one request per file
// (caching the result would let every row start its own fetch first). A failed
// fetch is not cached and is thrown: converting with an empty mapping would
// silently drop the mapped columns.
export const createMappingFetcher = () => {
  const cache = new Map();
  return (filePath) => {
    if (!cache.has(filePath)) {
      const request = (async () => {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`Failed to fetch mapping file: ${filePath}`);
        const parsed = Papa.parse(await response.text(), { header: true, skipEmptyLines: true }).data;
        return new Map(parsed.map((row) => [row.source, row.target]));
      })();
      request.catch(() => cache.delete(filePath));
      cache.set(filePath, request);
    }
    return cache.get(filePath);
  };
};

export const convertRows = async ({
  sourceRows,
  conversionMap,
  targetStructure,
  targetStructureName,
  fetchMappingFile,
  onProgress,
}) => {
  const newData = await Promise.all(
    sourceRows.map(async (sourceRow, index) => {
      const newRow = { _internalId: sourceRow._internalId || Date.now() + index };

      // Initialize target row with default values
      targetStructure.forEach((col) => {
        newRow[col.name] = col.value ?? "";
      });

      for (const [sourceField, mapping] of Object.entries(conversionMap)) {
        const targetField = Array.isArray(mapping[targetStructureName])
          ? mapping[targetStructureName]
          : [mapping[targetStructureName]];
        const value = sourceRow[sourceField];

        if (mapping.mappingFunction) {
          const result = mapping.mappingFunction(sourceRow);
          if (typeof result === "object") {
            Object.entries(result).forEach(([key, val]) => {
              newRow[key] = val;
            });
          } else {
            targetField.forEach((field) => {
              newRow[field] = result;
            });
          }
        } else if (mapping.mappingFile) {
          if (typeof mapping.mappingFile === "object") {
            // Multi-field mapping with selective mapping files
            await Promise.all(
              targetField.map(async (field) => {
                const filePath = mapping.mappingFile[field];
                if (filePath) {
                  const map = await fetchMappingFile(filePath);
                  const mappedValue = map.get(value) || "";
                  if (mappedValue && !newRow[field]) newRow[field] = mappedValue;
                } else if (value && !newRow[field]) {
                  newRow[field] = value;
                }
              })
            );
          } else {
            // Single mapping file for all target fields
            const map = await fetchMappingFile(mapping.mappingFile);
            targetField.forEach((field) => {
              const mappedValue = map.get(value) || "";
              if (mappedValue && !newRow[field]) newRow[field] = mappedValue;
            });
          }
        } else if (mapping[targetStructureName]) {
          targetField.forEach((field) => {
            if (value && !newRow[field]) newRow[field] = value;
          });
        }
      }

      const seqCol = targetStructure.find((col) => col.type === "sequence");
      if (seqCol) {
        newRow[seqCol.name] = sourceRow.sequence_in_ms || index + 1;
      }

      if (onProgress) onProgress(((index + 1) / sourceRows.length) * 100);
      return newRow;
    })
  );

  // Running sequence over the whole table
  const seqCol = targetStructure.find((col) => col.type === "sequence")?.name;
  if (seqCol) {
    newData.forEach((row, idx) => {
      row[seqCol] = idx + 1;
    });
  }
  return newData;
};
