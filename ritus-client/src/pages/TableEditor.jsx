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
} from "@chakra-ui/react";
import { useParams } from "react-router-dom";
import { toaster } from "@/components/ui/toaster";
import DataTable from "../components/DataTable";
import ContentStructure from "../utils/ContentStructure";
import {
  fetchProjectContent,
  fetchImages,
  saveProjectContent,
  startBatchProcess,
  getBatchProcessStatus,
  cancelBatchProcess,
} from "../apiUtils";

import { RxTextAlignBottom } from "react-icons/rx";
import { BsCloudArrowUpFill } from "react-icons/bs";
import { MdFindInPage } from "react-icons/md";

const generateEmptyRow = () => {
  const row = { _internalId: Date.now() };
  ContentStructure.forEach((col) => {
    row[col.name] = col.value ?? "";
  });
  row.sequence_in_ms = 1;
  return row;
};

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
  const [data, setData] = useState([generateEmptyRow()]);
  const [isLoading, setIsLoading] = useState(!!projectId);
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [showBatchDialog, setShowBatchDialog] = useState(false);
  const [similarityThreshold, setSimilarityThreshold] = useState(75);
  const [batchStatus, setBatchStatus] = useState({
    status: "none",
    progress: 0,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const pollingRef = useRef(null);
  const batchDialogRef = useRef(null);

  const navigate = useNavigate();

  // Debug component types
  useEffect(() => {
    console.log("Debug Component Types:");
    console.log("DataTable:", DataTable);
    console.log("Dialog:", Dialog);
    console.log("Dialog.Root:", Dialog?.Root);
    console.log("NumberInput:", NumberInput);
    console.log("NumberInput.Root:", NumberInput?.Root);
    console.log("Progress:", Progress);
    console.log("Progress.Root:", Progress?.Root);
    console.log("ContentStructure:", ContentStructure);
    if (typeof DataTable !== "function") {
      console.error("DataTable is not a valid component:", DataTable);
    }
    if (typeof Dialog?.Root !== "function") {
      console.error("Dialog.Root is not a valid component:", Dialog?.Root);
    }
    if (typeof Progress?.Root !== "function") {
      console.error("Progress.Root is not a valid component:", Progress?.Root);
    }
  }, []);

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
        await loadProjectContent();
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

  const loadProjectContent = async () => {
    if (!projectId) return;
    try {
      setIsLoading(true);
      const content = await fetchProjectContent(projectId);
      console.log("Fetched content:", content);
      const tableData = content.map((row, index) => ({
        ...row.data,
        id: row.id,
        _internalId: row.id || Date.now() + index,
        sequence_in_ms: Number(row.data.sequence_in_ms) || index + 1,
      }));
      const newData = tableData.length > 0 ? tableData : [generateEmptyRow()];
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
    }
  };

  useEffect(() => {
    loadProjectContent();
  }, [projectId]);

  const handleLoadTranscription = async () => {
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

      const newData = images.reduce((acc, img, index) => {
        const parseText = (text) => {
          const rows = [];
          let currentFormulaText = "";
          let i = 0;

          const pushIfNotEmpty = (row) => {
            const hasContent = Object.values(row).some(
              (v) => typeof v === "string" && v.trim() !== ""
            );
            if (hasContent) rows.push(row);
          };

          while (i < text.length) {
            if (text.slice(i, i + 5) === "<red>") {
              pushIfNotEmpty({
                formula_text_from_ms: currentFormulaText,
                rite_name_from_ms: "",
                function_id: "",
              });
              currentFormulaText = "";

              i += 5;
              const endIndex = text.indexOf("</red>", i);
              if (endIndex === -1) break;
              const redContent = text.slice(i, endIndex).trim();
              pushIfNotEmpty({
                formula_text_from_ms: "",
                rite_name_from_ms: redContent,
                function_id: "",
              });
              i = endIndex + 6;
            } else if (text.slice(i, i + 6) === "<func>") {
              pushIfNotEmpty({
                formula_text_from_ms: currentFormulaText,
                rite_name_from_ms: "",
                function_id: "",
              });
              currentFormulaText = "";

              i += 6;
              const endIndex = text.indexOf("</func>", i);
              if (endIndex === -1) break;
              const funcContent = text.slice(i, endIndex).trim();
              pushIfNotEmpty({
                formula_text_from_ms: "",
                rite_name_from_ms: "",
                function_id: funcContent,
              });
              i = endIndex + 7;
            } else {
              currentFormulaText += text[i];
              i++;
            }
          }

          pushIfNotEmpty({
            formula_text_from_ms: currentFormulaText,
            rite_name_from_ms: "",
            function_id: "",
          });

          return rows;
        };

        const parsedRows = parseText(img.transcribed_text || "");

        return acc.concat(
          parsedRows.map((rowData, rowIndex) => {
            const row = {
              _internalId: Date.now() + index * 1000 + rowIndex,
              where_in_ms_from: img.name || "",
              where_in_ms_to: img.name || "",
              formula_text_from_ms: rowData.formula_text_from_ms,
              rite_name_from_ms: rowData.rite_name_from_ms,
              function_id: rowData.function_id,
              sequence_in_ms: index + 1,
            };
            ContentStructure.forEach((col) => {
              if (!(col.name in row)) {
                row[col.name] = col.value ?? "";
              }
            });
            return row;
          })
        );
      }, []);

      console.log("Transformed data:", newData);
      setData(newData.length > 0 ? [...newData] : [generateEmptyRow()]);
      console.log(
        "Set transcription data:",
        newData.length > 0 ? newData : [generateEmptyRow()]
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
      await startBatchProcess(projectId, similarityThreshold);
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
        title: "Success",
        description: "Batch processing canceled",
        type: "success",
        duration: 3000,
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
  if (typeof DataTable !== "function" || typeof Dialog?.Root !== "function") {
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
          width="300px"
          mb={4}
          cursor="pointer"
          onClick={() => navigate("/")}
        />
        <Link
          onClick={() => navigate(`/project/${projectId}`)}
          color="blue.500"
          mb={4}
          display="block"
        >
          ⮨ Back to the Project
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
            onClick={() => setShowBatchDialog(true)}
            isLoading={isLoading}
            colorPalette="blue"
            disabled={isProcessing}
          >
            <MdFindInPage />
            Full Automatic Lookup and Split
          </Button>
        )}
      </HStack>

      <DataTable
        tableStructure={ContentStructure}
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
              </Dialog.Header>
              <Dialog.Body>
                Loading transcriptions will overwrite existing table data. Do
                you want to proceed?
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
                <Button colorScheme="red" onClick={loadTranscription}>
                  Overwrite
                </Button>
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
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
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Full Automatic Lookup and Split</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack spacing={4} align="stretch">
                  <Text>Similarity Threshold</Text>
                  <NumberInput.Root
                    defaultValue={75}
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
                    <Progress.Root value={batchStatus.progress || 0} maxW="sm">
                      <HStack gap="5">
                        <Progress.Label>Processing</Progress.Label>
                        <Progress.Track flex="1">
                          <Progress.Range />
                        </Progress.Track>
                        <Progress.ValueText>
                          {Math.round(batchStatus.progress * 100) / 100 || 0}%
                          {/*
                          `${
                          batchStatus.processed_rows || 0
                        }/${
                          batchStatus.total_rows || 0
                        } rows`
                         */}
                        </Progress.ValueText>
                      </HStack>
                    </Progress.Root>
                  )}
                  {batchStatus.status === "failed" && (
                    <Text color="red.500">{batchStatus.error_message}</Text>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={handleCancelBatchProcess}
                    disabled={!isProcessing}
                  >
                    Cancel Process
                  </Button>
                </Dialog.ActionTrigger>
                <Button
                  colorScheme="purple"
                  onClick={handleStartBatchProcess}
                  disabled={isProcessing}
                >
                  Execute
                </Button>
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
};

export default TableEditor;
