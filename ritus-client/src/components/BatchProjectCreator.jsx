"use client";

import { useState, useRef } from "react";
import {
  Box,
  Button,
  Dialog,
  Portal,
  CloseButton,
  Stack,
  Text,
  VStack,
  HStack,
  Progress,
  Icon,
  Spinner,
  Link,
  Checkbox,
} from "@chakra-ui/react";
import { LuUpload } from "react-icons/lu";
import { FileUpload } from "@chakra-ui/react";
import Papa from "papaparse";
import { toaster } from "@/components/ui/toaster";
import { getAuthToken } from "../apiUtils";
import { SERVER_URL } from "../config";

const getAuthHeaders = () => {
  const token = getAuthToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
};

const BatchProjectCreator = ({ onProjectsCreated, triggerLabel = "Add Multiple Projects" }) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [csvParseError, setCsvParseError] = useState(null);
  const [createdCount, setCreatedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [skipWithoutIIIF, setSkipWithoutIIIF] = useState(false);
  const dialogRef = useRef(null);

  const handleCSVImport = async (files) => {
    if (files.length === 0) return;
    setIsLoading(true);
    setCsvParseError(null);
    const file = files[0];

    // Read file to detect delimiter
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const csvText = e.target.result;
        const firstLine = csvText.split('\n')[0];
        
        // Auto-detect delimiter: semicolon or comma
        const semicolonCount = (firstLine.match(/;/g) || []).length;
        const commaCount = (firstLine.match(/,/g) || []).length;
        const delimiter = semicolonCount > commaCount ? ';' : ',';

        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          delimiter: delimiter,
          dynamicTyping: false,
          complete: async (results) => {
            try {
              // Get column names from header, handling different cases
              const headers = results.meta.fields || [];
              const nameColumnIdx = headers.findIndex(h => 
                h.toLowerCase().includes('name') || h.toLowerCase().includes('projekt') || h.toLowerCase().includes('project')
              );
              const iiifColumnIdx = headers.findIndex(h => 
                h.toLowerCase().includes('iiif') || h.toLowerCase().includes('url') || h.toLowerCase().includes('manifest')
              );

              if (nameColumnIdx === -1) {
                setCsvParseError("No 'name' column found. Please check your CSV format.");
                setIsLoading(false);
                return;
              }

              const nameColumn = headers[nameColumnIdx];
              const iiifColumn = headers[iiifColumnIdx] || null;

              const projects = results.data
                .map((row) => ({
                  name: row[nameColumn]?.trim(),
                  iiif: iiifColumn ? row[iiifColumn]?.trim() : "",
                }))
                .filter((p) => p.name) // Filter out empty rows
                .filter((p) => !skipWithoutIIIF || p.iiif); // Filter out projects without IIIF if checkbox is set

              if (projects.length === 0) {
                setCsvParseError("No valid projects found in CSV");
                setIsLoading(false);
                return;
              }

              setTotalCount(projects.length);
              setCreatedCount(0);
              setIsProcessing(true);

              for (let i = 0; i < projects.length; i++) {
                const project = projects[i];
                try {
                  const projectData = {
                    name: project.name,
                    type: project.iiif ? "iiif" : "files",
                    iiif_url: project.iiif || "",
                  };

                  const headers = {
                    "Content-Type": "application/json",
                    ...getAuthHeaders(),
                  };

                  const response = await fetch(
                    `${SERVER_URL}/api/projects`,
                    {
                      method: "POST",
                      headers,
                      body: JSON.stringify(projectData),
                    }
                  );

                  if (response.status === 401) {
                    const errorMsg = "Authentication expired. Please log in again.";
                    console.error(`[Project ${i + 1}/${projects.length}] ${errorMsg}`);
                    toaster.create({
                      title: "Authentication Error",
                      description: errorMsg,
                      type: "error",
                      duration: 3000,
                    });
                    // Continue to next project instead of redirecting
                    setCreatedCount((prev) => prev + 1);
                    continue;
                  }

                  if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const errorMsg = errorData.error || errorData.message || `HTTP ${response.status}`;
                    console.error(`[Project ${i + 1}/${projects.length}] Failed to create "${project.name}": ${errorMsg}`);
                    toaster.create({
                      title: "Error creating project",
                      description: `Failed to create "${project.name}": ${errorMsg}`,
                      type: "error",
                      duration: 3000,
                    });
                    setCreatedCount((prev) => prev + 1);
                    continue;
                  }

                  const result = await response.json();
                  console.log(`[Project ${i + 1}/${projects.length}] Successfully created "${project.name}" (ID: ${result.id})`);
                  setCreatedCount((prev) => prev + 1);
                } catch (error) {
                  console.error(`[Project ${i + 1}/${projects.length}] Exception while creating "${project.name}":`, error);
                  toaster.create({
                    title: "Error creating project",
                    description: `Failed to create "${project.name}": ${error.message}`,
                    type: "error",
                    duration: 3000,
                  });
                  setCreatedCount((prev) => prev + 1);
                }

                // Small delay between requests
                await new Promise((resolve) => setTimeout(resolve, 100));
              }

              toaster.create({
                title: "Success",
                description: `Created ${createdCount} projects successfully`,
                type: "success",
                duration: 5000,
              });

              setIsLoading(false);
              setIsProcessing(false);
              setIsDialogOpen(false);
              
              // Notify parent to refresh projects
              if (onProjectsCreated) {
                onProjectsCreated();
              }
            } catch (error) {
              setCsvParseError(`Error processing CSV: ${error.message}`);
              setIsLoading(false);
              setIsProcessing(false);
            }
          },
          error: (error) => {
            setCsvParseError(`Failed to parse CSV file: ${error.message}`);
            setIsLoading(false);
          },
        });
      } catch (error) {
        setCsvParseError(`Error reading file: ${error.message}`);
        setIsLoading(false);
      }
    };
    reader.readAsText(file);
  };

  const handleDownloadSample = () => {
    const csvContent = `name,iiif
My Project,
Admin's Test Project,
IIIF Manuscript,https://example.org/iiif/manifest.json
Another Project,`;
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "sample_projects.csv";
    link.click();
  };

  return (
    <Dialog.Root
      open={isDialogOpen}
      onOpenChange={(e) => {
        setIsDialogOpen(e.open);
        if (!e.open) {
          setIsLoading(false);
          setCsvParseError(null);
          setCreatedCount(0);
          setTotalCount(0);
          setIsProcessing(false);
          setSkipWithoutIIIF(false);
        }
      }}
      placement="center"
      motionPreset="slide-in-bottom"
      unmountOnExit
    >
      <Dialog.Trigger asChild>
        <Button colorPalette="green" variant="outline">
          {triggerLabel}
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content ref={dialogRef}>
            <Dialog.Header>
              <Dialog.Title>Add Multiple Projects from CSV</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="start" spacing={4}>
                <Box>
                  <Text mb={2} fontSize="sm" color="gray.600">
                    Download and fill the sample CSV file:
                  </Text>
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="blue"
                    onClick={handleDownloadSample}
                  >
                    Download sample .csv file
                  </Button>
                </Box>

                {isLoading || isProcessing ? (
                  <VStack colorPalette="teal" width="full">
                    <Spinner color="colorPalette.600" />
                    <Text color="colorPalette.600">Creating projects...</Text>
                    <Progress.Root
                      value={
                        totalCount > 0 ? (createdCount / totalCount) * 100 : 0
                      }
                      width="full"
                    >
                      <HStack gap="2" width="full">
                        <Progress.Track flex="1">
                          <Progress.Range />
                        </Progress.Track>
                        <Text fontSize="sm" minW="60px">
                          {createdCount}/{totalCount}
                        </Text>
                      </HStack>
                    </Progress.Root>
                  </VStack>
                ) : (
                  <>
                    <Checkbox.Root
                      checked={skipWithoutIIIF}
                      onCheckedChange={(e) => setSkipWithoutIIIF(e.checked)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>Create only IIIF projects (skip projects without IIIF URL)</Checkbox.Label>
                    </Checkbox.Root>

                    <FileUpload.Root
                      maxW="xl"
                      alignItems="stretch"
                      accept={["text/csv"]}
                    >
                      <FileUpload.HiddenInput
                        onChange={(e) => handleCSVImport(e.target.files)}
                      />
                      <FileUpload.Dropzone>
                        <Icon size="md" color="fg.muted">
                          <LuUpload />
                        </Icon>
                        <FileUpload.DropzoneContent>
                          <div>Drag and drop CSV file here</div>
                          <div style={{ color: "#718096" }}>
                            .csv files only
                          </div>
                        </FileUpload.DropzoneContent>
                      </FileUpload.Dropzone>
                    </FileUpload.Root>
                    {csvParseError && (
                      <Box
                        p={3}
                        bg="red.50"
                        borderRadius="md"
                        borderLeft="4px solid"
                        borderColor="red.500"
                        width="full"
                      >
                        <Text color="red.700" fontSize="sm">
                          <strong>Error:</strong> {csvParseError}
                        </Text>
                      </Box>
                    )}
                    <Box bg="blue.50" p={3} borderRadius="md" width="full">
                      <Text fontSize="sm" color="blue.700">
                        <strong>CSV Format:</strong> Two columns required:
                      </Text>
                      <Text fontSize="sm" color="blue.700" mt={1}>
                        • <strong>name</strong> - Project name (required)
                      </Text>
                      <Text fontSize="sm" color="blue.700">
                        • <strong>iiif</strong> - IIIF manifest URL (optional)
                      </Text>
                      <Text fontSize="sm" color="blue.700" mt={2}>
                        <strong>Supported formats:</strong>
                      </Text>
                      <Text fontSize="sm" color="blue.700" fontFamily="monospace">
                        • Comma-delimited: name,iiif
                      </Text>
                      <Text fontSize="sm" color="blue.700" fontFamily="monospace">
                        • Semicolon-delimited: name;iiif
                      </Text>
                      <Text fontSize="sm" color="blue.700" mt={2}>
                        If IIIF URL is provided, project type will be "iiif", otherwise "files"
                      </Text>
                    </Box>
                  </>
                )}
              </VStack>
            </Dialog.Body>
            {!isLoading && !isProcessing && (
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
              </Dialog.Footer>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default BatchProjectCreator;
