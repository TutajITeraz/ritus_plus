"use client";

import { useState, useEffect, useRef } from "react";
import {
  Box,
  Button,
  Dialog,
  Portal,
  CloseButton,
  Input,
  Stack,
  Text,
  HStack,
  Progress,
  Select,
  createListCollection,
} from "@chakra-ui/react";
import { toaster } from "@/components/ui/toaster";
import { transcribeImage } from "../apiUtils";

// Utility function to sleep for a given number of milliseconds
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const models = createListCollection({
  items: [
    {
      label: "Tridis Medieval EarlyModern",
      value: "Tridis_Medieval_EarlyModern.mlmodel",
    },
    { label: "Cremma Generic 1.0.1", value: "cremma-generic-1.0.1.mlmodel" },
    { label: "ManuMcFondue", value: "ManuMcFondue.mlmodel" },
    { label: "Catmus Medieval", value: "catmus-medieval.mlmodel" },
    { label: "McCATMuS (16th-21st c. Polyglot)", value: "McCATMuS_nfd_nofix_V1.mlmodel" },
    { label: "LECTAUREP (French Admin)", value: "lectaurep_base.mlmodel" },
    { label: "Lucien Peraire (French Handwriting)", value: "peraire2_ft_MMCFR.mlmodel" },
    { label: "German Handwriting", value: "german_handwriting.mlmodel" },
  ],
});

const Transcribe = ({
  images,
  projectId,
  selectedImageId,
  startPage: initialStartPage = 1,
  onClose,
}) => {
  const contentRef = useRef(null);
  const [pageCount, setPageCount] = useState(images.length);
  const [startPage, setStartPage] = useState(initialStartPage);
  const [endPage, setEndPage] = useState(images.length);
  const [model, setModel] = useState("Tridis_Medieval_EarlyModern.mlmodel");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [totalLines, setTotalLines] = useState(0);
  const [stopRequested, setStopRequested] = useState(false);

  // Update page count and end page when images change
  useEffect(() => {
    setPageCount(images.length);
    setEndPage(images.length);
  }, [images.length]);

  const handleTranscribe = async () => {
    if (isTranscribing) return;
    setIsTranscribing(true);
    setStopRequested(false);
    setTotalLines(0);
    try {
      const start = selectedImageId
        ? images.findIndex((img) => img.id === selectedImageId) + 1
        : Math.max(1, parseInt(startPage) || 1);
      const end = selectedImageId
        ? start
        : Math.min(pageCount, parseInt(endPage) || pageCount);
      const imageIds = selectedImageId
        ? [selectedImageId]
        : images.slice(start - 1, end).map((img) => img.id);
      const total = imageIds.length;
      let transcribedCount = 0;
      let linesCount = 0;

      setProgress({ current: 0, total });

      for (const imageId of imageIds) {
        if (stopRequested) {
          setStartPage(transcribedCount + start); // Update start page to last transcribed + 1
          break;
        }

        try {
          const result = await transcribeImage(imageId, model);
          if (result.status === "success") {
            transcribedCount += 1;
            linesCount += result.line_count;
            setProgress({ current: transcribedCount, total });
            setTotalLines(linesCount);
          } else {
            throw new Error(result.message);
          }
        } catch (error) {
          toaster.create({
            title: "Transcription Failed",
            description: `Failed to transcribe image ID ${imageId}: ${error.message}`,
            type: "error",
            duration: 3000,
          });
          // Continue to next image without retry
        }

        if (!stopRequested && transcribedCount < total) {
          await sleep(1000); // Wait 1 second between transcriptions
        }
      }

      if (!stopRequested) {
        toaster.create({
          title: "Transcription Complete",
          description: `Successfully transcribed ${transcribedCount} images with ${linesCount} lines`,
          type: "success",
          duration: 5000,
        });
        onClose();
      } else {
        toaster.create({
          title: "Transcription Stopped",
          description: `Stopped after transcribing ${transcribedCount} images with ${linesCount} lines`,
          type: "info",
          duration: 5000,
        });
      }
    } catch (error) {
      toaster.create({
        title: "Transcription Error",
        description: error.message || "Failed to transcribe images",
        type: "error",
        duration: 5000,
      });
    } finally {
      setIsTranscribing(false);
      setStopRequested(false);
    }
  };

  const handleCancel = () => {
    if (isTranscribing) {
      setStopRequested(true);
    }
  };

  return (
    <>
      <Dialog.Content ref={contentRef}>
        <Dialog.CloseTrigger top="0" insetEnd="-12" asChild>
          <CloseButton bg="bg" size="sm" />
        </Dialog.CloseTrigger>
        <Dialog.Body pt="4">
          <Dialog.Title>Transcribe Images</Dialog.Title>
          <Stack spacing={4}>
            <Text>Number of pages: {pageCount}</Text>
            {!selectedImageId && (
              <>
                <Box>
                  <Text fontWeight="bold" mb={2}>
                    Start Page
                  </Text>
                  <Input
                    value={startPage}
                    type="number"
                    variant="outline"
                    placeholder="Enter start page"
                    onChange={(e) => setStartPage(e.target.value)}
                    disabled={isTranscribing}
                  />
                </Box>
                <Box>
                  <Text fontWeight="bold" mb={2}>
                    End Page
                  </Text>
                  <Input
                    value={endPage}
                    type="number"
                    variant="outline"
                    placeholder="Enter end page"
                    onChange={(e) => setEndPage(e.target.value)}
                    disabled={isTranscribing}
                  />
                </Box>
              </>
            )}
            <Box>
              <Text fontWeight="bold" mb={2}>
                Model
              </Text>
              <Select.Root
                collection={models}
                defaultValue={["Tridis_Medieval_EarlyModern.mlmodel"]}
                onValueChange={(details) => setModel(details.value[0])}
                size="sm"
                disabled={isTranscribing}
              >
                <Select.HiddenSelect />
                <Select.Label>Select model</Select.Label>
                <Select.Control>
                  <Select.Trigger>
                    <Select.ValueText placeholder="Select model" />
                  </Select.Trigger>
                  <Select.IndicatorGroup>
                    <Select.Indicator />
                  </Select.IndicatorGroup>
                </Select.Control>
                <Portal container={contentRef}>
                  <Select.Positioner>
                    <Select.Content>
                      {models.items.map((item) => (
                        <Select.Item item={item} key={item.value}>
                          {item.label}
                          <Select.ItemIndicator />
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Positioner>
                </Portal>
              </Select.Root>
            </Box>
            {isTranscribing && (
              <>
                <Progress.Root
                  value={(progress.current / progress.total) * 100}
                  maxW="sm"
                >
                  <HStack gap="5">
                    <Progress.Label>Transcribing</Progress.Label>
                    <Progress.Track flex="1">
                      <Progress.Range />
                    </Progress.Track>
                    <Progress.ValueText>{`${progress.current}/${progress.total}`}</Progress.ValueText>
                  </HStack>
                </Progress.Root>
                <Text>Total lines transcribed: {totalLines}</Text>
              </>
            )}
          </Stack>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.CloseTrigger asChild>
            <Button variant="outline" onClick={handleCancel}>
              {isTranscribing ? "Stop" : "Cancel"}
            </Button>
          </Dialog.CloseTrigger>
          <Button
            onClick={handleTranscribe}
            disabled={isTranscribing || pageCount === 0}
          >
            Transcribe Pages
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </>
  );
};

export default Transcribe;
