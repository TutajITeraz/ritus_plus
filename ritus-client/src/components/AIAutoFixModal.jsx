import { useState, useEffect, useRef } from "react";
import {
  Popover,
  Portal,
  PopoverPositioner,
  PopoverContent,
  PopoverCloseTrigger,
  PopoverArrow,
  PopoverArrowTip,
  PopoverTitle,
  PopoverBody,
  Stack,
  Text,
  Button,
  SkeletonText,
} from "@chakra-ui/react";
import { IoClose } from "react-icons/io5";
import { toaster } from "@/components/ui/toaster";
import { aiAutoFix } from "../apiUtils";
import TranscriptionEditor from "./TranscriptionEditor";

const AIAutoFixModal = ({
  isOpen,
  onClose,
  transcriptionText,
  selectedImage,
  onSave,
}) => {
  const [aiFixedText, setAiFixedText] = useState("");
  const [waitingForAIAnswer, setWaitingForAIAnswer] = useState(false);
  const hasFetchedRef = useRef(false); // Prevent multiple API calls

  // Trigger AI auto fix when popover opens
  useEffect(() => {
    if (isOpen && selectedImage?.transcribed_text && !hasFetchedRef.current) {
      console.log("AI Auto Fix triggered:", {
        isOpen,
        transcriptionText,
        selectedImageId: selectedImage?.id,
        waitingForAIAnswer,
      });
      hasFetchedRef.current = true;
      setWaitingForAIAnswer(true);
      aiAutoFix(selectedImage.transcribed_text)
        .then((fixedText) => {
          console.log("AI Auto Fix success:", {
            fixedText,
            waitingForAIAnswer,
          });
          setAiFixedText(fixedText || "");
          setWaitingForAIAnswer(false);
        })
        .catch((error) => {
          console.error("AI Auto Fix error:", {
            error: error.message,
            waitingForAIAnswer,
          });
          setWaitingForAIAnswer(false);
          onClose();
          toaster.create({
            title: "AI Auto Fix Error",
            description: error.message || "Failed to process AI auto fix",
            type: "error",
            duration: 5000,
          });
        });
    }
  }, [isOpen, selectedImage, onClose]);

  // Reset hasFetchedRef when popover closes
  useEffect(() => {
    if (!isOpen) {
      hasFetchedRef.current = false;
      setAiFixedText("");
      setWaitingForAIAnswer(false);
      console.log("Popover closed, reset state:", {
        aiFixedText,
        waitingForAIAnswer,
        hasFetchedRef: hasFetchedRef.current,
      });
    }
  }, [isOpen]);

  const handleSave = () => {
    console.log("Saving AI-fixed text in modal:", { aiFixedText });
    onSave(aiFixedText);
    onClose();
  };

  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(e) => onClose()}
      positioning={{ placement: "right" }}
      lazyMount
      unmountOnExit
    >
      <PopoverPositioner>
        <PopoverContent maxW="500px" h="560px" borderRadius="md" boxShadow="lg">
          <PopoverCloseTrigger asChild>
            <Button
              position="absolute"
              top={2}
              right={2}
              size="sm"
              variant="ghost"
              onClick={onClose}
            >
              <IoClose />
            </Button>
          </PopoverCloseTrigger>
          <PopoverArrow>
            <PopoverArrowTip />
          </PopoverArrow>
          <PopoverTitle fontWeight="bold" p={4} pb={0}>
            Text Fixed by AI
          </PopoverTitle>
          <PopoverBody p={4} h="calc(560px - 48px)">
            <Stack direction="column" spacing={2}>
              {waitingForAIAnswer ? (
                <SkeletonText noOfLines={1} spacing="4" />
              ) : (
                <TranscriptionEditor
                  transcriptionText={aiFixedText}
                  setTranscriptionText={setAiFixedText}
                  selectedImage={selectedImage}
                  handleTranscriptionUpdate={handleSave}
                />
              )}
            </Stack>
          </PopoverBody>
        </PopoverContent>
      </PopoverPositioner>
    </Popover.Root>
  );
};

export default AIAutoFixModal;
