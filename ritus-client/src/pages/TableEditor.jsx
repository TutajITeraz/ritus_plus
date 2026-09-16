import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Dialog,
  Portal,
  HStack,
  CloseButton,
  NumberInput,
  Progress,
  VStack,
  Text,
  Center,
  Image,
  Link,
  Select,
  createListCollection,
  Table,
} from "@chakra-ui/react";
import { useParams } from "react-router-dom";
import { toaster } from "@/components/ui/toaster";
import DataTable from "../components/DataTable";
import Converter from "../components/Converter";
import ContentStructure from "../utils/ContentStructure";
import UsuariumStructure from "../utils/UsuariumStructure";
import CantusStructure from "../utils/CantusStructure";
import {
  fetchProjectContent,
  fetchImages,
  saveProjectContent,
  startBatchProcess,
  getBatchProcessStatus,
  cancelBatchProcess,
} from "../apiUtils";
import { buildRowsFromTranscription } from "../utils/transcriptionRows";

import { RxTextAlignBottom } from "react-icons/rx";
import { BsCloudArrowUpFill } from "react-icons/bs";
import { MdFindInPage } from "react-icons/md";
import { TiArrowBack } from "react-icons/ti";

const generateEmptyRow = (structure) => {
  const row = { _internalId: Date.now() };
  structure.forEach((col) => {
    row[col.name] = col.value ?? "";
  });
  const seqCol = structure.find((col) => col.type === "sequence");
  if (seqCol) {
    row[seqCol.name] = 1;
  }
  return row;
};

// Structure pairs with a real field mapping defined in ConversionDescription.jsx.
// content<->usuarium is fully bidirectional; cantus->content is currently
// one-way only (see the Cantus Index conversion report for unmapped fields).
const canConvertStructures = (from, to) =>
  (["content", "usuarium"].includes(from) &&
    ["content", "usuarium"].includes(to)) ||
  (from === "cantus" && to === "content");

const hasMeaningfulData = (data) => {
  return data.some((row) =>
    Object.entries(row).some(
      ([key, value]) =>
        key !== "_internalId" &&
        value !== "" &&
        value != null &&
        !(typeof value === "string" && value.trim() === "")
    )
  );
};

