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
} from "@chakra-ui/react";
import { RiFileEditFill } from "react-icons/ri";
import { LuUpload } from "react-icons/lu";
import { FaRegTrashAlt, FaDownload } from "react-icons/fa";
import { useState, useEffect } from "react";
import {
  updateProject,
  updateImage,
  uploadImages,
  deleteImage,
  fetchImages,
} from "../apiUtils";
import { useNavigate } from "react-router-dom";
import { toaster } from "@/components/ui/toaster";
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
  const [isIiifDownloaderOpen, setIsIiifDownloaderOpen] = useState(false);
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
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("images", file));
    try {
      const data = await uploadImages(projectId, formData);
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
        width="100%"
        mb={4}
        cursor="pointer"
        onClick={() => navigate("/")}
      />
      <Link
        onClick={() => navigate("/")}
        color="blue.500"
        mb={4}
        display="block"
      >
        ⮨ Back to the Projects list
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
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={handleIiifDownload}
                    disabled={!project?.iiif_url || isUploading}
                  >
                    <FaDownload />
                    Download IIIF
                  </Button>
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
                      leftIcon={<RiFileEditFill />}
                      disabled={!selectedImage}
                      onClick={() => setIsAIAutoFixOpen(true)}
                    >
                      AI Auto Fix
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
