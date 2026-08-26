/*
TITLE: ECatalogusUploadDialog.jsx
DESCRIPTION: "Send to eCatalogus" dialog for the table editor. Picks an
  eCatalogus instance, confirms who the user is there, lists the manuscripts
  that can receive content (with the number of records each already holds),
  then maps the table and imports it in bulk, reporting progress and every
  rejected value.
DEPENDENCIES:
  - ../utils/ecatalogus (API client and ContentStructure -> eCatalogus mapping)
NOTES:
  - Credentials are held in component state only, exactly as the integration
    guide asks: nothing goes to localStorage or to the ritus server. They are
    cleared when the dialog closes or the instance changes.
  - Upload runs dry_run first. The endpoint validates the whole payload before
    writing a single row, so a dry run turns a rejected import into a complete
    list of corrections at the cost of one extra request.
USAGE:
  <ECatalogusUploadDialog rows={data} disabled={structureKey !== "content"} />
*/

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Progress,
  RadioGroup,
  Select,
  Separator,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { BsCloudArrowUpFill } from "react-icons/bs";
import { toaster } from "@/components/ui/toaster";
import {
  ECATALOGUS_INSTANCES,
  bulkImport,
  buildAuthHeader,
  contentSummary,
  fetchInstanceInfo,
  isErrorListTruncated,
  listManuscripts,
  loadRuntimeIndex,
  mapRowsForUpload,
  MUSIC_NOTATION_FIELD,
  normalizeServerErrors,
  requiredIndexes,
  stripField,
  whoami,
} from "../utils/ecatalogus";

const instanceCollection = createListCollection({ items: ECATALOGUS_INSTANCES });

// Share of the progress bar given to each phase of an upload. Reading the local
// dictionaries is now a few hundred KB from ritus's own origin rather than a
// download from the instance, so it barely registers.
const DICTIONARY_SHARE = 15;
const DRY_RUN_SHARE = 40;

const rowHasContent = (row) =>
  Object.entries(row).some(
    ([key, value]) =>
      !["_internalId", "id", "manuscript_id", "entry_date"].includes(key) &&
      value !== "" &&
      value != null &&
      !(typeof value === "string" && value.trim() === "")
  );

