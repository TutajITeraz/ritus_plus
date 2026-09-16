import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CloseButton,
  Dialog,
  HStack,
  NumberInput,
  Portal,
  Progress,
  Select,
  Stack,
  Text,
  createListCollection,
} from "@chakra-ui/react";
import { FaStop, FaTable } from "react-icons/fa";
import { toaster } from "@/components/ui/toaster";
import {
  fetchImages,
  getBatchProcessStatus,
  saveProjectContent,
  startBatchProcess,
  cancelBatchProcess,
} from "../apiUtils";
import ContentStructure from "../utils/ContentStructure";
import { buildRowsFromTranscription } from "../utils/transcriptionRows";
import {
  autoPropagateRows,
  sequenceKeyOf,
  supportsAutoPropagate,
} from "../utils/tableRows";

const matchingMethods = createListCollection({
  items: [
    { label: "n-gram matcher (recommended)", value: "ngram" },
    { label: "legacy algorithm", value: "legacy" },
  ],
});

const POLL_INTERVAL_MS = 3000;

const IDLE_RUN = {
  active: false,
  index: 0,
  total: 0,
  projectName: "",
  step: "",
  stepProgress: null,
  done: [],
  skipped: [],
  failed: [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drop the table's client-side row identity before the rows go to the server,
// exactly as the table editor's Save to Server does.
const toContentRows = (rows) =>
  rows.map((row) => ({
    id: row.id,
    ...Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== "_internalId")
    ),
  }));

/**
 * ProcessTableDialog
 *
 * Runs, for every transcribed project, the same sequence a user would click
 * through in the table editor: Load Project Transcription → Auto Propagate →
 * Save to Server → Full Automatic Lookup and Split.
 *
 * The first three steps are client-side table operations, so the run is driven
 * from here rather than from the server: projects are processed one at a time
 * and the lookup step waits for the server's batch job to finish before the
 * next project starts. Closing the dialog leaves the run going; leaving the
 * page stops it after the project in flight.
 *
 * Props:
 *   ownedProjects   – the user's own projects
 *   sharedProjects  – projects shared with the user
 *   project         – single-project mode: process just this one project, with
 *                     a compact trigger meant for a project row. Takes the
 *                     place of ownedProjects/sharedProjects.
 *   onFinished      – called once the run ends, to refresh the projects list
 */
