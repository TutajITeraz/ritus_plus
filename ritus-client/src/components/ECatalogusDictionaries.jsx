/*
TITLE: ECatalogusDictionaries.jsx
DESCRIPTION: Admin panel for the eCatalogus controlled vocabularies. Shows what
  is cached and when it was pulled, and refreshes it on demand.
DEPENDENCIES:
  - ../apiUtils (fetchDictionaryStatus, refreshDictionaries)
NOTES:
  - A refresh is a full replace, never a merge: `?since=` cannot report a term
    withdrawn from a vocabulary, so a merge would keep deleted entries forever.
  - It is deliberately NOT wired to the upload dialog. An upload resolves
    against whatever cache is on disk, so a refresh must never start underneath
    one. This is an explicit admin action.
  - The pull writes nothing until every download has succeeded, so a failed or
    interrupted refresh leaves the previous dictionaries intact.
USAGE:
  <ECatalogusDictionaries />   // render only for admins
*/

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  HStack,
  Progress,
  Table,
  Text,
  VStack,
} from "@chakra-ui/react";
import { LuRefreshCw } from "react-icons/lu";
import { toaster } from "@/components/ui/toaster";
import { fetchDictionaryStatus, refreshDictionaries } from "../apiUtils";

const formatWhen = (iso) => {
  if (!iso) return "never";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

// Pulled straight from the sync step's output - the counts an editor actually
// wants ("5 new options added"), without making them read a console log.
const parseAdded = (output = "") => {
  const added = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s{6}(\S+\.(?:tsv|csv))\s+(\d+)\s+(\d+)\s*(.*)$/);
    if (match && Number(match[3]) > 0) {
      added.push({ file: match[1], count: Number(match[3]), examples: match[4].trim() });
    }
  }
  return added;
};

const ECatalogusDictionaries = () => {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchDictionaryStatus());
      setError(null);
    } catch (loadError) {
      setError(loadError.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const payload = await refreshDictionaries({});
      setStatus(payload.status);
      const added = parseAdded(
        payload.steps?.find((step) => step.step === "sync")?.output || ""
      );
      setResult({ changes: payload.changes || [], added });
      toaster.create({
        title: "Dictionaries refreshed",
        description: `${payload.status?.total_rows ?? 0} entries from eCatalogus.`,
        type: "success",
        duration: 5000,
      });
    } catch (refreshError) {
      setError(refreshError.message);
      toaster.create({
        title: "Refresh failed",
        description: refreshError.message,
        type: "error",
        duration: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box mt={8}>
      <Text fontSize="xl" fontWeight="bold" mb={4}>
        eCatalogus Dictionaries
      </Text>
      <Text fontSize="sm" color="gray.500" mb={4}>
        The controlled vocabularies used to send content to eCatalogus, and to fill
        the dropdowns in the table editor. Refreshing pulls them again from{" "}
        <strong>{status?.source || "ecatalogus.ispan.pl"}</strong> and adds any new
        terms to ritus&rsquo;s own dictionaries. It replaces the whole cache rather
        than merging, because a term withdrawn upstream cannot otherwise be noticed.
      </Text>

      <HStack mb={4} gap={4} wrap="wrap">
        <Button onClick={handleRefresh} loading={busy} colorPalette="blue">
          <LuRefreshCw />
          Refresh from eCatalogus
        </Button>
        <Text fontSize="sm" color="gray.500">
          Last refreshed: <strong>{formatWhen(status?.last_refreshed)}</strong>
          {status?.total_rows
            ? ` · ${status.count} dictionaries, ${status.total_rows.toLocaleString()} entries`
            : ""}
        </Text>
      </HStack>

      {busy && (
        <Progress.Root value={null} mb={4} maxW="lg">
          <HStack gap={4}>
            <Progress.Label flexShrink={0}>
              Downloading — about 9 MB, half a minute
            </Progress.Label>
            <Progress.Track flex="1">
              <Progress.Range />
            </Progress.Track>
          </HStack>
        </Progress.Root>
      )}

      {error && (
        <Alert.Root status="error" mb={4}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Refresh failed</Alert.Title>
            <Alert.Description>
              {error} The previous dictionaries are unchanged.
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      {result && (
        <Alert.Root
          status={result.added.length || result.changes.length ? "success" : "info"}
          mb={4}
          alignItems="flex-start"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {result.added.length || result.changes.length
                ? "Dictionaries updated"
                : "Already up to date"}
            </Alert.Title>
            <Alert.Description>
              {result.changes.length > 0 && (
                <Box as="ul" pl={4} mt={1}>
                  {result.changes.map((change) => (
                    <Box as="li" key={change.slug} fontSize="sm">
                      {change.slug}: {change.before} &rarr; {change.after} entries
                    </Box>
                  ))}
                </Box>
              )}
              {result.added.length > 0 ? (
                <>
                  <Text fontSize="sm" mt={2}>
                    New options now available in the table editor:
                  </Text>
                  <Box as="ul" pl={4}>
                    {result.added.map((entry) => (
                      <Box as="li" key={entry.file} fontSize="sm">
                        <strong>{entry.file}</strong>: {entry.count} new
                        {entry.examples ? ` — ${entry.examples}` : ""}
                      </Box>
                    ))}
                  </Box>
                  <Text fontSize="sm" mt={2} color="gray.500">
                    Reload the table editor to see them.
                  </Text>
                </>
              ) : (
                <Text fontSize="sm" mt={1}>
                  Nothing new — ritus already has every eCatalogus term it can use.
                </Text>
              )}
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      {status?.dictionaries?.length > 0 && (
        <Box maxH="320px" overflowY="auto" borderWidth="1px" borderRadius="md">
          <Table.Root size="sm" stickyHeader>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Dictionary</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Entries</Table.ColumnHeader>
                <Table.ColumnHeader>Pulled</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {status.dictionaries.map((entry) => (
                <Table.Row key={entry.slug}>
                  <Table.Cell>{entry.slug}</Table.Cell>
                  <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                    {(entry.rows || 0).toLocaleString()}
                  </Table.Cell>
                  <Table.Cell color="gray.500">{formatWhen(entry.fetched_at)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      )}

      {status && !status.dictionaries?.length && (
        <Alert.Root status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No dictionaries cached yet</Alert.Title>
            <Alert.Description>
              Press Refresh. Until then, sending content to eCatalogus cannot resolve
              formula or rubric references.
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <VStack align="start" mt={3} gap={1}>
        <Text fontSize="xs" color="gray.500">
          One dictionary stays manually maintained:{" "}
          <Badge size="xs">formulas.csv</Badge>. The table editor keys it by the
          ritus number, and eCatalogus's own numbering for formulas does not
          agree with ours — new formulas still need adding by hand.
        </Text>
      </VStack>
    </Box>
  );
};

export default ECatalogusDictionaries;
