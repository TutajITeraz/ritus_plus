// components/IiifDownloader.jsx
import { useState, useEffect } from "react";
import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Portal,
  Input,
  Stack,
  Text,
  HStack,
  Progress,
  NumberInput,
} from "@chakra-ui/react";
import { uploadImages } from "../apiUtils";
import { toaster } from '@/components/ui/toaster';

// Utility function to sleep for a given number of milliseconds
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const IiifDownloader = ({ 
  iiifUrl, 
  projectId, 
  startPage: initialStartPage = 1, 
  open, 
  onOpenChange, 
  onClose 
}) => {
  const [manifest, setManifest] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [startPage, setStartPage] = useState(initialStartPage);
  const [endPage, setEndPage] = useState(null);
  const [downloadInterval, setDownloadInterval] = useState("5"); // Default 5 seconds
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [stopRequested, setStopRequested] = useState(false);

  useEffect(() => {
    const fetchManifest = async () => {
      try {
        const data = await downloadIIIFManifest(iiifUrl);
        setManifest(data);
        const labelsUrls = getLabelsAndUrls(data);
        const count = Object.keys(labelsUrls).length;
        setPageCount(count);
        setEndPage(count); // Default to total pages
      } catch (error) {
        toaster.create({
          title: "IIIF Manifest Error",
          description: error.message || "Failed to download or parse IIIF manifest",
          type: "error",
          duration: 5000,
        });
      }
    };
    fetchManifest();
  }, [iiifUrl]);

  const downloadIIIFManifest = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  };

  const getLabelsAndUrls = (manifest) => {
    const labelsUrls = {};
    if (manifest.items) { // IIIF v3
      for (const item of manifest.items) {
        if (item.type === "Canvas") {
          const label = item.label?.none?.[0] || "Untitled";
          let thumbnailUrl = null;
          let fullImageUrl = null;

          if (item.thumbnail) {
            thumbnailUrl = Array.isArray(item.thumbnail) ? item.thumbnail[0].id : item.thumbnail.id;
          }

          if (item.items) {
            for (const annotationPage of item.items) {
              if (annotationPage.type === "AnnotationPage" && annotationPage.items) {
                for (const annotation of annotationPage.items) {
                  if (annotation.type === "Annotation" && annotation.body) {
                    const body = annotation.body;
                    if (body.type === "Image" && body.id) {
                      fullImageUrl = body.id;
                      if (!thumbnailUrl) thumbnailUrl = body.id;
                    }
                  }
                }
              }
            }
          }

          if (thumbnailUrl && fullImageUrl) {
            labelsUrls[label] = { thumbnail: thumbnailUrl, full: fullImageUrl };
          }
        }
      }
    } else if (manifest.sequences) { // IIIF v2
      for (const sequence of manifest.sequences) {
        if (sequence.canvases) {
          for (const canvas of sequence.canvases) {
            const label = canvas.label || "Untitled";
            let thumbnailUrl = null;
            let fullImageUrl = null;

            if (canvas.thumbnail) {
              thumbnailUrl = canvas.thumbnail["@id"] || canvas.thumbnail;
            }

            if (canvas.images) {
              for (const image of canvas.images) {
                if (image.resource && image.resource["@id"]) {
                  fullImageUrl = image.resource["@id"];
                  if (!thumbnailUrl) thumbnailUrl = fullImageUrl;
                }
              }
            }

            if (thumbnailUrl && fullImageUrl) {
              labelsUrls[label] = { thumbnail: thumbnailUrl, full: fullImageUrl };
            }
          }
        }
      }
    }
    return labelsUrls;
  };

  const handleDownloadPages = async () => {
    if (!manifest || isDownloading) return;
    setIsDownloading(true);
    setStopRequested(false);
    try {
      const labelsUrls = getLabelsAndUrls(manifest);
      const pages = Object.entries(labelsUrls);
      const start = Math.max(1, parseInt(startPage) || 1) - 1; // Convert to 0-based index
      const end = Math.min(pageCount, parseInt(endPage) || pageCount); // Ensure within bounds
      const total = end - start;
      let downloadedCount = 0;
      let currentInterval = parseFloat(downloadInterval) || 5; // Ensure valid number, default to 5

      setProgress({ current: 0, total });

      for (let i = start; i < end; i++) {
        if (stopRequested) {
          setStartPage(downloadedCount + start + 1); // Update start page to last downloaded + 1
          break;
        }

        const [label, urls] = pages[i];
        let retries = 0;
        let success = false;

        while (retries < 5 && !success && !stopRequested) {
          try {
            const fullResponse = await fetch(urls.full);
            if (!fullResponse.ok) throw new Error(`Failed to fetch image: ${fullResponse.status}`);
            const fullBlob = await fullResponse.blob();
            const fullFile = new File([fullBlob], `${label}.jpg`, { type: "image/jpeg" });

            const formData = new FormData();
            formData.append("images", fullFile);

            await uploadImages(projectId, formData);
            success = true;
            downloadedCount += 1;
            setProgress({ current: downloadedCount, total });
          } catch (error) {
            retries += 1;
            if (retries < 5) {
              currentInterval += 5; // Increase interval by 5 seconds
              toaster.create({
                title: "Retry Attempt",
                description: `Failed to download ${label} (Attempt ${retries}/5). Retrying in ${currentInterval}s...`,
                type: "warning",
                duration: 3000,
              });
              await sleep(currentInterval * 1000); // Wait before retry
            } else {
              throw new Error(`Failed to download ${label} after 5 attempts: ${error.message}`);
            }
          }
        }

        if (success && !stopRequested && i < end - 1) {
          await sleep(currentInterval * 1000); // Wait between successful downloads
        }
      }

      if (!stopRequested) {
        toaster.create({
          title: "Download Complete",
          description: `Successfully downloaded ${downloadedCount} pages`,
          type: "success",
          duration: 5000,
        });
        onClose();
      } else {
        toaster.create({
          title: "Download Stopped",
          description: `Stopped after downloading ${downloadedCount} pages`,
          type: "info",
          duration: 5000,
        });
      }
    } catch (error) {
      toaster.create({
        title: "Download Error",
        description: error.message || "Failed to download IIIF pages",
        type: "error",
        duration: 5000,
      });
    } finally {
      setIsDownloading(false);
      setStopRequested(false);
    }
  };

  const handleCancel = () => {
    if (isDownloading) {
      setStopRequested(true);
    } else {
      onOpenChange({ open: false });
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!isDownloading) {
          onOpenChange(e);
        }
      }}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Download IIIF Manifest</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack spacing={4}>
                {manifest ? (
                  <>
                    <Text>Number of pages: {pageCount}</Text>
                    <Box>
                      <Text fontWeight="bold" mb={2}>Start Page</Text>
                      <Input
                        defaultValue={startPage}
                        type="number"
                        variant="outline"
                        placeholder="Enter start page"
                        onChange={(e) => setStartPage(e.target.value)}
                        disabled={isDownloading}
                      />
                    </Box>
                    <Box>
                      <Text fontWeight="bold" mb={2}>End Page</Text>
                      <Input
                        defaultValue={endPage}
                        type="number"
                        variant="outline"
                        placeholder="Enter end page"
                        onChange={(e) => setEndPage(e.target.value)}
                        disabled={isDownloading}
                      />
                    </Box>
                    <Box>
                      <Text fontWeight="bold" mb={2}>Download Interval (seconds)</Text>
                      <NumberInput.Root
                        maxW="200px"
                        defaultValue={downloadInterval}
                        onValueChange={(e) => setDownloadInterval(e.value)}
                        disabled={isDownloading}
                      >
                        <NumberInput.Control />
                        <NumberInput.Input />
                      </NumberInput.Root>
                    </Box>
                    {isDownloading && (
                      <Progress.Root defaultValue={(progress.current / progress.total) * 100} maxW="sm">
                        <HStack gap="5">
                          <Progress.Label>Downloading</Progress.Label>
                          <Progress.Track flex="1">
                            <Progress.Range />
                          </Progress.Track>
                          <Progress.ValueText>{`${progress.current}/${progress.total}`}</Progress.ValueText>
                        </HStack>
                      </Progress.Root>
                    )}
                  </>
                ) : (
                  <Text>Loading manifest...</Text>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button onClick={handleDownloadPages} disabled={!manifest || isDownloading}>
                Download Pages
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" disabled={isDownloading} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default IiifDownloader;