const ProcessTableDialog = ({
  ownedProjects,
  sharedProjects,
  project,
  onFinished,
}) => {
  const single = !!project;
  const [open, setOpen] = useState(false);
  const [skipWithData, setSkipWithData] = useState(true);
  const [skipShared, setSkipShared] = useState(true);
  const [autoPropagate, setAutoPropagate] = useState(true);
  const [fullLookup, setFullLookup] = useState(true);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.65);
  const [matchingMethod, setMatchingMethod] = useState("ngram");
  const [run, setRun] = useState(IDLE_RUN);
  const dialogContentRef = useRef(null);
  // Read inside the loop rather than through state, so a Stop lands on the
  // iteration in flight instead of the next render.
  const cancelRef = useRef(false);
  const runningProjectRef = useRef(null);

  // In single-project mode the user picked the project by clicking its own
  // button, so the skip options do not apply - it is always the one project.
  const candidates = single
    ? [project]
    : (skipShared
        ? ownedProjects || []
        : [...(ownedProjects || []), ...(sharedProjects || [])]
      ).filter((p) => (p.transcribed_count || 0) > 0);
  const withData = candidates.filter((p) => (p.content_count || 0) > 0);
  const eligible = single
    ? candidates
    : skipWithData
    ? candidates.filter((p) => (p.content_count || 0) === 0)
    : candidates;

  // A run outlives the dialog but not the page: warn before a reload throws
  // away the queue, and stop the loop when this component goes away.
  useEffect(() => {
    if (!run.active) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [run.active]);

  useEffect(() => () => {
    cancelRef.current = true;
  }, []);

  // Poll the server's batch job until it leaves "running". Returns the final
  // status, or null when the user stopped the run.
  const waitForBatchProcess = useCallback(async (projectId) => {
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      if (cancelRef.current) return null;
      let status;
      try {
        status = await getBatchProcessStatus(projectId, { silent: true });
      } catch {
        // A single failed poll (a restarted server, a blip) says nothing about
        // the job; keep polling and let the user stop the run if it is stuck.
        continue;
      }
      setRun((prev) =>
        prev.active ? { ...prev, stepProgress: status.progress || 0 } : prev
      );
      if (status.status === "running" || status.status === "pending") continue;
      return status;
    }
  }, []);

  const processProject = useCallback(
    async (project, position, total) => {
      const setStep = (step, stepProgress = null) =>
        setRun((prev) => ({
          ...prev,
          index: position,
          total,
          projectName: project.name,
          step,
          stepProgress,
        }));

      setStep("Loading transcription");
      const images = await fetchImages(project.id, { silent: true });
      let rows = buildRowsFromTranscription(images, ContentStructure);
      if (rows.length === 0) {
        return { outcome: "skipped", reason: "transcription produced no rows" };
      }

      if (autoPropagate && supportsAutoPropagate(ContentStructure)) {
        setStep("Auto propagate");
        rows = autoPropagateRows(
          rows,
          ContentStructure,
          sequenceKeyOf(ContentStructure)
        );
      }

      setStep("Saving to server");
      await saveProjectContent(project.id, toContentRows(rows), {
        silent: true,
      });
      if (cancelRef.current) return { outcome: "stopped" };

      if (fullLookup) {
        setStep("Full Automatic Lookup and Split", 0);
        await startBatchProcess(
          project.id,
          similarityThreshold,
          matchingMethod,
          { silent: true }
        );
        runningProjectRef.current = project.id;
        try {
          const status = await waitForBatchProcess(project.id);
          if (!status) return { outcome: "stopped" };
          if (status.status === "failed") {
            throw new Error(
              status.error_message || "Lookup and split failed on the server"
            );
          }
          if (status.status === "canceled") {
            return { outcome: "stopped" };
          }
        } finally {
          runningProjectRef.current = null;
        }
      }

      return { outcome: "done", rowCount: rows.length };
    },
    [
      autoPropagate,
      fullLookup,
      matchingMethod,
      similarityThreshold,
      waitForBatchProcess,
    ]
  );

  const handleStart = async () => {
    if (eligible.length === 0 || run.active) return;
    const queue = eligible;
    cancelRef.current = false;
    setRun({ ...IDLE_RUN, active: true, total: queue.length });

    const done = [];
    const skipped = [];
    const failed = [];

    for (let i = 0; i < queue.length; i++) {
      if (cancelRef.current) break;
      const project = queue[i];
      try {
        const result = await processProject(project, i, queue.length);
        if (result.outcome === "stopped") break;
        if (result.outcome === "skipped") {
          skipped.push({ name: project.name, reason: result.reason });
        } else {
          done.push({ name: project.name, rowCount: result.rowCount });
        }
      } catch (e) {
        failed.push({ name: project.name, error: e.message });
      }
      setRun((prev) => ({ ...prev, done, skipped, failed }));
    }

    const stopped = cancelRef.current;
    setRun({ ...IDLE_RUN, done, skipped, failed });

    if (failed.length > 0) {
      toaster.create({
        title: `Process Table: ${failed.length} project(s) failed`,
        description: failed.map((f) => `${f.name}: ${f.error}`).join("; "),
        type: "error",
        duration: 12000,
      });
    }
    if (skipped.length > 0) {
      toaster.create({
        title: `Skipped ${skipped.length} project(s)`,
        description: skipped.map((s) => `${s.name}: ${s.reason}`).join("; "),
        type: "info",
        duration: 8000,
      });
    }
    toaster.create({
      title: stopped ? "Process Table stopped" : "Process Table finished",
      description: `${done.length} project table(s) processed${
        stopped ? " before stopping" : ""
      }.`,
      type: stopped ? "warning" : "success",
      duration: 6000,
    });

    onFinished && onFinished();
  };

  const handleStop = async () => {
    cancelRef.current = true;
    const projectId = runningProjectRef.current;
    if (projectId) {
      // The lookup runs on the server, so stopping the loop is not enough -
      // the job keeps churning until it is cancelled too.
      try {
        await cancelBatchProcess(projectId);
      } catch (e) {
        console.error("Failed to cancel the running batch process:", e);
      }
    }
  };

  const progressPercent =
    run.total > 0 ? Math.round((run.index / run.total) * 100) : 0;

  const liveProgress = run.active && (
    <Stack spacing={1} minW={single ? "180px" : "280px"}>
      <Text fontSize="sm" color="blue.600">
        {single
          ? "Processing table"
          : `Processing table ${run.index + 1}/${run.total}: ${run.projectName}`}
      </Text>
      {/* One project has no queue to show, so the bar follows the server's
          lookup progress instead of the position in the queue. */}
      <Progress.Root
        value={single ? run.stepProgress ?? null : progressPercent}
        maxW={single ? "180px" : "280px"}
        size="sm"
      >
        <HStack gap="3">
          <Progress.Track flex="1">
            <Progress.Range />
          </Progress.Track>
          {!single && (
            <Progress.ValueText>
              {run.index}/{run.total}
            </Progress.ValueText>
          )}
        </HStack>
      </Progress.Root>
      <Text fontSize="xs" color="gray.600">
        {run.step}
        {run.stepProgress != null && ` — ${Math.round(run.stepProgress)}%`}
      </Text>
    </Stack>
  );

  return (
    <>
      {run.active ? (
        <HStack gap={2}>
          {/* The trigger button is gone while a run is on, so the progress
              itself reopens the dialog. */}
          <Box cursor="pointer" onClick={() => setOpen(true)}>
            {liveProgress}
          </Box>
          <Button size="xs" variant="subtle" colorPalette="red" onClick={handleStop}>
            <FaStop /> Stop
          </Button>
        </HStack>
      ) : (
        <Button
          variant={single ? "subtle" : "solid"}
          colorPalette="blue"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={single && (project.transcribed_count || 0) === 0}
        >
          <FaTable /> Process Table
        </Button>
      )}

      {/* Lazy: with a copy of this dialog on every project row, mounting all
          of their bodies up front is wasted work. */}
      <Dialog.Root
        open={open}
        onOpenChange={(e) => setOpen(e.open)}
        lazyMount
        unmountOnExit
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content ref={dialogContentRef}>
              <Dialog.Header>
                <Dialog.Title>
                  {single ? `Process Table: ${project.name}` : "Process Table"}
                </Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body>
                <Stack spacing={5}>
                  <Stack spacing={1}>
                    <Text fontSize="sm" color="gray.600">
                      {single
                        ? "This runs Load Project Transcription → Auto Propagate → Save to Server → Full Automatic Lookup and Split for this project."
                        : "For every transcribed project this runs Load Project Transcription → Auto Propagate → Save to Server → Full Automatic Lookup and Split, one project at a time."}
                    </Text>
                    {single ? (
                      <Text fontSize="sm" color="gray.600">
                        <strong>{project.name}</strong> —{" "}
                        {project.transcribed_count || 0} transcribed page(s),{" "}
                        {project.content_count || 0} row(s) in the table.
                      </Text>
                    ) : (
                      <Text fontSize="sm" color="gray.600">
                        <strong>{candidates.length}</strong> project(s) have a
                        transcription, of which{" "}
                        <strong>{withData.length}</strong> already have rows in
                        the table. This run will process{" "}
                        <strong>{eligible.length}</strong> of them.
                      </Text>
                    )}
                    <Text fontSize="xs" color="orange.600">
                      {single
                        ? "The project's existing table rows are replaced. Keep this tab open until it finishes."
                        : "Existing table rows of a processed project are replaced. Keep this tab open until the run finishes."}
                    </Text>
                  </Stack>

                  <Stack spacing={2}>
                    {!single && (
                      <>
                        <Checkbox.Root
                          checked={skipWithData}
                          disabled={run.active}
                          onCheckedChange={(e) => setSkipWithData(!!e.checked)}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Checkbox.Label>
                            Skip projects with data in table
                          </Checkbox.Label>
                        </Checkbox.Root>
                        <Checkbox.Root
                          checked={skipShared}
                          disabled={run.active}
                          onCheckedChange={(e) => setSkipShared(!!e.checked)}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Checkbox.Label>Skip shared projects</Checkbox.Label>
                        </Checkbox.Root>
                      </>
                    )}
                    <Checkbox.Root
                      checked={autoPropagate}
                      disabled={run.active}
                      onCheckedChange={(e) => setAutoPropagate(!!e.checked)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <Checkbox.Label>Auto propagate</Checkbox.Label>
                    </Checkbox.Root>
                    <Checkbox.Root
                      checked={fullLookup}
                      disabled={run.active}
                      onCheckedChange={(e) => setFullLookup(!!e.checked)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <Checkbox.Label>
                        Full Automatic Lookup and Split
                      </Checkbox.Label>
                    </Checkbox.Root>
                    <Text fontSize="xs" color="gray.600" pl="6">
                      Looks up both formulas and rite names. This is the slow
                      step — it can take many minutes per manuscript.
                    </Text>
                  </Stack>

                  {fullLookup && (
                    <Stack spacing={3}>
                      <Text fontWeight="bold">Matching method</Text>
                      <Select.Root
                        collection={matchingMethods}
                        value={[matchingMethod]}
                        onValueChange={(d) =>
                          setMatchingMethod(d.value[0] || "ngram")
                        }
                        disabled={run.active}
                        size="sm"
                      >
                        <Select.HiddenSelect />
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText />
                          </Select.Trigger>
                          <Select.IndicatorGroup>
                            <Select.Indicator />
                          </Select.IndicatorGroup>
                        </Select.Control>
                        {/* Same reason as in the table editor: the popover has
                            to live inside the dialog or it renders behind the
                            backdrop. */}
                        <Portal container={dialogContentRef}>
                          <Select.Positioner>
                            <Select.Content>
                              {matchingMethods.items.map((item) => (
                                <Select.Item item={item} key={item.value}>
                                  {item.label}
                                  <Select.ItemIndicator />
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Positioner>
                        </Portal>
                      </Select.Root>
                      <Text fontWeight="bold">Similarity threshold</Text>
                      {/* Percent-formatted: the value the input reports back
                          is the fraction, so the initial string it parses has
                          to be the percentage. */}
                      <NumberInput.Root
                        defaultValue={String(similarityThreshold * 100)}
                        step={0.01}
                        min={0}
                        max={1}
                        disabled={run.active}
                        onValueChange={(details) =>
                          setSimilarityThreshold(details.valueAsNumber)
                        }
                        formatOptions={{ style: "percent" }}
                      >
                        <NumberInput.Control />
                        <NumberInput.Input />
                      </NumberInput.Root>
                    </Stack>
                  )}

                  {run.active && liveProgress}
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Close
                </Button>
                {run.active ? (
                  <Button colorPalette="red" onClick={handleStop}>
                    <FaStop /> Stop
                  </Button>
                ) : (
                  <Button
                    colorPalette="blue"
                    onClick={() => {
                      setOpen(false);
                      handleStart();
                    }}
                    disabled={eligible.length === 0}
                  >
                    {single
                      ? "Process this project"
                      : `Process ${eligible.length} project(s)`}
                  </Button>
                )}
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
};

export default ProcessTableDialog;
