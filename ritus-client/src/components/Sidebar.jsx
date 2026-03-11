import {
  Dialog,
  CloseButton,
  Box,
  Flex,
  Text,
  Button,
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
} from "../apiUtils";
import { useNavigate } from "react-router-dom";
import { toaster } from "@/components/ui/toaster";
import { ProgressBar } from "@/components/ui/progress";
import IiifDownloader from "./IiifDownloader";
import Transcribe from "./Transcribe";
import TranscriptionEditor from "./TranscriptionEditor";
import AIAutoFixModal from "./AIAutoFixModal";

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

  console.log("Sidebar projectId:", projectId); // Debug log

  // Load initial IIIF job status + poll while running
  useEffect(() => {
    if (!projectId) return;
    getIiifDownloadStatus(projectId)
      .then((s) => setIiifJob(s.status !== "none" ? s : null))
      .catch(() => {});
  }, [projectId]);

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

  const handleTranscribeAll = () => {
    if (!projectId || images.length === 0) {
      toaster.create({
        title: "Transcription Error",
        description: "No images available to transcribe.",
        type: "error",
        duration: 5000,
      });
      return;
    }
  };

  const handleTranscribeOne = () => {
    if (!selectedImage) {
      toaster.create({
        title: "Transcription Error",
        description: "No image selected for transcription.",
        type: "error",
        duration: 5000,
      });
      return;
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
                  <Dialog.Root placement="center">
                    <Dialog.Trigger asChild>
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={
                          !projectId || images.length === 0 || isUploading
                        }
                      >
                        <RiFileEditFill /> Transcribe All
                      </Button>
                    </Dialog.Trigger>
                    <Portal>
                      <Dialog.Backdrop />
                      <Dialog.Positioner>
                        <Transcribe
                          images={images}
                          projectId={projectId}
                          selectedImageId={null}
                          startPage={1}
                          onClose={handleTranscribeClose}
                        />
                      </Dialog.Positioner>
                    </Portal>
                  </Dialog.Root>
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