const ECatalogusUploadDialog = ({ rows = [], disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(ECATALOGUS_INSTANCES[0].value);

  const [instanceInfo, setInstanceInfo] = useState(null);
  const [instanceError, setInstanceError] = useState(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [auth, setAuth] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [manuscripts, setManuscripts] = useState([]);
  const [manuscriptCount, setManuscriptCount] = useState(0);
  const [search, setSearch] = useState("");
  const [manuscriptsBusy, setManuscriptsBusy] = useState(false);
  const [manuscriptsError, setManuscriptsError] = useState(null);
  const [selectedUuid, setSelectedUuid] = useState(null);

  const [mode, setMode] = useState("append");

  const [stage, setStage] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [errors, setErrors] = useState([]);
  const [errorsTruncated, setErrorsTruncated] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [result, setResult] = useState(null);

  const abortRef = useRef(null);
  const contentRef = useRef(null);

  const payloadRows = rows.filter(rowHasContent);
  const selected = manuscripts.find((item) => item.uuid === selectedUuid) || null;
  const busy = stage === "dictionaries" || stage === "validating" || stage === "uploading";

  const resetUploadState = useCallback(() => {
    setStage("idle");
    setProgress(0);
    setProgressLabel("");
    setErrors([]);
    setErrorsTruncated(false);
    setWarnings([]);
    setResult(null);
  }, []);

  // Everything below the instance picker belongs to one instance - drop it all
  // when another is chosen, credentials included.
  const resetInstanceState = useCallback(() => {
    setInstanceInfo(null);
    setInstanceError(null);
    setAuth(null);
    setIdentity(null);
    setAuthError(null);
    setPassword("");
    setManuscripts([]);
    setManuscriptCount(0);
    setManuscriptsError(null);
    setSelectedUuid(null);
    resetUploadState();
  }, [resetUploadState]);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();

    fetchInstanceInfo(baseUrl, controller.signal)
      .then(setInstanceInfo)
      .catch((error) => {
        if (error.name !== "AbortError") setInstanceError(error.message);
      });

    return () => controller.abort();
  }, [open, baseUrl]);

  // Reload the manuscript list on every instance change and on every change to
  // the search box, debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setManuscriptsBusy(true);
      setManuscriptsError(null);
      try {
        const { count, results } = await listManuscripts(baseUrl, {
          search,
          signal: controller.signal,
        });
        setManuscriptCount(count);
        setManuscripts(results);
      } catch (error) {
        if (error.name !== "AbortError") {
          setManuscripts([]);
          setManuscriptsError(error.message);
        }
      } finally {
        if (!controller.signal.aborted) setManuscriptsBusy(false);
      }
    }, search ? 350 : 0);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, baseUrl, search]);

  const handleInstanceChange = (next) => {
    if (next === baseUrl) return;
    resetInstanceState();
    setSearch("");
    setBaseUrl(next);
  };

  const handleLogIn = async () => {
    setAuthBusy(true);
    setAuthError(null);
    const header = buildAuthHeader(username, password);
    try {
      const who = await whoami(baseUrl, header);
      setIdentity(who);
      setAuth(header);
      if (!who.can_import) {
        setAuthError(
          `${who.username} is signed in but may not import. Ask the eCatalogus ` +
            "administrator to add the account to the api_importers group."
        );
      }
    } catch (error) {
      setIdentity(null);
      setAuth(null);
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogOut = () => {
    setAuth(null);
    setIdentity(null);
    setAuthError(null);
    setPassword("");
  };

  const handleUpload = async () => {
    if (!selected || !auth) return;
    resetUploadState();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      /* 1. Read the local dictionaries - ritus's own origin, not the instance.
            Only formulas, rite names and text standarization ever need one;
            everything else travels as a name the importer resolves itself. */
      setStage("dictionaries");
      const slugs = requiredIndexes(payloadRows);
      const indexes = {};
      for (const [index, slug] of slugs.entries()) {
        setProgressLabel(`Reading the local ${slug} dictionary`);
        indexes[slug] = await loadRuntimeIndex(slug, controller.signal);
        setProgress(((index + 1) / slugs.length) * DICTIONARY_SHARE);
      }
      setProgress(DICTIONARY_SHARE);

      /* 2. Map the table, and stop here if a value has no counterpart. */
      setProgressLabel("Matching table values");
      const mapped = mapRowsForUpload(payloadRows, indexes);
      setWarnings(mapped.warnings);
      if (mapped.errors.length > 0) {
        setErrors(mapped.errors);
        setStage("error");
        return;
      }

      /* 3. Let eCatalogus validate the whole payload before anything is
            written. One request reports every problem at once. */
      setStage("validating");
      setProgressLabel(`Validating ${mapped.items.length} rows in eCatalogus`);
      setProgress(DICTIONARY_SHARE + DRY_RUN_SHARE / 2);

      let items = mapped.items;
      const validate = (candidate) =>
        bulkImport(
          baseUrl,
          selected.uuid,
          { items: candidate, mode, dry_run: true },
          auth,
          controller.signal
        );

      try {
        await validate(items);
      } catch (error) {
        let serverErrors = normalizeServerErrors(error.payload);

        /* A notation the target manuscript has no described block for is not
           something the uploader can correct - it means nobody has described
           that manuscript's notation in eCatalogus yet. Drop the field and
           revalidate rather than failing every other row over it. */
        const onlyNotation =
          serverErrors.length > 0 &&
          serverErrors.every((problem) => problem.field === MUSIC_NOTATION_FIELD);

        if (onlyNotation) {
          const stripped = stripField(items, MUSIC_NOTATION_FIELD);
          setProgressLabel("Retrying without the music notation column");
          try {
            await validate(stripped.items);
            items = stripped.items;
            serverErrors = [];
            setWarnings((current) => [
              ...current,
              {
                field: MUSIC_NOTATION_FIELD,
                value: "",
                count: stripped.removed,
                detail:
                  `${selected.name} has no notation described in eCatalogus for ` +
                  "these values, so the column was left out. Everything else was imported.",
              },
            ]);
          } catch (retryError) {
            serverErrors = normalizeServerErrors(retryError.payload);
          }
        }

        if (serverErrors.length > 0) {
          setErrors(serverErrors);
          setErrorsTruncated(isErrorListTruncated(serverErrors));
          setStage("error");
          return;
        }
        if (!onlyNotation) {
          setErrors([{ row: null, field: null, value: null, detail: error.message }]);
          setStage("error");
          return;
        }
      }
      setProgress(DICTIONARY_SHARE + DRY_RUN_SHARE);

      /* 4. Import for real. One transaction: all rows land, or none do. */
      setStage("uploading");
      setProgressLabel(`Importing ${items.length} rows`);
      const imported = await bulkImport(
        baseUrl,
        selected.uuid,
        { items, mode },
        auth,
        controller.signal
      );

      setProgress(100);
      setProgressLabel("");
      setResult(imported);
      setStage("done");
      toaster.create({
        title: "Sent to eCatalogus",
        description: `${imported.created} rows imported into ${selected.name}.`,
        type: "success",
        duration: 5000,
      });

      // The list still shows the pre-upload content_count for this manuscript.
      const refreshed = await contentSummary(baseUrl, selected.uuid).catch(() => null);
      if (refreshed) {
        setManuscripts((current) =>
          current.map((item) =>
            item.uuid === selected.uuid
              ? { ...item, content_count: refreshed.content_count }
              : item
          )
        );
      }
    } catch (error) {
      if (error.name === "AbortError") {
        resetUploadState();
        return;
      }
      setErrors([{ row: null, field: null, value: null, detail: error.message }]);
      setStage("error");
    } finally {
      abortRef.current = null;
    }
  };

  const handleOpenChange = (event) => {
    if (!event.open && busy) return;
    if (!event.open) {
      abortRef.current?.abort();
      resetInstanceState();
      setUsername("");
    }
    setOpen(event.open);
  };

  const canUpload = Boolean(
    auth && identity?.can_import && selected && payloadRows.length > 0 && !busy
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={handleOpenChange}
      placement="center"
      motionPreset="slide-in-bottom"
      size="lg"
      unmountOnExit
    >
      <Dialog.Trigger asChild>
        <Button
          colorPalette="teal"
          disabled={disabled}
          title={
            disabled
              ? "Available for the eCatalogus table structure only"
              : "Upload this table into a manuscript in eCatalogus"
          }
        >
          <BsCloudArrowUpFill />
          Send to eCatalogus
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content ref={contentRef} maxH="85vh" overflowY="auto">
            <Dialog.Header>
              <Dialog.Title>Send to eCatalogus</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={5}>
                {/* ---------------- instance ---------------- */}
                <Field.Root>
                  <Field.Label>eCatalogus instance</Field.Label>
                  <Select.Root
                    collection={instanceCollection}
                    value={[baseUrl]}
                    onValueChange={(details) => handleInstanceChange(details.value[0])}
                    disabled={busy}
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
                    <Portal container={contentRef}>
                      <Select.Positioner>
                        <Select.Content>
                          {ECATALOGUS_INSTANCES.map((item) => (
                            <Select.Item item={item} key={item.value}>
                              {item.label}
                              <Select.ItemIndicator />
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Portal>
                  </Select.Root>
                  {instanceInfo && (
                    <Field.HelperText>
                      Connected to {instanceInfo.site_name} (API {instanceInfo.api_version}).
                    </Field.HelperText>
                  )}
                </Field.Root>

                {instanceError && (
                  <Alert.Root status="error">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>This instance is unreachable from the browser</Alert.Title>
                      <Alert.Description>{instanceError}</Alert.Description>
                    </Alert.Content>
                  </Alert.Root>
                )}

                <Separator />

                {/* ---------------- identity ---------------- */}
                {identity?.authenticated ? (
                  <VStack align="stretch" gap={2}>
                    <HStack>
                      <Badge colorPalette={identity.can_import ? "green" : "orange"}>
                        {identity.can_import ? "May import" : "No import rights"}
                      </Badge>
                      <Text>
                        Signed in as {identity.display_name || identity.username}.
                      </Text>
                      <Button size="xs" variant="outline" onClick={handleLogOut} disabled={busy}>
                        Sign out
                      </Button>
                    </HStack>
                    {authError && <Text color="orange.600">{authError}</Text>}
                  </VStack>
                ) : (
                  <VStack align="stretch" gap={3}>
                    <Text fontWeight="medium">Not signed in to this instance</Text>
                    <Text fontSize="sm" color="fg.muted">
                      Uploading needs an eCatalogus account in the api_importers group.
                      The password is kept in this page only, for the duration of the
                      upload, and is never stored.
                    </Text>
                    <HStack>
                      <Input
                        placeholder="eCatalogus username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="off"
                      />
                      <Input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && username && password) handleLogIn();
                        }}
                        autoComplete="off"
                      />
                      <Button
                        onClick={handleLogIn}
                        loading={authBusy}
                        disabled={!username || !password}
                      >
                        Sign in
                      </Button>
                    </HStack>
                    {authError && <Text color="red.500">{authError}</Text>}
                  </VStack>
                )}

                <Separator />

                {/* ---------------- manuscript ---------------- */}
                <VStack align="stretch" gap={2}>
                  <HStack justify="space-between">
                    <Text fontWeight="medium">Manuscript to upload into</Text>
                    {manuscriptsBusy && <Spinner size="sm" />}
                  </HStack>
                  <Input
                    placeholder="Search by name, shelf mark, RISM id..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    disabled={busy}
                  />
                  {manuscriptsError && <Text color="red.500">{manuscriptsError}</Text>}
                  <Box
                    borderWidth="1px"
                    borderRadius="md"
                    maxH="220px"
                    overflowY="auto"
                    p={1}
                  >
                    {manuscripts.length === 0 && !manuscriptsBusy ? (
                      <Text p={3} color="fg.muted">
                        {manuscriptsError
                          ? "Could not read the manuscript list."
                          : "No manuscripts on this instance match."}
                      </Text>
                    ) : (
                      <RadioGroup.Root
                        value={selectedUuid}
                        onValueChange={(details) => setSelectedUuid(details.value)}
                        disabled={busy}
                      >
                        <VStack align="stretch" gap={0}>
                          {manuscripts.map((item) => (
                            <RadioGroup.Item
                              key={item.uuid}
                              value={item.uuid}
                              px={2}
                              py={2}
                              borderRadius="sm"
                              _hover={{ bg: "bg.subtle" }}
                            >
                              <RadioGroup.ItemHiddenInput />
                              <RadioGroup.ItemIndicator />
                              <RadioGroup.ItemText>
                                <HStack gap={2} wrap="wrap">
                                  <Text>{item.name}</Text>
                                  {item.shelf_mark && (
                                    <Text fontSize="sm" color="fg.muted">
                                      {item.shelf_mark}
                                    </Text>
                                  )}
                                  {item.dating_label && (
                                    <Text fontSize="sm" color="fg.muted">
                                      {item.dating_label}
                                    </Text>
                                  )}
                                  <Badge
                                    colorPalette={item.content_count > 0 ? "orange" : "gray"}
                                  >
                                    {item.content_count > 0
                                      ? `${item.content_count} records`
                                      : "empty"}
                                  </Badge>
                                </HStack>
                              </RadioGroup.ItemText>
                            </RadioGroup.Item>
                          ))}
                        </VStack>
                      </RadioGroup.Root>
                    )}
                  </Box>
                  <Text fontSize="sm" color="fg.muted">
                    Showing {manuscripts.length} of {manuscriptCount} manuscripts.
                  </Text>
                </VStack>

                {/* ---------------- mode ---------------- */}
                {selected && selected.content_count > 0 && (
                  <Field.Root>
                    <Field.Label>
                      {selected.name} already holds {selected.content_count} records
                    </Field.Label>
                    <RadioGroup.Root
                      value={mode}
                      onValueChange={(details) => setMode(details.value)}
                      disabled={busy}
                    >
                      <HStack gap={6}>
                        <RadioGroup.Item value="append">
                          <RadioGroup.ItemHiddenInput />
                          <RadioGroup.ItemIndicator />
                          <RadioGroup.ItemText>Add to them</RadioGroup.ItemText>
                        </RadioGroup.Item>
                        <RadioGroup.Item value="replace">
                          <RadioGroup.ItemHiddenInput />
                          <RadioGroup.ItemIndicator />
                          <RadioGroup.ItemText>
                            Replace them with this table
                          </RadioGroup.ItemText>
                        </RadioGroup.Item>
                      </HStack>
                    </RadioGroup.Root>
                    {mode === "append" ? (
                      <Field.HelperText>
                        This table is added after the existing records. Rows without a
                        sequence number continue from {selected.content_count}.
                      </Field.HelperText>
                    ) : (
                      <Alert.Root status="warning" mt={2}>
                        <Alert.Indicator />
                        <Alert.Content>
                          <Alert.Title>
                            All {selected.content_count} existing records will be deleted
                          </Alert.Title>
                          <Alert.Description>
                            Replace removes the manuscript&rsquo;s entire content, not only
                            the rows this table overlaps, and puts these{" "}
                            {payloadRows.length} row{payloadRows.length === 1 ? "" : "s"} in
                            their place.
                          </Alert.Description>
                        </Alert.Content>
                      </Alert.Root>
                    )}
                  </Field.Root>
                )}

                {/* ---------------- progress ---------------- */}
                {busy && (
                  <Progress.Root value={progress} striped animated>
                    <HStack gap={4}>
                      <Progress.Label flexShrink={0}>{progressLabel}</Progress.Label>
                      <Progress.Track flex="1">
                        <Progress.Range />
                      </Progress.Track>
                      <Progress.ValueText>{Math.round(progress)}%</Progress.ValueText>
                    </HStack>
                  </Progress.Root>
                )}

                {/* ---------------- outcome ---------------- */}
                {stage === "done" && result && (
                  <Alert.Root status="success">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>
                        {result.created} rows imported into {selected?.name}
                      </Alert.Title>
                      <Alert.Description>
                        {result.deleted > 0
                          ? `${result.deleted} earlier rows were replaced. `
                          : ""}
                        Data in eCatalogus is published under CC BY 4.0.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert.Root>
                )}

                {errors.length > 0 && (
                  <Alert.Root status="error" alignItems="flex-start">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>
                        {errors.length} problem{errors.length === 1 ? "" : "s"} found -
                        nothing was imported
                      </Alert.Title>
                      {errorsTruncated && (
                        <Alert.Description mt={1}>
                          eCatalogus stops checking after 200 problems, so there are
                          probably more. Fix these, then validate again before assuming
                          the table is clean.
                        </Alert.Description>
                      )}
                      <Box as="ul" maxH="180px" overflowY="auto" mt={2} pl={4}>
                        {errors.map((error, index) => (
                          <Box as="li" key={index} fontSize="sm">
                            {error.row != null ? `row ${error.row + 1}: ` : ""}
                            {error.field ? `${error.field} - ` : ""}
                            {error.detail}
                          </Box>
                        ))}
                      </Box>
                    </Alert.Content>
                  </Alert.Root>
                )}

                {warnings.length > 0 && (
                  <Alert.Root status="warning" alignItems="flex-start">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>Some values were left out of the upload</Alert.Title>
                      <Box as="ul" maxH="140px" overflowY="auto" mt={2} pl={4}>
                        {warnings.map((warning, index) => (
                          <Box as="li" key={index} fontSize="sm">
                            {warning.field} = &quot;{warning.value}&quot; in {warning.count}{" "}
                            row{warning.count === 1 ? "" : "s"} - {warning.detail}
                          </Box>
                        ))}
                      </Box>
                    </Alert.Content>
                  </Alert.Root>
                )}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Text flex="1" fontSize="sm" color="fg.muted">
                {payloadRows.length} row{payloadRows.length === 1 ? "" : "s"} ready to send
              </Text>
              {busy ? (
                <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </Button>
              ) : (
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Close</Button>
                </Dialog.ActionTrigger>
              )}
              <Button colorPalette="teal" onClick={handleUpload} disabled={!canUpload}>
                Upload
              </Button>
            </Dialog.Footer>

            <Dialog.CloseTrigger asChild disabled={busy}>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default ECatalogusUploadDialog;
