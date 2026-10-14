"use client";

import { useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  FileUpload,
  HStack,
  Icon,
  Progress,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { LuUpload } from "react-icons/lu";
import { toaster } from "@/components/ui/toaster";
import { SERVER_URL } from "../config";
import {
  createProject,
  setProjectPageList,
  appendProjectContent,
  startIiifDownload,
} from "../apiUtils";
import { CantusStructure_conv } from "./ConversionDescription";
import ContentStructure from "../utils/ContentStructure";
import { convertRows, createMappingFetcher } from "../utils/convertRows";
import {
  parseCantusExport,
  cantusRowsForSource,
  pagesForSource,
  pageTextsForSource,
  projectNameForSource,
} from "../utils/cantusImport";

const withoutInternalId = ({ _internalId, ...row }) => row;

// "Add Multiple Projects" -> From Cantus. One project per selected Cantus
// source: the chants become the table, the page images are downloaded by the
// server in the background (the same job as for IIIF projects, so they show
// progress on the project card).
const CantusImportPanel = ({ onProjectsCreated, onBusyChange, onClose }) => {
  const [parsed, setParsed] = useState(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [withTable, setWithTable] = useState(true);
  const [toContent, setToContent] = useState(false);
  const [withImages, setWithImages] = useState(true);
  const [withText, setWithText] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState("");
  const [failures, setFailures] = useState([]);
  const fetchMappingRef = useRef(createMappingFetcher());

  const sources = useMemo(
    () =>
      parsed
        ? parsed.sources.map((s) => ({
            ...s,
            chants: (parsed.chantsBySource.get(s.srcnid) || []).length,
            pages: pagesForSource(s).length,
          }))
        : [],
    [parsed]
  );

  const setBusy = (busy) => {
    setIsRunning(busy);
    if (onBusyChange) onBusyChange(busy);
  };

  const handleFile = async (files) => {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      const p = parseCantusExport(await files[0].text());
      setParsed(p);
      setFileName(files[0].name);
      // Sources that have something to import start selected.
      setSelected(
        new Set(
          p.sources
            .filter((s) => (p.chantsBySource.get(s.srcnid) || []).length > 0 || pagesForSource(s).length > 0)
            .map((s) => s.srcnid)
        )
      );
    } catch (e) {
      setParsed(null);
      setError(e.message);
    }
  };

  const toggle = (srcnid) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(srcnid) ? next.delete(srcnid) : next.add(srcnid);
      return next;
    });

  const selectWhere = (predicate) =>
    setSelected(new Set(sources.filter(predicate).map((s) => s.srcnid)));

  const allSelected = sources.length > 0 && sources.every((s) => selected.has(s.srcnid));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(sources.map((s) => s.srcnid)));

  const importOne = async (source) => {
    const chants = parsed.chantsBySource.get(source.srcnid) || [];
    const pages = withImages
      ? pagesForSource(source, withText ? pageTextsForSource(source, chants) : null)
      : [];
    const fillTable = withTable && chants.length > 0;

    const project = await createProject({
      name: projectNameForSource(source),
      type: pages.length > 0 ? "iiif" : "files",
      iiif_url: "",
      table_structure: fillTable && !toContent ? "cantus" : "content",
    });

    if (fillTable) {
      let rows = cantusRowsForSource(chants);
      if (toContent) {
        rows = await convertRows({
          sourceRows: rows,
          conversionMap: CantusStructure_conv,
          targetStructure: ContentStructure,
          targetStructureName: "ContentStructure",
          fetchMappingFile: fetchMappingRef.current,
        });
      }
      await appendProjectContent(project.id, rows.map(withoutInternalId));
    }

    if (pages.length > 0) {
      await setProjectPageList(project.id, pages);
      await startIiifDownload(project.id);
    }
  };

  const handleImport = async () => {
    const chosen = sources.filter((s) => selected.has(s.srcnid));
    if (chosen.length === 0) return;
    setBusy(true);
    setDone(0);
    setTotal(chosen.length);
    setFailures([]);
    const failed = [];
    let completed = 0;
    for (const source of chosen) {
      setCurrent(projectNameForSource(source));
      try {
        await importOne(source);
      } catch (e) {
        console.error("Cantus import failed for", source.siglum, e);
        // fetch() rejects with a TypeError when the server cannot be reached at
        // all. Every remaining source would fail the same way: stop and say so.
        if (e instanceof TypeError || e.message === "Failed to fetch") {
          failed.push(
            `Cannot reach the Ritus+ server at ${SERVER_URL}. Is it running? ` +
              `Import stopped after ${completed} of ${chosen.length} manuscripts.`
          );
          break;
        }
        failed.push(`${projectNameForSource(source)}: ${e.message}`);
      }
      completed += 1;
      setDone(completed);
    }
    setFailures(failed);
    setBusy(false);
    if (onProjectsCreated) onProjectsCreated();
    toaster.create({
      title: failed.length ? "Import finished with errors" : "Import finished",
      description:
        `Created ${chosen.length - failed.length} of ${chosen.length} projects` +
        (withImages && failed.length < chosen.length ? ". Page images are downloading in the background." : "."),
      type: failed.length ? "warning" : "success",
      duration: 6000,
    });
    if (failed.length === 0 && onClose) onClose();
  };

  const finished = total > 0 && !isRunning;
  const picking = parsed && !isRunning && !finished;
  const chosenPages = sources
    .filter((s) => selected.has(s.srcnid))
    .reduce((n, s) => n + s.pages, 0);

  return (
    <VStack align="stretch" gap={4}>
      {!parsed && (
        <>
          <FileUpload.Root maxW="xl" alignItems="stretch" accept={["application/json", ".json"]}>
            <FileUpload.HiddenInput onChange={(e) => handleFile(e.target.files)} />
            <FileUpload.Dropzone>
              <Icon size="md" color="fg.muted">
                <LuUpload />
              </Icon>
              <FileUpload.DropzoneContent>
                <div>Drag and drop the Cantus export here</div>
                <div style={{ color: "#718096" }}>cantus-ritus-export-….json</div>
              </FileUpload.DropzoneContent>
            </FileUpload.Dropzone>
          </FileUpload.Root>
          <Text fontSize="sm" color="gray.600">
            The file is made in the Cantus admin panel (Configuration → Content → Full export
            for Ritus+). Every selected manuscript becomes one project.
          </Text>
        </>
      )}

      {error && (
        <Box p={3} bg="red.50" borderRadius="md" borderLeft="4px solid" borderColor="red.500">
          <Text color="red.700" fontSize="sm">
            <strong>Error:</strong> {error}
          </Text>
        </Box>
      )}

      {picking && (
        <>
          <HStack gap={3} wrap="wrap">
            <Checkbox.Root
              checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
              onCheckedChange={toggleAll}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
            </Checkbox.Root>
            <Text fontSize="sm" fontWeight="bold">
              {selected.size} of {sources.length} selected
            </Text>
            <Text fontSize="sm" color="gray.600">
              Select:
            </Text>
            <Button size="xs" variant="outline" onClick={() => selectWhere((s) => s.pages > 0)}>
              With images
            </Button>
            <Button size="xs" variant="outline" onClick={() => selectWhere((s) => s.chants > 0)}>
              With chants
            </Button>
            <Text fontSize="xs" color="gray.500" ml="auto">
              {fileName} · exported {String(parsed.generated || "").slice(0, 10)}
            </Text>
          </HStack>

          <Box maxH="40vh" overflowY="auto" borderWidth="1px" borderRadius="md">
            {sources.map((s) => (
              <HStack
                key={s.srcnid}
                px={3}
                py={2}
                borderBottomWidth="1px"
                opacity={s.chants === 0 && s.pages === 0 ? 0.5 : 1}
              >
                <Checkbox.Root
                  checked={selected.has(s.srcnid)}
                  onCheckedChange={() => toggle(s.srcnid)}
                  flex="1"
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Checkbox.Label>
                    <Text fontSize="sm">{projectNameForSource(s)}</Text>
                    <Text fontSize="xs" color="gray.500">
                      {[s.archive, s.century].filter(Boolean).join(" · ")}
                    </Text>
                  </Checkbox.Label>
                </Checkbox.Root>
                <Text fontSize="xs" color="gray.600" minW="170px" textAlign="right">
                  {s.chants} chants · {s.pages} {s.pages === 1 ? "page" : "pages"}
                </Text>
              </HStack>
            ))}
          </Box>

          <VStack align="start" gap={2}>
            <Checkbox.Root checked={withTable} onCheckedChange={(e) => setWithTable(!!e.checked)}>
              <Checkbox.HiddenInput />
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Checkbox.Label>Fill the table with the chants (Cantus Index structure)</Checkbox.Label>
            </Checkbox.Root>
            <Checkbox.Root
              ml={6}
              checked={withTable && toContent}
              disabled={!withTable}
              onCheckedChange={(e) => setToContent(!!e.checked)}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Checkbox.Label>Convert all tables to eCatalogus Structure</Checkbox.Label>
            </Checkbox.Root>
            <Checkbox.Root checked={withImages} onCheckedChange={(e) => setWithImages(!!e.checked)}>
              <Checkbox.HiddenInput />
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Checkbox.Label>
                Download the page images (server, in the background, one at a time)
              </Checkbox.Label>
            </Checkbox.Root>
            <Checkbox.Root
              ml={6}
              checked={withImages && withText}
              disabled={!withImages}
              onCheckedChange={(e) => setWithText(!!e.checked)}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Checkbox.Label>Fill each page's transcription text with its chants</Checkbox.Label>
            </Checkbox.Root>
          </VStack>
        </>
      )}

      {isRunning && (
        <VStack colorPalette="teal" width="full">
          <Spinner color="colorPalette.600" />
          <Text color="colorPalette.600" fontSize="sm">
            Creating: {current}
          </Text>
          <Progress.Root value={(done / Math.max(1, total)) * 100} width="full">
            <HStack gap="2" width="full">
              <Progress.Track flex="1">
                <Progress.Range />
              </Progress.Track>
              <Text fontSize="sm" minW="60px">
                {done}/{total}
              </Text>
            </HStack>
          </Progress.Root>
        </VStack>
      )}

      {failures.length > 0 && (
        <Box p={3} bg="red.50" borderRadius="md" borderLeft="4px solid" borderColor="red.500">
          <Text color="red.700" fontSize="sm" fontWeight="bold">
            {failures.length} failed:
          </Text>
          {failures.map((f) => (
            <Text key={f} color="red.700" fontSize="xs">
              {f}
            </Text>
          ))}
        </Box>
      )}

      <HStack justify="flex-end">
        {!isRunning && (
          <Button variant="outline" onClick={onClose}>
            {finished ? "Close" : "Cancel"}
          </Button>
        )}
        {picking && (
          <Button
            colorPalette="purple"
            onClick={handleImport}
            disabled={selected.size === 0 || (!withTable && !withImages)}
          >
            Import {selected.size} {selected.size === 1 ? "manuscript" : "manuscripts"}
            {withImages && chosenPages > 0 ? ` (${chosenPages} pages)` : ""}
          </Button>
        )}
      </HStack>
    </VStack>
  );
};

export default CantusImportPanel;
