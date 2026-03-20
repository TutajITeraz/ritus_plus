import {
  Dialog,
  CloseButton,
  Box,
  Flex,
  Text,
  Button,
  Input,
  Stack,
  Image,
  Link,
  Editable,
  FileUpload,
  Accordion,
  Portal,
  Popover,
  HStack,
  Progress,
  Select,
  RadioGroup,
  createListCollection,
  Checkbox,
} from "@chakra-ui/react";
import { RiFileEditFill } from "react-icons/ri";
import { LuUpload } from "react-icons/lu";
import { FaRegTrashAlt, FaDownload, FaStop } from "react-icons/fa";
import { TiArrowBack } from "react-icons/ti";
import { useState, useEffect, useRef } from "react";
import {
  updateProject,
  updateImage,
  uploadImages,
  deleteImage,
  fetchImages,
  startIiifDownload,
  getIiifDownloadStatus,
  cancelIiifDownload,
  resetIiifJob,
  startBatchTranscribe,
  getBatchTranscribeStatus,
  cancelBatchTranscribe,
} from "../apiUtils";
import { useNavigate } from "react-router-dom";
import { toaster } from "@/components/ui/toaster";
import { ProgressBar } from "@/components/ui/progress";
import IiifDownloader from "./IiifDownloader";
import Transcribe from "./Transcribe";
import TranscriptionEditor from "./TranscriptionEditor";
import AIAutoFixModal from "./AIAutoFixModal";

const transcribeModels = createListCollection({
  items: [
    { label: "Tridis Medieval EarlyModern", value: "Tridis_Medieval_EarlyModern.mlmodel" },
    { label: "Cremma Generic 1.0.1", value: "cremma-generic-1.0.1.mlmodel" },
    { label: "ManuMcFondue", value: "ManuMcFondue.mlmodel" },
    { label: "Catmus Medieval", value: "catmus-medieval.mlmodel" },
    { label: "McCATMuS (16th-21st c. Polyglot)", value: "McCATMuS_nfd_nofix_V1.mlmodel" },
    { label: "LECTAUREP (French Admin)", value: "lectaurep_base.mlmodel" },
    { label: "Lucien Peraire (French Handwriting)", value: "peraire2_ft_MMCFR.mlmodel" },
    { label: "German Handwriting", value: "german_handwriting.mlmodel" },
  ],
});

