import React, { useState, useCallback, useRef } from "react";
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
import { toaster } from "@/components/ui/toaster";
import {
  ContentStructure_conv,
  UsuariumStructure_conv,
  CantusStructure_conv,
} from "./ConversionDescription";
import { sortCantusRows } from "../utils/cantusSequence";
import { convertRows, createMappingFetcher } from "../utils/convertRows";

const CONVERSION_MAPS = {
  content: ContentStructure_conv,
  usuarium: UsuariumStructure_conv,
  cantus: CantusStructure_conv,
};

const STRUCTURE_NAMES = {
  content: "ContentStructure",
  usuarium: "UsuariumStructure",
  cantus: "CantusStructure",
};

const Converter = ({
  open,
  onClose,
  targetStructure,
  sourceData,
  setData,
  sourceStructureKey,
  targetStructureKey,
  setStructureKey,
}) => {
  //const [similarityThreshold, setSimilarityThreshold] = useState(75);
  const [isConverting, setIsConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  // One fetcher for the component's lifetime: shares each mapping file's request.
  const fetchMappingFile = useRef(createMappingFetcher()).current;

  const conversionMap = CONVERSION_MAPS[sourceStructureKey] || {};
  const targetStructureName = STRUCTURE_NAMES[targetStructureKey];

  const convertData = useCallback(async () => {
    setIsConverting(true);
    setProgress(0);
    try {
      // Cantus numbers chants per folio; put the rows in book order first so the
      // running sequence_in_ms assigned below is correct for the whole manuscript.
      const orderedSource =
        sourceStructureKey === "cantus" ? sortCantusRows(sourceData) : sourceData;
      const newData = await convertRows({
        sourceRows: orderedSource,
        conversionMap,
        targetStructure,
        targetStructureName,
        fetchMappingFile,
        onProgress: setProgress,
      });

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
      onOpenChange={() => !isConverting && onClose()}
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
                {/*
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
                */}
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