import { useState } from "react";
import { Button, CloseButton, Dialog, HStack, Portal, Stack, Text } from "@chakra-ui/react";
import RedSensitivitySlider from "./RedSensitivitySlider";
import { DEFAULT_RED_SENSITIVITY } from "../utils/redSensitivity";
import { setProjectRedSensitivity, calibrateProjectRedSensitivity } from "../apiUtils";
import { toaster } from "@/components/ui/toaster";

export const describeRedLevel = (project) => {
  if (project.red_sensitivity == null) return "auto (not determined yet)";
  const value = Math.round(project.red_sensitivity);
  return `${value}% (${project.red_sensitivity_source === "manual" ? "manual" : "auto"})`;
};

// Shows the project's red-detection level and lets the owner override it by
// hand or hand it back to automatic calibration.
const ProjectRedLevel = ({ project, onChanged, size = "xs", fontSize = "xs" }) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(DEFAULT_RED_SENSITIVITY);
  const [analyzing, setAnalyzing] = useState(false);

  const save = async (sensitivity) => {
    try {
      await setProjectRedSensitivity(project.id, sensitivity);
      setOpen(false);
      onChanged?.();
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    }
  };

  // Determine the level from sample pages; saved on the project straight away
  // as an automatic level, and shown on the slider so it can be fine-tuned.
  const analyze = async () => {
    setAnalyzing(true);
    try {
      const result = await calibrateProjectRedSensitivity(project.id);
      setValue(result.red_sensitivity);
      onChanged?.();
      toaster.create({
        title: "Red level determined",
        description: `Set to ${Math.round(result.red_sensitivity)}% (auto).`,
        type: "success",
        duration: 4000,
      });
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <HStack>
      <Text fontWeight="bold" fontSize={fontSize}>Red level:</Text>
      <Text fontSize={fontSize} color="gray.600">{describeRedLevel(project)}</Text>
      <Button
        size={size}
        variant="ghost"
        onClick={() => {
          setValue(project.red_sensitivity ?? DEFAULT_RED_SENSITIVITY);
          setOpen(true);
        }}
      >
        Edit
      </Button>
      <Dialog.Root open={open} onOpenChange={(e) => setOpen(e.open)} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Red level: {project.name}</Dialog.Title>
                <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body>
                <Stack spacing={3}>
                  <RedSensitivitySlider
                    sensitivity={value}
                    onSensitivityChange={setValue}
                    disabled={analyzing}
                    action={
                      <Button size="xs" variant="subtle" onClick={analyze} loading={analyzing}>
                        Analyze
                      </Button>
                    }
                  />
                  <Text fontSize="xs" color="gray.600">
                    Analyze checks sample pages from the middle of the manuscript and
                    saves the result as the automatic level. A manual level is used by every transcription of this project
                    that has "determine red level automatically" on. Reset to auto
                    to have it determined again on the next run.
                  </Text>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer gap={2}>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="outline" onClick={() => save(null)}>Reset to auto</Button>
                <Button colorPalette="purple" onClick={() => save(value)}>Save manual level</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </HStack>
  );
};

export default ProjectRedLevel;