const Sidebar = ({
  project,
  setProject,
  images,
  setImages,
  mainImage,
  setMainImage,
  projectId,
}) => {
  const selectedImage =
    images.find((img) => img.original === mainImage) || null;
  const navigate = useNavigate();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isIiifDownloaderOpen, setIsIiifDownloaderOpen] = useState(false);
  // Server-side IIIF background download
  const [iiifJob, setIiifJob] = useState(null);  // {status, current_page, total_pages, error_message}
  const [iiifConflict, setIiifConflict] = useState(false);
  const iiifPollRef = useRef(null);
  const [transcriptionText, setTranscriptionText] = useState(
    selectedImage?.transcribed_text || ""
  );
  const [isAIAutoFixOpen, setIsAIAutoFixOpen] = useState(false);
  // Background transcription job
  const [transcribeJob, setTranscribeJob] = useState(null);
  const [transcribeDialogOpen, setTranscribeDialogOpen] = useState(false);
  const [transcribeModel, setTranscribeModel] = useState("Tridis_Medieval_EarlyModern.mlmodel");
  const [transcribeMode, setTranscribeMode] = useState("skip");
  const [ignoreEdges, setIgnoreEdges] = useState(true);
  const [transcribeRangeFrom, setTranscribeRangeFrom] = useState(1);
  const [transcribeRangeTo, setTranscribeRangeTo] = useState(1);
  const [transcribeStarting, setTranscribeStarting] = useState(false);
  const transcribePollRef = useRef(null);

  // Sync transcriptionText when selectedImage changes
  useEffect(() => {
    const newText = selectedImage?.transcribed_text || "";
    console.log("Syncing transcriptionText:", {
      selectedImageId: selectedImage?.id,
      newText,
      previousText: transcriptionText,
    });
    setTranscriptionText(newText);
  }, [selectedImage]);

  // Debug logging for selectedImage and mainImage
  /*
  useEffect(() => {
    console.log("Sidebar state update:", {
      selectedImage: {
        id: selectedImage?.id,
        transcribed_text: selectedImage?.transcribed_text,
        original: selectedImage?.original,
      },
      mainImage,
      images: images.map((img) => ({
        id: img.id,
        original: img.original,
        transcribed_text: img.transcribed_text,
      })),
      transcriptionText,
    });
  }, [selectedImage, mainImage, images, transcriptionText]);
  */

  console.log("Sidebar projectId:", projectId); // Debug log

  // Load initial IIIF job status + poll while running
  useEffect(() => {
    if (!projectId) return;
    getIiifDownloadStatus(projectId)
      .then((s) => setIiifJob(s.status !== "none" ? s : null))
      .catch(() => {});
    getBatchTranscribeStatus(projectId)
      .then((s) => setTranscribeJob(s.status !== "none" ? s : null))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    const totalImages = Math.max(1, images.length || 1);
    setTranscribeRangeFrom(1);
    setTranscribeRangeTo(totalImages);
  }, [images.length, transcribeDialogOpen]);

  useEffect(() => {
    if (!(["running", "pending"].includes(iiifJob?.status))) {
      clearInterval(iiifPollRef.current);
      iiifPollRef.current = null;
      return;
    }
    if (iiifPollRef.current) return;
    iiifPollRef.current = setInterval(async () => {
      try {
        const s = await getIiifDownloadStatus(projectId);
        setIiifJob(s.status !== "none" ? s : null);
        if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") {
          clearInterval(iiifPollRef.current);
          iiifPollRef.current = null;
          if (s.status === "completed") {
            fetchImages(projectId).then((imgs) => {
              setImages(imgs);
              if (!mainImage && imgs.length > 0) setMainImage(imgs[0].original);
            });
          }
        }
      } catch (_) {}
    }, 3000);
    return () => {
      clearInterval(iiifPollRef.current);
      iiifPollRef.current = null;
    };
  }, [iiifJob?.status]);

  useEffect(() => {
    if (!([ "running", "pending" ].includes(transcribeJob?.status))) {
      clearInterval(transcribePollRef.current);
      transcribePollRef.current = null;
      return;
    }
    if (transcribePollRef.current) return;
    transcribePollRef.current = setInterval(async () => {
      try {
        const s = await getBatchTranscribeStatus(projectId);
        setTranscribeJob(s.status !== "none" ? s : null);
        if (["completed", "failed", "cancelled"].includes(s.status)) {
          clearInterval(transcribePollRef.current);
          transcribePollRef.current = null;
          if (s.status === "completed") {
            fetchImages(projectId).then((imgs) => {
              setImages(imgs);
              if (!mainImage && imgs.length > 0) setMainImage(imgs[0].original);
            });
          }
        }
      } catch (_) {}
    }, 3000);
    return () => {
      clearInterval(transcribePollRef.current);
      transcribePollRef.current = null;
    };
  }, [transcribeJob?.status]);

  const handleServerIiifDownload = async (confirm = null) => {
    if (!project?.iiif_url) return;
    try {
      const { status, data } = await startIiifDownload(projectId, confirm);
      if (status === 409 && data.conflict) {
        setIiifConflict(true);
        return;
      }
      if (status === 409 && !data.conflict) {
        toaster.create({ title: "Already running", description: data.error, type: "warning", duration: 3000 });
        return;
      }
      setIiifJob({ status: "running", current_page: 0, total_pages: 0 });
      toaster.create({ title: "Download started in background", description: `Starting from page ${data.start_page}`, type: "success", duration: 3000 });
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    }
  };

  const handleCancelServerIiif = async () => {
    try {
      await cancelIiifDownload(projectId);
      setIiifJob((prev) => prev ? { ...prev, status: "cancelled" } : prev);
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    }
  };

  const handleProjectUpdate = async (field, value) => {
    const response = await updateProject(project.id, { [field]: value });
    if (response) setProject({ ...project, [field]: value });
  };

  const handleTranscriptionUpdate = async () => {
    if (!selectedImage) {
      toaster.create({
        title: "Save Error",
        description: "No image selected for saving transcription.",
        type: "error",
        duration: 5000,
      });
      return;
    }
    try {
      console.log("Saving transcription:", {
        imageId: selectedImage.id,
        transcriptionText,
      });
      const response = await updateImage(selectedImage.id, {
        transcribed_text: transcriptionText,
      });
      if (response) {
        setImages(
          images.map((img) =>
            img.id === selectedImage.id
              ? {
                  ...img,
                  transcribed_text: transcriptionText,
                  line_count: transcriptionText.split("\n").length,
                }
              : img
          )
        );
        toaster.create({
          title: "Transcription Saved",
          description: "Transcription updated successfully.",
          type: "success",
          duration: 5000,
        });
      } else {
        throw new Error("No response from server");
      }
    } catch (error) {
      console.error("Transcription save error:", error);
      toaster.create({
        title: "Save Error",
        description: `Failed to save transcription: ${
          error.message || "Server error"
        }`,
        type: "error",
        duration: 5000,
      });
    }
  };

  const handleAIAutoFixSave = async (aiFixedText) => {
    if (!selectedImage) {
      toaster.create({
        title: "Save Error",
        description: "No image selected for saving AI-fixed transcription.",
        type: "error",
        duration: 5000,
      });
      return;
    }
    try {
      console.log("Saving AI-fixed text:", {
        aiFixedText,
        selectedImageId: selectedImage?.id,
      });
      await updateImage(selectedImage.id, {
        transcribed_text: aiFixedText,
      });
      setImages(
        images.map((img) =>
          img.id === selectedImage.id
            ? {
                ...img,
                transcribed_text: aiFixedText,
                line_count: aiFixedText.split("\n").length,
              }
            : img
        )
      );
      setTranscriptionText(aiFixedText);
      setIsAIAutoFixOpen(false);
      toaster.create({
        title: "AI Fix Saved",
        description: "AI-fixed transcription saved successfully.",
        type: "success",
        duration: 5000,
      });
    } catch (error) {
      console.error("AI Auto Fix save error:", error);
      toaster.create({
        title: "Save Error",
        description: `Failed to save AI-fixed transcription: ${
          error.message || "Server error"
        }`,
        type: "error",
        duration: 5000,
      });
    }
  };

  const handleUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (isUploading) return;
    if (!projectId) {
      toaster.create({
        title: "Upload Error",
        description: "Project ID is missing. Please select a project first.",
        type: "error",
        duration: 5000,
      });
      return;
    }

    setIsUploading(true);
    setUploadProgress(0); // Reset progress

    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("images", file));
    try {
      const data = await uploadImages(projectId, formData, setUploadProgress);
      if (data && data.files) {
        const updatedImages = await fetchImages(projectId);
        setImages(updatedImages);
        if (!mainImage && updatedImages.length > 0) {
          setMainImage(updatedImages[0].original);
        }
      }
    } catch (error) {
      toaster.create({
        title: "Upload Error",
        description: error.message || "Failed to upload images",
        type: "error",
        duration: 5000,
      });
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDeleteAll = async () => {
    if (!projectId) {
      toaster.create({
        title: "Delete Error",
        description: "Project ID is missing. Please select a project first.",
        type: "error",
        duration: 5000,
      });
      return;
    }

    try {
      await Promise.all(images.map((img) => deleteImage(img.id)));
      setImages([]);
      setMainImage(null);
      // Fully delete the IIIF job record so Resume can't pick up a stale page offset
      try { await resetIiifJob(projectId); } catch (_) {}
      setIiifJob(null);
    } catch (error) {
      toaster.create({
        title: "Delete Error",
        description: "Failed to delete all images",
        type: "error",
        duration: 5000,
      });
    }
  };

  const handleIiifDownload = () => {
    if (!project?.iiif_url) {
      toaster.create({
        title: "IIIF Error",
        description: "No IIIF URL available for this project.",
        type: "error",
        duration: 5000,
      });
      return;
    }
    setIsIiifDownloaderOpen(true);
  };

  const handleStartBatchTranscribe = async () => {
    const rangeFrom = Number(transcribeRangeFrom);
    const rangeTo = Number(transcribeRangeTo);
    if (transcribeMode === "range") {
      if (!Number.isInteger(rangeFrom) || !Number.isInteger(rangeTo) || rangeFrom < 1 || rangeTo < rangeFrom || rangeTo > images.length) {
        toaster.create({
          title: "Invalid range",
          description: `Choose a valid page range between 1 and ${images.length}.`,
          type: "error",
          duration: 5000,
        });
        return;
      }
    }

    setTranscribeStarting(true);
    try {
      await startBatchTranscribe(
        projectId,
        transcribeModel,
        transcribeMode,
        ignoreEdges,
        transcribeMode === "range" ? rangeFrom : null,
        transcribeMode === "range" ? rangeTo : null,
      );
      setTranscribeJob({
        status: "running",
        current_image: 0,
        total_images: transcribeMode === "range" ? rangeTo - rangeFrom + 1 : images.length,
      });
      setTranscribeDialogOpen(false);
      toaster.create({ title: "Transcription started", description: "Running in background — you can close the browser.", type: "success", duration: 4000 });
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    } finally {
      setTranscribeStarting(false);
    }
  };

  const handleCancelBatchTranscribe = async () => {
    try {
      await cancelBatchTranscribe(projectId);
      setTranscribeJob((prev) => prev ? { ...prev, status: "cancelled" } : prev);
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    }
  };

  const handleTranscribeClose = () => {
    fetchImages(projectId).then((updatedImages) => {
      setImages(updatedImages);
      if (!mainImage && updatedImages.length > 0) {
        setMainImage(updatedImages[0].original);
      }
    });
  };

  const handleIiifDownloaderClose = () => {
    setIsIiifDownloaderOpen(false);
    fetchImages(projectId).then((updatedImages) => {
      setImages(updatedImages);
      if (!mainImage && updatedImages.length > 0) {
        setMainImage(updatedImages[0].original);
      }
    });
  };

  return (
    <Box w="400px" bg="gray.50" p={4} overflowY="auto" h="100vh">
      <Image
        src="/logo.svg"
        alt="Logo"
        height="40px"
        mb={4}
        cursor="pointer"
        onClick={() => navigate("/")}
      />
      <Link
        onClick={() => navigate("/")}
        color="blue.500"
        mb={4}
        display="inline-flex"
        alignItems="center"
        gap={1} // adds spacing between icon and text
      >
        <TiArrowBack />Back to the Projects list
      </Link>
      <Accordion.Root collapsible defaultValue={["project-info"]}>
        <Accordion.Item value="project-info">
          <Accordion.ItemTrigger>
            <Text fontWeight="bold">Project</Text>
            <Accordion.ItemIndicator />
          </Accordion.ItemTrigger>
          <Accordion.ItemContent>
            <Accordion.ItemBody>
              {project && (
                <Stack spacing={3}>
                  <Flex align="center">
                    <Text fontWeight="bold" minW="80px">
                      Name:
                    </Text>
                    <Editable.Root
                      defaultValue={project.name}
                      onValueChange={(e) =>
                        handleProjectUpdate("name", e.value)
                      }
                    >
                      <Editable.Preview />
                      <Editable.Input />
                    </Editable.Root>
                  </Flex>
                  <Flex align="center">
                    <Text fontWeight="bold" minW="80px">
                      Type:
                    </Text>
                    <Text>{project.type}</Text>
                  </Flex>
                  <Flex align="center" gap={2}>
                    <Text fontWeight="bold" minW="80px">
                      IIIF URL:
                    </Text>
                    <Text w="250px">{project.iiif_url || "N/A"}</Text>
                  </Flex>
                  <FileUpload.Root maxFiles={10}>
                    <FileUpload.HiddenInput
                      onChange={handleUpload}
                      disabled={isUploading || !projectId}
                    />
                    <FileUpload.Trigger asChild>
                      <Button
                        size="sm"
                        variant="subtle"
                        isLoading={isUploading}
                        disabled={!projectId}
                      >
                        <LuUpload /> Upload New Images
                      </Button>
                    </FileUpload.Trigger>
                  </FileUpload.Root>
                  {isUploading && (
                    <Box width="100%">
                      <ProgressBar 
                        value={uploadProgress} 
                        size="sm" 
                        colorPalette="blue" 
                        label="Uploading..."
                        showValueText
                      />
                    </Box>
                  )}
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={handleIiifDownload}
                    disabled={!project?.iiif_url || isUploading}
                  >
                    <FaDownload />
                    Download IIIF
                  </Button>
                  {/* Server-side background download */}
                  {project?.iiif_url && (
                    <>
                      {(!iiifJob || iiifJob.status === "none") && (
                        <Button
                          size="sm"
                          variant="subtle"
                          onClick={() => handleServerIiifDownload()}
                          disabled={isUploading}
                        >
                          <FaDownload /> Download IIIF in background
                        </Button>
                      )}
                      {iiifJob?.status === "running" && (
                        <Stack spacing={1}>
                          <Text fontSize="xs" color="blue.600">Background download…</Text>
                          <Progress.Root value={iiifJob.total_pages > 0 ? Math.round((iiifJob.current_page / iiifJob.total_pages) * 100) : 0} maxW="220px">
                            <HStack gap="3">
                              <Progress.Track flex="1">
                                <Progress.Range />
                              </Progress.Track>
                              <Progress.ValueText>{iiifJob.current_page}/{iiifJob.total_pages || "?"}</Progress.ValueText>
                            </HStack>
                          </Progress.Root>
                          <Button size="xs" variant="subtle" colorPalette="red" onClick={handleCancelServerIiif}>
                            <FaStop /> Stop
                          </Button>
                        </Stack>
                      )}
                      {iiifJob?.status === "failed" && (
                        <Stack spacing={1}>
                          <Text fontSize="xs" color="red.600">Error: {iiifJob.error_message}</Text>
                          <Button size="xs" variant="subtle" onClick={() => handleServerIiifDownload()}>
                            <FaDownload /> Retry
                          </Button>
                        </Stack>
                      )}
                      {iiifJob?.status === "cancelled" && (
                        <Stack spacing={1}>
                          <Text fontSize="xs" color="orange.600">Stopped at {iiifJob.current_page}/{iiifJob.total_pages || "?"}.</Text>
                          <Button size="xs" variant="subtle" onClick={() => handleServerIiifDownload()}>
                            <FaDownload /> Resume
                          </Button>
                        </Stack>
                      )}
                      {iiifJob?.status === "completed" && (
                        <Text fontSize="xs" color="green.600">✓ All {iiifJob.total_pages} pages downloaded.</Text>
                      )}
                    </>
                  )}
                  {/* Background transcription */}
                  {(!transcribeJob || transcribeJob.status === "none") && (
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={!projectId || images.length === 0 || isUploading}
                      onClick={() => setTranscribeDialogOpen(true)}
                    >
                      <RiFileEditFill /> Transcribe All
                    </Button>
                  )}
                  {transcribeJob?.status === "running" && (
                    <Stack spacing={1}>
                      <Text fontSize="xs" color="blue.600">Transcribing in background…</Text>
                      <Progress.Root value={transcribeJob.total_images > 0 ? Math.round((transcribeJob.current_image / transcribeJob.total_images) * 100) : 0} maxW="220px">
                        <HStack gap="3">
                          <Progress.Track flex="1"><Progress.Range /></Progress.Track>
                          <Progress.ValueText>{transcribeJob.current_image}/{transcribeJob.total_images || "?"}</Progress.ValueText>
                        </HStack>
                      </Progress.Root>
                      <Button size="xs" variant="subtle" colorPalette="red" onClick={handleCancelBatchTranscribe}>
                        <FaStop /> Stop
                      </Button>
                    </Stack>
                  )}
                  {transcribeJob?.status === "pending" && (
                    <Text fontSize="xs" color="gray.500">Transcription queued…</Text>
                  )}
                  {transcribeJob?.status === "failed" && (
                    <Stack spacing={1}>
                      <Text fontSize="xs" color="red.600">Transcription error: {transcribeJob.error_message}</Text>
                      <Button size="xs" variant="subtle" onClick={() => setTranscribeDialogOpen(true)}>
                        <RiFileEditFill /> Retry
                      </Button>
                    </Stack>
                  )}
                  {transcribeJob?.status === "cancelled" && (
                    <Stack spacing={1}>
                      <Text fontSize="xs" color="orange.600">Stopped at {transcribeJob.current_image}/{transcribeJob.total_images || "?"}.</Text>
                      <Button size="xs" variant="subtle" onClick={() => setTranscribeDialogOpen(true)}>
                        <RiFileEditFill /> Resume
                      </Button>
                    </Stack>
                  )}
                  {transcribeJob?.status === "completed" && (
                    <Stack spacing={1}>
                      <Text fontSize="xs" color="green.600">✓ All {transcribeJob.total_images} pages transcribed.</Text>
                      <Button size="xs" variant="subtle" onClick={() => setTranscribeDialogOpen(true)}>
                        <RiFileEditFill /> Transcribe Again
                      </Button>
                    </Stack>
                  )}
                  <Dialog.Root placement="center">
                    <Dialog.Trigger asChild>
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={!projectId || !selectedImage || isUploading}
                      >
                        <RiFileEditFill /> Transcribe One
                      </Button>
                    </Dialog.Trigger>
                    <Portal>
                      <Dialog.Backdrop />
                      <Dialog.Positioner>
                        <Dialog.Content>
                          <Transcribe
                            images={images}
                            projectId={projectId}
                            selectedImageId={selectedImage?.id}
                            startPage={1}
                            onClose={handleTranscribeClose}
                          />
                          <Dialog.CloseTrigger top="0" insetEnd="-12" asChild>
                            <CloseButton bg="bg" size="sm" />
                          </Dialog.CloseTrigger>
                        </Dialog.Content>
                      </Dialog.Positioner>
                    </Portal>
                  </Dialog.Root>
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => navigate("/table/" + projectId)}
                  >
                    <FaDownload />
                    Edit in table
                  </Button>
                  <Button
                    size="sm"
                    variant="subtle"
                    colorPalette="red"
                    onClick={handleDeleteAll}
                    disabled={!projectId}
                  >
                    <FaRegTrashAlt /> Delete All Images
                  </Button>
                </Stack>
              )}
            </Accordion.ItemBody>
          </Accordion.ItemContent>
        </Accordion.Item>

        <Accordion.Item value="transcription">
          <Accordion.ItemTrigger>
            <Text fontWeight="bold">Transcription</Text>
            <Accordion.ItemIndicator />
          </Accordion.ItemTrigger>
          <Accordion.ItemContent>
            <Accordion.ItemBody
              display="flex"
              flexDir="column"
              h="calc(100vh - 300px)"
            >
              <Stack>
                <TranscriptionEditor
                  transcriptionText={transcriptionText}
                  setTranscriptionText={setTranscriptionText}
                  selectedImage={selectedImage}
                  handleTranscriptionUpdate={handleTranscriptionUpdate}
                />
                <Popover.Root
                  open={isAIAutoFixOpen}
                  onOpenChange={(e) => setIsAIAutoFixOpen(e.open)}
                >
                  <Popover.Trigger asChild>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={!selectedImage}
                      onClick={() => setIsAIAutoFixOpen(true)}
                    >
                      <RiFileEditFill /> AI Auto Fix
                    </Button>
                  </Popover.Trigger>
                  <AIAutoFixModal
                    isOpen={isAIAutoFixOpen}
                    onClose={() => setIsAIAutoFixOpen(false)}
                    transcriptionText={transcriptionText}
                    selectedImage={selectedImage}
                    onSave={handleAIAutoFixSave}
                  />
                </Popover.Root>
              </Stack>
            </Accordion.ItemBody>
          </Accordion.ItemContent>
        </Accordion.Item>
      </Accordion.Root>
      {/* Background transcribe dialog */}
      <Dialog.Root
        open={transcribeDialogOpen}
        onOpenChange={(e) => setTranscribeDialogOpen(e.open)}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Transcribe All Images</Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body>
                <Stack spacing={5}>
                  <Text fontSize="sm" color="gray.600">
                    Runs server-side for all {images.length} image(s). You can
                    close the browser — the job continues in the background.
                  </Text>
                  <Stack spacing={2}>
                    <Text fontWeight="bold">Model</Text>
                    <Select.Root
                      collection={transcribeModels}
                      value={[transcribeModel]}
                      onValueChange={(d) => setTranscribeModel(d.value[0])}
                    >
                      <Select.HiddenSelect />
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select model" />
                        </Select.Trigger>
                        <Select.IndicatorGroup>
                          <Select.Indicator />
                        </Select.IndicatorGroup>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {transcribeModels.items.map((item) => (
                            <Select.Item item={item} key={item.value}>
                              {item.label}
                              <Select.ItemIndicator />
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </Stack>
                  <Stack spacing={2}>
                    <Text fontWeight="bold">Mode</Text>
                    <RadioGroup.Root
                      value={transcribeMode}
                      onValueChange={(d) => setTranscribeMode(d.value)}
                    >
                      <Stack spacing={2}>
                        <HStack>
                          <RadioGroup.Item value="skip">
                            <RadioGroup.ItemHiddenInput />
                            <RadioGroup.ItemIndicator />
                            <RadioGroup.ItemText>Skip already transcribed pages</RadioGroup.ItemText>
                          </RadioGroup.Item>
                        </HStack>
                        <HStack>
                          <RadioGroup.Item value="continue">
                            <RadioGroup.ItemHiddenInput />
                            <RadioGroup.ItemIndicator />
                            <RadioGroup.ItemText>Continue from first untranscribed page</RadioGroup.ItemText>
                          </RadioGroup.Item>
                        </HStack>
                        <HStack>
                          <RadioGroup.Item value="override">
                            <RadioGroup.ItemHiddenInput />
                            <RadioGroup.ItemIndicator />
                            <RadioGroup.ItemText>Override all (re-transcribe everything)</RadioGroup.ItemText>
                          </RadioGroup.Item>
                        </HStack>
                        <HStack>
                          <RadioGroup.Item value="range">
                            <RadioGroup.ItemHiddenInput />
                            <RadioGroup.ItemIndicator />
                            <RadioGroup.ItemText>Range (override only selected pages)</RadioGroup.ItemText>
                          </RadioGroup.Item>
                        </HStack>
                      </Stack>
                    </RadioGroup.Root>
                  </Stack>
                  {transcribeMode === "range" && (
                    <HStack align="end" spacing={3}>
                      <Box flex="1">
                        <Text fontWeight="bold">From</Text>
                        <Input
                          type="number"
                          min={1}
                          max={images.length || 1}
                          value={transcribeRangeFrom}
                          onChange={(e) => setTranscribeRangeFrom(e.target.value)}
                        />
                      </Box>
                      <Box flex="1">
                        <Text fontWeight="bold">To</Text>
                        <Input
                          type="number"
                          min={1}
                          max={images.length || 1}
                          value={transcribeRangeTo}
                          onChange={(e) => setTranscribeRangeTo(e.target.value)}
                        />
                      </Box>
                    </HStack>
                  )}
                  <Stack>
                      <Checkbox.Root checked={ignoreEdges} onCheckedChange={(e) => setIgnoreEdges(e.checked)}>
                          <Checkbox.HiddenInput />
                          <Checkbox.Control>
                              <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Checkbox.Label>Ignore short lines near borders (margin notes/noise)</Checkbox.Label>
                      </Checkbox.Root>
                  </Stack>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="outline" onClick={() => setTranscribeDialogOpen(false)}>Cancel</Button>
                <Button
                  colorPalette="purple"
                  loading={transcribeStarting}
                  onClick={handleStartBatchTranscribe}
                >
                  Start Transcription
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      {/* IIIF conflict dialog */}
      <Dialog.Root
        open={iiifConflict}
        onOpenChange={(e) => setIiifConflict(e.open)}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Project already has images</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>This project already has downloaded images. What would you like to do?</Text>
              </Dialog.Body>
              <Dialog.Footer gap={2}>
                <Button variant="outline" onClick={() => setIiifConflict(false)}>Cancel</Button>
                <Button variant="outline" onClick={() => { setIiifConflict(false); handleServerIiifDownload("append"); }}>
                  Append after existing
                </Button>
                <Button colorPalette="red" onClick={() => { setIiifConflict(false); handleServerIiifDownload("restart"); }}>
                  Restart from page 1
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      {isIiifDownloaderOpen && (
        <IiifDownloader
          iiifUrl={project.iiif_url}
          projectId={projectId}
          startPage={images.length + 1}
          open={isIiifDownloaderOpen}
          onOpenChange={(e) => setIsIiifDownloaderOpen(e.open)}
          onClose={handleIiifDownloaderClose}
        />
      )}
    </Box>
  );
};

export default Sidebar;
