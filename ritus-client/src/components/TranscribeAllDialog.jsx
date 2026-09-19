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
  Checkbox,
} from "@chakra-ui/react";
import { toaster } from "@/components/ui/toaster";
import { startBatchTranscribeAll } from "../apiUtils";
import RedSensitivitySlider from "./RedSensitivitySlider";
import ColumnSensitivitySlider from "./ColumnSensitivitySlider";
import {
  DEFAULT_RED_SENSITIVITY,
  sensitivityToThreshold,
} from "../utils/redSensitivity";
import {
  DEFAULT_COLUMN_SENSITIVITY,
  sensitivityToColumnGapRatio,
} from "../utils/columnSensitivity";

const models = createListCollection({
  items: [
    { label: "Tridis Medieval EarlyModern", value: "Tridis_Medieval_EarlyModern.mlmodel" },
    { label: "Cremma Generic 1.0.1", value: "cremma-generic-1.0.1.mlmodel" },
    { label: "ManuMcFondue", value: "ManuMcFondue.mlmodel" },
    { label: "Catmus Medieval", value: "catmus-medieval.mlmodel" },
    { label: "CATMUS Print Model", value: "catmus-print-fondue-large.mlmodel" },
    { label: "McCATMuS (16th-21st c. Polyglot)", value: "McCATMuS_nfd_nofix_V1.mlmodel" },
    { label: "LECTAUREP (French Admin)", value: "lectaurep_base.mlmodel" },
    { label: "Lucien Peraire (French Handwriting)", value: "peraire2_ft_MMCFR.mlmodel" },
    { label: "German Handwriting", value: "german_handwriting.mlmodel" },
    { label: "Modern English Print", value: "en_best.mlmodel" },
    { label: "TrOCR Manicule (Latin Medieval HTR)", value: "TrOCR_Manicule_2026_Latin_Medieval" },
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
  const [model, setModel] = useState("TrOCR_Manicule_2026_Latin_Medieval");
  const [mode, setMode] = useState("skip");
  const [addPageBreak, setAddPageBreak] = useState(true);
  const [enhancedMultiColumn, setEnhancedMultiColumn] = useState(false);
  const [autofixErrors, setAutofixErrors] = useState(true);
  const [aiCorrect, setAiCorrect] = useState(false);
  const [redSensitivity, setRedSensitivity] = useState(DEFAULT_RED_SENSITIVITY);
  const [columnSensitivity, setColumnSensitivity] = useState(DEFAULT_COLUMN_SENSITIVITY);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const eligible = (projects || []).filter((p) => p.image_count > 0);
  // Fully transcribed = every downloaded page already has text. These are the
  // projects "override" exists for; in skip/continue they would be no-ops.
  const fullyTranscribed = eligible.filter(
    (p) => (p.transcribed_count || 0) >= p.image_count
  );
  const isOverride = mode === "override";
  // Override always re-does finished manuscripts - that is the whole point of
  // the mode, so the checkbox is forced on and disabled there.
  const effectiveIncludeCompleted = isOverride || includeCompleted;
  const willStartCount = effectiveIncludeCompleted
    ? eligible.length
    : eligible.length - fullyTranscribed.length;

  const handleStart = async () => {
    if (willStartCount === 0) return;
    setIsStarting(true);
    try {
      // One request for all projects. Firing one POST per project in parallel
      // used to overload SQLite and turn partial failures into a silent no-op.
      const result = await startBatchTranscribeAll({
        modelName: model,
        mode,
        ignoreEdges: true,
        addPageBreak,
        redThreshold: sensitivityToThreshold(redSensitivity),
        enhancedMultiColumn,
        columnGapRatio: sensitivityToColumnGapRatio(columnSensitivity),
        autofixErrors,
        aiCorrect,
        includeCompleted: effectiveIncludeCompleted,
      });
      setOpen(false);
      const started = result.started || [];
      const skipped = result.skipped || [];

      if (started.length > 0) {
        toaster.create({
          title: "Transcription started",
          description: `Started batch transcription for ${started.length} project(s). One project runs at a time; the rest wait in the queue.`,
          type: "success",
          duration: 5000,
        });
        onJobsStarted && onJobsStarted(started.map((p) => p.id));
      } else {
        toaster.create({
          title: "Nothing was started",
          description: skipped.length
            ? `All ${skipped.length} project(s) were skipped — see the reasons below.`
            : "No projects matched.",
          type: "warning",
          duration: 6000,
        });
      }

      if (skipped.length > 0) {
        // Report the server's actual reason per project rather than a bare
        // list of names, so a stuck or empty project is obvious.
        toaster.create({
          title: `Skipped ${skipped.length} project(s)`,
          description: skipped
            .map((p) => `${p.name}: ${p.reason}`)
            .join("; "),
          type: "info",
          duration: 10000,
        });
      }
    } catch (e) {
      toaster.create({
        title: "Could not start transcriptions",
        description: e.message,
        type: "error",
        duration: 8000,
      });
    } finally {
      setIsStarting(false);
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
                <Stack spacing={1}>
                  <Text fontSize="sm" color="gray.600">
                    <strong>{eligible.length}</strong> project(s) have downloaded
                    images, of which <strong>{fullyTranscribed.length}</strong>{" "}
                    are already fully transcribed. This run will start{" "}
                    <strong>{willStartCount}</strong> of them. You can close the
                    browser — jobs continue in the background.
                  </Text>
                  <Text fontSize="xs" color="gray.500">
                    Projects are transcribed one at a time; the rest wait in the
                    queue. Use Stop All on the projects page to cancel everything.
                  </Text>
                </Stack>

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
                  {isOverride && (
                    <Text fontSize="xs" color="orange.600">
                      Existing transcriptions on every page of every project
                      will be replaced, including the {fullyTranscribed.length}{" "}
                      already-finished project(s).
                    </Text>
                  )}
                </Stack>

                <Stack>
                  <Checkbox.Root
                    checked={effectiveIncludeCompleted}
                    disabled={isOverride}
                    onCheckedChange={(e) => setIncludeCompleted(e.checked)}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Label>
                      Include projects that are already fully transcribed
                    </Checkbox.Label>
                  </Checkbox.Root>
                  <Text fontSize="xs" color="gray.600" pl="6">
                    {isOverride
                      ? "Always on in Override mode."
                      : "Off by default: in Skip and Continue mode a finished project has nothing left to do."}
                  </Text>
                </Stack>

                <Stack>
                  <Checkbox.Root checked={addPageBreak} onCheckedChange={(e) => setAddPageBreak(e.checked)}>
                    <Checkbox.HiddenInput />
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Label>Add a prayer separator ⏎ at the end of each page</Checkbox.Label>
                  </Checkbox.Root>
                </Stack>

                <Stack>
                  <Checkbox.Root checked={enhancedMultiColumn} onCheckedChange={(e) => setEnhancedMultiColumn(e.checked)}>
                    <Checkbox.HiddenInput />
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Label>Enhanced multi column detection</Checkbox.Label>
                  </Checkbox.Root>
                </Stack>

                {enhancedMultiColumn && (
                  <ColumnSensitivitySlider
                    sensitivity={columnSensitivity}
                    onSensitivityChange={setColumnSensitivity}
                  />
                )}

                <Stack>
                  <Checkbox.Root checked={autofixErrors} onCheckedChange={(e) => setAutofixErrors(e.checked)}>
                    <Checkbox.HiddenInput />
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Label>Automatically find and replace common mistakes</Checkbox.Label>
                  </Checkbox.Root>
                </Stack>

                <Stack>
                  <Checkbox.Root checked={aiCorrect} onCheckedChange={(e) => setAiCorrect(e.checked)}>
                    <Checkbox.HiddenInput />
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Label>Correct each page with AI</Checkbox.Label>
                  </Checkbox.Root>
                  <Text fontSize="xs" color="gray.600" pl="6">
                    Always runs find and replace first. Adds roughly 30s per page; if the
                    AI is unavailable the find/replace result is kept.
                  </Text>
                </Stack>

                <RedSensitivitySlider
                  sensitivity={redSensitivity}
                  onSensitivityChange={setRedSensitivity}
                />
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
                disabled={willStartCount === 0}
              >
                Start All ({willStartCount})
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default TranscribeAllDialog;
