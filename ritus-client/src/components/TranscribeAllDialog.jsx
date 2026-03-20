import { useState } from "react";
import {
  Button,
  Dialog,
  Portal,
  CloseButton,
  Stack,
  Text,
  Select,
  createListCollection,
  RadioGroup,
  HStack,
} from "@chakra-ui/react";
import { toaster } from "@/components/ui/toaster";
import { startBatchTranscribe } from "../apiUtils";

const models = createListCollection({
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

/**
 * TranscribeAllDialog
 *
 * Props:
 *   projects        – array of project objects with image_count > 0 (owned only)
 *   onJobsStarted   – callback after jobs are fired (receives array of project IDs)
 */
const TranscribeAllDialog = ({ projects, onJobsStarted }) => {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState("Tridis_Medieval_EarlyModern.mlmodel");
  const [mode, setMode] = useState("skip");
  const [isStarting, setIsStarting] = useState(false);

  const eligible = (projects || []).filter((p) => p.image_count > 0);

  const handleStart = async () => {
    if (eligible.length === 0) return;
    setIsStarting(true);
    const started = [];
    const failed = [];
    await Promise.all(
      eligible.map(async (p) => {
        try {
          await startBatchTranscribe(p.id, model, mode);
          started.push(p.id);
        } catch (e) {
          failed.push(p.name);
        }
      })
    );
    setIsStarting(false);
    setOpen(false);
    if (started.length > 0) {
      toaster.create({
        title: "Transcription started",
        description: `Started batch transcription for ${started.length} project(s). Runs in background.`,
        type: "success",
        duration: 4000,
      });
      onJobsStarted && onJobsStarted(started);
    }
    if (failed.length > 0) {
      toaster.create({
        title: "Some projects failed to start",
        description: failed.join(", "),
        type: "error",
        duration: 6000,
      });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => setOpen(e.open)}>
      <Dialog.Trigger asChild>
        <Button variant="solid" colorPalette="purple" size="sm">
          Transcribe All
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Transcribe All Projects</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body>
              <Stack spacing={5}>
                <Text fontSize="sm" color="gray.600">
                  Will start server-side transcription for{" "}
                  <strong>{eligible.length}</strong> project(s) with downloaded
                  images. You can close the browser — jobs continue in the
                  background.
                </Text>

                <Stack spacing={2}>
                  <Text fontWeight="bold">Model</Text>
                  <Select.Root
                    collection={models}
                    value={[model]}
                    onValueChange={(d) => setModel(d.value[0])}
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
                        {models.items.map((item) => (
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
                    value={mode}
                    onValueChange={(d) => setMode(d.value)}
                  >
                    <Stack spacing={2}>
                      <HStack>
                        <RadioGroup.Item value="skip">
                          <RadioGroup.ItemHiddenInput />
                          <RadioGroup.ItemIndicator />
                          <RadioGroup.ItemText>
                            Skip already transcribed pages (default)
                          </RadioGroup.ItemText>
                        </RadioGroup.Item>
                      </HStack>
                      <HStack>
                        <RadioGroup.Item value="continue">
                          <RadioGroup.ItemHiddenInput />
                          <RadioGroup.ItemIndicator />
                          <RadioGroup.ItemText>
                            Continue from first untranscribed page
                          </RadioGroup.ItemText>
                        </RadioGroup.Item>
                      </HStack>
                      <HStack>
                        <RadioGroup.Item value="override">
                          <RadioGroup.ItemHiddenInput />
                          <RadioGroup.ItemIndicator />
                          <RadioGroup.ItemText>
                            Override — re-transcribe everything
                          </RadioGroup.ItemText>
                        </RadioGroup.Item>
                      </HStack>
                    </Stack>
                  </RadioGroup.Root>
                </Stack>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                colorPalette="purple"
                onClick={handleStart}
                loading={isStarting}
                disabled={eligible.length === 0}
              >
                Start All ({eligible.length})
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default TranscribeAllDialog;