const TableEditor = () => {
  const { id: projectId } = useParams();
  const structures = {
    content: ContentStructure,
    usuarium: UsuariumStructure,
    cantus: CantusStructure,
  };
  const [structureKey, setStructureKey] = useState("content");
  const [pendingStructureKey, setPendingStructureKey] = useState(null);
  const currentStructure = structures[structureKey];
  const [data, setData] = useState([generateEmptyRow(ContentStructure)]);
  const [isLoading, setIsLoading] = useState(!!projectId);
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [showSwitchDialog, setShowSwitchDialog] = useState(false);
  const [showConverterDialog, setShowConverterDialog] = useState(false);
  const [showBatchDialog, setShowBatchDialog] = useState(false);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.75);
  // Matching method for Full Automatic Lookup and Split. The n-gram matcher is
  // the default: it is far faster than the legacy algorithm and at least as
  // accurate (see ngram_matcher.py on the server for how it works).
  const [matchingMethod, setMatchingMethod] = useState("ngram");
  const [batchStatus, setBatchStatus] = useState({
    status: "none",
    progress: 0,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [shouldLoadContent, setShouldLoadContent] = useState(!!projectId);
  const pollingRef = useRef(null);
  const batchDialogRef = useRef(null);
  // Portal container for the method dropdown: it must be a real DOM node inside
  // the dialog, or the popover renders behind the modal backdrop. Dialog.Root is
  // a context provider, so the ref goes on Dialog.Content.
  const batchDialogContentRef = useRef(null);

  const structureCollection = createListCollection({
    items: [
      { label: "eCatalogus Structure", value: "content" },
      { label: "Usuarium Structure", value: "usuarium" },
      { label: "Cantus Index", value: "cantus" },
    ],
  });

  const matchingMethodCollection = createListCollection({
    items: [
      { label: "n-gram matcher (recommended)", value: "ngram" },
      { label: "legacy algorithm", value: "legacy" },
    ],
  });

  const navigate = useNavigate();

  const handleStructureChange = (newKey) => {
    if (newKey === structureKey) return;
    console.log("Structure change requested:", {
      from: structureKey,
      to: newKey,
      hasData: hasMeaningfulData(data),
    });
    if (!hasMeaningfulData(data)) {
      setStructureKey(newKey);
      setData([generateEmptyRow(structures[newKey])]);
      setShouldLoadContent(false);
      console.log("Structure changed without data:", {
        newStructure: newKey,
        newData: [generateEmptyRow(structures[newKey])],
      });
    } else {
      setPendingStructureKey(newKey);
      setShowSwitchDialog(true);
      setShouldLoadContent(false);
      console.log("Showing switch dialog:", { pendingStructure: newKey });
    }
  };

  const handleDropAndSwitch = () => {
    setStructureKey(pendingStructureKey);
    setData([generateEmptyRow(structures[pendingStructureKey])]);
    setPendingStructureKey(null);
    setShowSwitchDialog(false);
    setShouldLoadContent(false);
    toaster.create({
      title: "Structure switched",
      description: "Current data has been dropped",
      type: "info",
      duration: 3000,
    });
    console.log("Dropped data and switched structure:", {
      newStructure: pendingStructureKey,
      newData: [generateEmptyRow(structures[pendingStructureKey])],
    });
  };

  const handleConvertAndSwitch = () => {
    setShowSwitchDialog(false);
    setShowConverterDialog(true);
    setShouldLoadContent(false);
    console.log("Opening converter dialog:", {
      from: structureKey,
      to: pendingStructureKey,
    });
  };

  const checkBatchStatus = async () => {
    if (!projectId) return;
    try {
      const status = await getBatchProcessStatus(projectId);
      setBatchStatus(status);
      if (status.status === "running") {
        setIsProcessing(true);
        setShowBatchDialog(true);
        startPolling();
      } else if (status.status === "completed") {
        setIsProcessing(false);
        setShowBatchDialog(false);
        stopPolling();
        // force: setShouldLoadContent is asynchronous, so loadProjectContent
        // would still read the previous value out of this closure and skip the
        // reload - leaving the table showing the pre-split rows until the user
        // reloads the page by hand.
        setShouldLoadContent(true);
        await loadProjectContent({ force: true });
        toaster.create({
          title: "Success",
          description: "Batch processing completed",
          type: "success",
          duration: 3000,
        });
      } else if (status.status === "failed") {
        setIsProcessing(false);
        setShowBatchDialog(false);
        stopPolling();
        toaster.create({
          title: "Error",
          description: status.error_message || "Batch processing failed",
          type: "error",
          duration: 3000,
        });
      } else {
        setIsProcessing(false);
        stopPolling();
      }
    } catch (error) {
      console.error("Failed to check batch status:", error);
      setIsProcessing(false);
      stopPolling();
      toaster.create({
        title: "Error",
        description: error.message || "Failed to check batch status",
        type: "error",
        duration: 3000,
      });
    }
  };

  const startPolling = () => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(checkBatchStatus, 5000);
  };

  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  useEffect(() => {
    checkBatchStatus();
    return () => stopPolling();
  }, [projectId]);

  const loadProjectContent = async ({ force = false } = {}) => {
    if (!projectId || (!shouldLoadContent && !force)) {
      console.log("Skipping loadProjectContent:", { projectId, shouldLoadContent, force });
      return;
    }
    try {
      setIsLoading(true);
      const content = await fetchProjectContent(projectId);
      console.log("Fetched content:", content);
      let tableData = content.map((row, index) => ({
        ...row.data,
        id: row.id,
        _internalId: row.id || Date.now() + index,
      }));
      tableData.forEach((row) => {
        currentStructure.forEach((col) => {
          if (row[col.name] === undefined) {
            row[col.name] = col.value ?? "";
          }
        });
      });
      const seqCol = currentStructure.find((col) => col.type === "sequence");
      if (seqCol) {
        tableData.forEach((row, index) => {
          if (row[seqCol.name] == null || row[seqCol.name] === "") {
            row[seqCol.name] = index + 1;
          } else {
            row[seqCol.name] = Number(row[seqCol.name]);
          }
        });
      }
      const newData = tableData.length > 0 ? tableData : [generateEmptyRow(currentStructure)];
      setData(newData);
      console.log("Set initial data:", newData);
    } catch (error) {
      console.error("Failed to load project content:", error);
      toaster.create({
        title: "Error",
        description: error.message || "Failed to load project content",
        type: "error",
        duration: 3000,
      });
    } finally {
      setIsLoading(false);
      setShouldLoadContent(false);
    }
  };

  useEffect(() => {
    loadProjectContent();
  }, [projectId]);

  const handleLoadTranscription = async () => {
    if (structureKey !== "content") {
      toaster.create({
        title: "Error",
        description: "Load Transcription is only supported for eCatalogus Structure",
        type: "error",
        duration: 3000,
      });
      return;
    }
    if (hasMeaningfulData(data)) {
      setShowOverwriteDialog(true);
      return;
    }
    await loadTranscription();
  };

  const loadTranscription = async () => {
    if (!projectId) return;
    try {
      setIsLoading(true);
      const images = await fetchImages(projectId);
      console.log("Fetched images:", images);

      const mergedRows = buildRowsFromTranscription(images, currentStructure);

      console.log("Transformed data:", mergedRows);
      setData(mergedRows.length > 0 ? [...mergedRows] : [generateEmptyRow(currentStructure)]);
      console.log(
        "Set transcription data:",
        mergedRows.length > 0 ? mergedRows : [generateEmptyRow(currentStructure)]
      );
      toaster.create({
        title: "Success",
        description: "Project transcriptions loaded successfully",
        type: "success",
        duration: 3000,
      });
    } catch (error) {
      console.error("Failed to load transcriptions:", error);
      toaster.create({
        title: "Error",
        description: error.message || "Failed to load transcriptions",
        type: "error",
        duration: 3000,
      });
    } finally {
      setIsLoading(false);
      setShowOverwriteDialog(false);
    }
  };

  const handleSaveToServer = async () => {
    if (!projectId) {
      toaster.create({
        title: "Error",
        description: "No project ID provided for saving",
        type: "error",
        duration: 3000,
      });
      return;
    }
    try {
      setIsLoading(true);
      const contentRows = data.map((row) => ({
        id: row.id,
        ...Object.fromEntries(
          Object.entries(row).filter(([key]) => key !== "_internalId")
        ),
      }));
      const savePromise = saveProjectContent(projectId, contentRows);
      toaster.promise(savePromise, {
        success: {
          title: "Successfully uploaded!",
          description: "Looks great",
        },
        error: {
          title: "Upload failed",
          description: "Something wrong with the upload",
        },
        loading: { title: "Uploading...", description: "Please wait" },
      });
      await savePromise;
    } catch (error) {
      console.error("Failed to save content:", error);
      toaster.create({
        title: "Error",
        description: error.message || "Failed to save content",
        type: "error",
        duration: 3000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartBatchProcess = async () => {
    batchStatus.progress = 0; // Reset progress
    setBatchStatus(batchStatus)

    if (structureKey !== "content") {
      toaster.create({
        title: "Error",
        description: "Batch Process is only supported for eCatalogus Structure",
        type: "error",
        duration: 3000,
      });
      return;
    }
    if (!projectId) {
      toaster.create({
        title: "Error",
        description: "No project ID provided for batch processing",
        type: "error",
        duration: 3000,
      });
      return;
    }
    try {
      setIsLoading(true);
      console.log(
        "Starting batch process with threshold:",
        similarityThreshold,
        "method:",
        matchingMethod
      );
      await startBatchProcess(projectId, similarityThreshold, matchingMethod);
      setIsProcessing(true);
      startPolling();
      toaster.create({
        title: "Success",
        description: "Batch processing started",
        type: "success",
        duration: 3000,
      });
    } catch (error) {
      console.error("Failed to start batch process:", error);
      toaster.create({
        title: "Error",
        description: error.message || "Failed to start batch process",
        type: "error",
        duration: 3000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelBatchProcess = async () => {
    if (!projectId) return;
    try {
      setIsLoading(true);
      await cancelBatchProcess(projectId);
      setIsProcessing(false);
      setShowBatchDialog(false);
      stopPolling();
      toaster.create({
        title: "Canceled",
        description:
          "Batch processing was canceled. The table was left as it was - " +
          "results are only written once the run finishes.",
        type: "info",
        duration: 5000,
      });
    } catch (error) {
      console.error("Failed to cancel batch process:", error);
      toaster.create({
        title: "Error",
        description: error.message || "Failed to cancel batch process",
        type: "error",
        duration: 3000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Fallback if DataTable or Dialog is invalid
  if (
    typeof DataTable !== "function" ||
    typeof Converter !== "function" ||
    typeof Dialog?.Root !== "function"
  ) {
    return (
      <Box p={4}>
        <Text color="red.500">
          Error: Invalid component detected. Check console for details.
        </Text>
      </Box>
    );
  }

  return (
    <Box p={4}>
      <HStack mb={4}>
        <Image
          src="/logo.svg"
          alt="Logo"
          height="40px"
          mb={4}
          cursor="pointer"
          onClick={() => navigate("/")}
        />
        <Link
          onClick={() => navigate(`/project/${projectId}`)}
          color="blue.500"
          mb={4}
          display="inline-flex"
          alignItems="center"
          gap={1}
        >
          <TiArrowBack />Back to the Project
        </Link>
      </HStack>

      <HStack mb={4}>
        {projectId && (
          <Button
            onClick={handleLoadTranscription}
            isLoading={isLoading}
            colorPalette="gray"
            disabled={isProcessing}
          >
            <RxTextAlignBottom />
            Load Project Transcription
          </Button>
        )}
        {projectId && (
          <Button
            onClick={handleSaveToServer}
            isLoading={isLoading}
            colorPalette="gray"
            disabled={isProcessing || isLoading}
          >
            <BsCloudArrowUpFill />
            Save to Server
          </Button>
        )}
        {projectId && (
          <Button
            onClick={() => {handleSaveToServer();setShowBatchDialog(true)}}
            isLoading={isLoading}
            colorPalette="blue"
            disabled={isProcessing}
          >
            <MdFindInPage />
            Full Automatic Lookup and Split
          </Button>
        )}
        <HStack align="baseline">
          <Text fontWeight="medium" whiteSpace="nowrap">Table Structure:</Text>
          <Select.Root
            collection={structureCollection}
            value={[structureKey]}
            onValueChange={(details) => handleStructureChange(details.value[0])}
            size="sm"
            w="200px"
          >
            <Select.HiddenSelect />
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText
                  placeholder={
                    structureCollection.items.find(
                      (item) => item.value === structureKey
                    )?.label
                  }
                />
              </Select.Trigger>
              <Select.IndicatorGroup>
                <Select.Indicator />
              </Select.IndicatorGroup>
            </Select.Control>
            <Portal>
              <Select.Positioner>
                <Select.Content>
                  {structureCollection.items.map((item) => (
                    <Select.Item item={item} key={item.value}>
                      {item.label}
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Portal>
          </Select.Root>
        </HStack>
      </HStack>

      <DataTable
        key={structureKey}
        tableStructure={currentStructure}
        structureKey={structureKey}
        data={data}
        setData={setData}
        isLoading={isLoading || isProcessing}
      />
      <Dialog.Root
        open={showOverwriteDialog}
        onOpenChange={(e) => setShowOverwriteDialog(e.open)}
        placement="center"
        motionPreset="slide-in-bottom"
        unmountOnExit
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Overwrite Existing Data?</Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body>
                Loading transcriptions will overwrite existing table data. Do
                you want to proceed?
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="outline" onClick={() => setShowOverwriteDialog(false)}>Cancel</Button>
                <Button colorScheme="red" onClick={loadTranscription}>
                  Overwrite
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      <Dialog.Root
        open={showSwitchDialog}
        onOpenChange={(e) => setShowSwitchDialog(e.open)}
        placement="center"
        motionPreset="slide-in-bottom"
        unmountOnExit
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Switch Structure?</Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body>
                <Text>
                  Existing data detected. Switching to{" "}
                  {
                    structureCollection.items.find(
                      (item) => item.value === pendingStructureKey
                    )?.label
                  }
                  .
                </Text>
                <Text mt={2}>
                  {canConvertStructures(structureKey, pendingStructureKey)
                    ? "You can convert the current data or drop it and start fresh."
                    : "Conversion is not supported for this structure. You can drop the current data and start fresh."}
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="outline" onClick={() => setShowSwitchDialog(false)}>Cancel</Button>
                {canConvertStructures(structureKey, pendingStructureKey) && (
                    <Button colorScheme="blue" onClick={handleConvertAndSwitch}>
                      Convert and Switch
                    </Button>
                  )}
                <Button colorScheme="red" onClick={handleDropAndSwitch}>
                  Drop Data and Switch
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      <Converter
        open={showConverterDialog}
        onClose={() => setShowConverterDialog(false)}
        sourceStructure={currentStructure}
        targetStructure={structures[pendingStructureKey]}
        sourceData={data}
        setData={setData}
        sourceStructureKey={structureKey}
        targetStructureKey={pendingStructureKey}
        setStructureKey={setStructureKey}
      />
      <Dialog.Root
        open={showBatchDialog}
        onOpenChange={(e) => {
          if (isProcessing && e.open) return;
          setShowBatchDialog(e.open);
        }}
        placement="center"
        motionPreset="slide-in-bottom"
        unmountOnExit
        ref={batchDialogRef}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content ref={batchDialogContentRef}>
              <Dialog.Header>
                <Dialog.Title>Full Automatic Lookup and Split</Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body>
                <VStack spacing={4} align="stretch">
                  <Text>Matching method</Text>
                  <Select.Root
                    collection={matchingMethodCollection}
                    value={[matchingMethod]}
                    onValueChange={(details) =>
                      setMatchingMethod(details.value[0] || "ngram")
                    }
                    disabled={isProcessing}
                    size="sm"
                  >
                    <Select.HiddenSelect />
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText
                          placeholder={
                            matchingMethodCollection.items.find(
                              (item) => item.value === matchingMethod
                            )?.label
                          }
                        />
                      </Select.Trigger>
                      <Select.IndicatorGroup>
                        <Select.Indicator />
                      </Select.IndicatorGroup>
                    </Select.Control>
                    <Portal container={batchDialogContentRef}>
                      <Select.Positioner>
                        <Select.Content>
                          {matchingMethodCollection.items.map((item) => (
                            <Select.Item item={item} key={item.value}>
                              {item.label}
                              <Select.ItemIndicator />
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Portal>
                  </Select.Root>
                  <Text>Similarity Threshold</Text>
                  <NumberInput.Root
                    defaultValue={String(similarityThreshold * 100)}
                    step={0.01}
                    min={0}
                    max={1}
                    disabled={isProcessing}
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
                  {isProcessing && (
                    <Progress.Root
                      value={batchStatus.progress || 0}
                      maxW="sm"
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: "20px",
                      }}
                    >
                      <Progress.Label>Processing</Progress.Label>
                      <Progress.Track flex="1">
                        <Progress.Range />
                      </Progress.Track>
                      <Progress.ValueText>
                        {Math.round((batchStatus.progress || 0))}%
                      </Progress.ValueText>
                    </Progress.Root>
                  )}
                  {batchStatus.status === "failed" && (
                    <Text color="red.500">{batchStatus.error_message}</Text>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  onClick={handleCancelBatchProcess}
                  disabled={!isProcessing}
                >
                  Cancel Process
                </Button>
                <Button
                  colorScheme="purple"
                  onClick={handleStartBatchProcess}
                  disabled={isProcessing}
                >
                  Execute
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
};

export default TableEditor;