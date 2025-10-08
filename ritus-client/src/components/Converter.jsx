import React, { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  Portal,
  Button,
  CloseButton,
  NumberInput,
  Progress,
  VStack,
  Text,
} from "@chakra-ui/react";
import Papa from "papaparse";
import { toaster } from "@/components/ui/toaster";
import {
  ContentStructure_conv,
  UsuariumStructure_conv,
} from "./ConversionDescription";

const Converter = ({
  open,
  onClose,
  sourceStructure,
  targetStructure,
  sourceData,
  setData,
  sourceStructureKey,
  targetStructureKey,
  setStructureKey,
}) => {
  const [similarityThreshold, setSimilarityThreshold] = useState(75);
  const [isConverting, setIsConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [mappingCache, setMappingCache] = useState(new Map());

  const conversionMap =
    sourceStructureKey === "content"
      ? ContentStructure_conv
      : UsuariumStructure_conv;
  const targetStructureName =
    targetStructureKey === "content" ? "ContentStructure" : "UsuariumStructure";

  const fetchMappingFile = useCallback(async (filePath) => {
    if (mappingCache.has(filePath)) {
      return mappingCache.get(filePath);
    }
    try {
      const response = await fetch(`/${filePath}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch mapping file: ${filePath}`);
      }
      const text = await response.text();
      const parsed = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
      }).data;
      const mapping = new Map(
        parsed.map((row) => [row.source, row.target])
      );
      setMappingCache((prev) => new Map(prev).set(filePath, mapping));
      console.log(`Fetched mapping file ${filePath}:`, mapping);
      return mapping;
    } catch (error) {
      console.error(`Error fetching mapping file ${filePath}:`, error);
      return new Map();
    }
  }, [mappingCache]);

  const convertData = useCallback(async () => {
    setIsConverting(true);
    setProgress(0);
    try {
      const newData = await Promise.all(
        sourceData.map(async (sourceRow, index) => {
          console.log(`Converting row ${index + 1}:`, sourceRow);
          const newRow = { _internalId: sourceRow._internalId || Date.now() + index };
          
          // Initialize target row with default values
          targetStructure.forEach((col) => {
            newRow[col.name] = col.value ?? "";
          });

          // Process each mapping
          for (const [sourceField, mapping] of Object.entries(conversionMap)) {
            const targetField = Array.isArray(mapping[targetStructureName])
              ? mapping[targetStructureName]
              : [mapping[targetStructureName]];
            const value = sourceRow[sourceField];

            console.log(`Mapping ${sourceField} to ${targetField.join(", ")}:`, { value });

            if (mapping.mappingFunction) {
              const result = mapping.mappingFunction(sourceRow);
              console.log(`Applied mapping function for ${sourceField}:`, result);
              if (typeof result === "object") {
                Object.entries(result).forEach(([key, val]) => {
                  newRow[key] = val;
                  console.log(`Set ${key} = ${val}`);
                });
              } else {
                targetField.forEach((field) => {
                  newRow[field] = result;
                  console.log(`Set ${field} = ${result}`);
                });
              }
            } else if (mapping.mappingFile) {
              if (typeof mapping.mappingFile === "object") {
                for (const [field, filePath] of Object.entries(mapping.mappingFile)) {
                  const map = await fetchMappingFile(filePath);
                  const mappedValue = map.get(value) || "";
                  newRow[field] = mappedValue;
                  console.log(`Mapped ${sourceField} to ${field} using file ${filePath}: ${mappedValue}`);
                }
              } else {
                const map = await fetchMappingFile(mapping.mappingFile);
                targetField.forEach((field) => {
                  const mappedValue = map.get(value) || "";
                  newRow[field] = mappedValue;
                  console.log(`Mapped ${sourceField} to ${field} using file: ${mappedValue}`);
                });
              }
            } else if (mapping[targetStructureName]) {
              console.log(`Direct mapping ${sourceField} to ${targetField.join(", ")}: ${value ?? ""}`);
              targetField.forEach((field) => {
                newRow[field] = value ?? "";
              });
            } else {
              console.log(`No action for mapping ${sourceField}`);
            }
          }

          // Handle sequence column
          const seqCol = targetStructure.find((col) => col.type === "sequence");
          if (seqCol) {
            newRow[seqCol.name] = sourceRow.sequence_in_ms || index + 1;
            console.log(`Set sequence column ${seqCol.name} = ${newRow[seqCol.name]}`);
          }

          setProgress(((index + 1) / sourceData.length) * 100);
          console.log(`Converted row ${index + 1}:`, newRow);
          return newRow;
        })
      );

      // Update sequences
      const seqCol = targetStructure.find((col) => col.type === "sequence")?.name;
      if (seqCol) {
        newData.forEach((row, idx) => {
          row[seqCol] = idx + 1;
          console.log(`Updated sequence for row ${idx + 1}: ${seqCol} = ${idx + 1}`);
        });
      }

      console.log("Final converted data:", newData);
      setData(newData);
      setStructureKey(targetStructureKey);
      toaster.create({
        title: "Success",
        description: `Data converted to ${targetStructureName}`,
        type: "success",
        duration: 3000,
      });
    } catch (error) {
      console.error("Conversion failed:", error);
      toaster.create({
        title: "Error",
        description: error.message || "Failed to convert data",
        type: "error",
        duration: 3000,
      });
    } finally {
      setIsConverting(false);
      onClose();
    }
  }, [
    sourceData,
    targetStructure,
    sourceStructureKey,
    targetStructureKey,
    conversionMap,
    fetchMappingFile,
    setData,
    setStructureKey,
    targetStructureName,
  ]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !isConverting && onClose()}
      placement="center"
      motionPreset="slide-in-bottom"
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Convert to {targetStructureName}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack spacing={4} align="stretch">
                <Text>Similarity Threshold for mappings (if applicable)</Text>
                <NumberInput.Root
                  defaultValue={75}
                  step={0.01}
                  min={0}
                  max={1}
                  disabled={isConverting}
                  onValueChange={(details) =>
                    setSimilarityThreshold(details.valueAsNumber)
                  }
                  formatOptions={{
                    style: "percent",
                  }}
                >
                  <NumberInput.Control />
                  <NumberInput.Input />
                </NumberInput.Root>
                {isConverting && (
                  <Progress.Root
                    value={progress}
                    maxW="sm"
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: "20px",
                    }}
                  >
                    <Progress.Label>Converting</Progress.Label>
                    <Progress.Track flex="1">
                      <Progress.Range />
                    </Progress.Track>
                    <Progress.ValueText>{Math.round(progress)}%</Progress.ValueText>
                  </Progress.Root>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline" disabled={isConverting}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button
                colorScheme="blue"
                onClick={convertData}
                disabled={isConverting}
              >
                Convert
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" disabled={isConverting} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default Converter;