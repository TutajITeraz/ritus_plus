import { useEffect, useState } from "react";
import { Box, VStack, HStack, Text, Button, Input, Badge, Checkbox, Stack, Link, Table, Collapsible } from "@chakra-ui/react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { toaster } from "@/components/ui/toaster";
import {
  getClaudeSettings,
  setClaudeKey,
  deleteClaudeKey,
  setClaudeSharing,
  setClaudeCredit,
  resetClaudeUsage,
} from "../apiUtils";
import { setClaudeAvailable } from "../utils/claudeAvailability";

const fmtUsd = (v) => `$${Number(v ?? 0).toFixed(v >= 1 ? 2 : 4)}`;
const fmtInt = (v) => Number(v ?? 0).toLocaleString();

const notifyError = (error) =>
  toaster.create({ title: "Claude settings", description: error.message, type: "error", duration: 5000 });

/** Requests, tokens and cost for one period, split per model and (for the key's owner) per user. */
const UsagePeriod = ({ title, usage }) => {
  const rows = [
    ...(usage.by_model ?? []).map((m) => ({ key: `m-${m.model}`, name: m.label, ...m })),
    ...(usage.by_user ?? []).map((u) => ({ key: `u-${u.user_id}`, name: `User: ${u.username}`, ...u })),
  ];
  return (
    <Box>
      <Text fontWeight="bold" fontSize="sm" mb={1}>{title}</Text>
      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader />
            <Table.ColumnHeader textAlign="end">Requests</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Input tokens</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Output tokens</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Cost</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {[{ key: "total", name: "Total", bold: true, ...usage }, ...rows].map((r) => (
            <Table.Row key={r.key} fontWeight={r.bold ? "bold" : undefined}>
              <Table.Cell>{r.name}</Table.Cell>
              <Table.Cell textAlign="end">{fmtInt(r.requests)}</Table.Cell>
              <Table.Cell textAlign="end">{fmtInt(r.input_tokens)}</Table.Cell>
              <Table.Cell textAlign="end">{fmtInt(r.output_tokens)}</Table.Cell>
              <Table.Cell textAlign="end">{fmtUsd(r.cost_usd)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
};

/**
 * Settings panel for the Claude API: the user's own key (never shown again after
 * saving), who else may use it, the key currently in use with its usage (last
 * 24h and since the last reset, per model), and an estimate of the remaining
 * credit. Collapsed by default.
 *
 * Anthropic offers no API for the prepaid balance, so the credit figure is the
 * balance typed in from the Console minus what Ritus has spent since.
 */
const ClaudeSettings = () => {
  const [data, setData] = useState(null);
  const [keyInput, setKeyInput] = useState("");
  const [creditInput, setCreditInput] = useState("");
  const [shareAll, setShareAll] = useState(false);
  const [shareIds, setShareIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const apply = (settings) => {
    setData(settings);
    setClaudeAvailable(!!settings.active);
    setShareAll(!!settings.own_key?.share_with_all);
    setShareIds(settings.own_key?.shared_with ?? []);
  };

  const run = async (action, successMessage) => {
    setBusy(true);
    try {
      apply(await action());
      if (successMessage) toaster.create({ title: successMessage, type: "success", duration: 2500 });
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    getClaudeSettings().then(apply).catch(notifyError);
  }, []);

  if (!data) return null;

  const { own_key: ownKey, active, users, models } = data;
  const toggleUser = (id, checked) =>
    setShareIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  return (
    <Collapsible.Root open={open} onOpenChange={(e) => setOpen(e.open)} mt={8} maxW="720px">
      <Collapsible.Trigger asChild>
        <HStack as="button" cursor="pointer" mb={open ? 1 : 0} gap={2}>
          {open ? <LuChevronDown /> : <LuChevronRight />}
          <Text fontSize="xl" fontWeight="bold">Claude API (transcription)</Text>
          {ownKey ? <Badge colorPalette="green">key set</Badge> : active ? <Badge colorPalette="blue">shared key</Badge> : <Badge>no key</Badge>}
        </HStack>
      </Collapsible.Trigger>
      <Collapsible.Content>
      <Text fontSize="sm" color="gray.500" mb={4}>
        Lets you pick {models.map((m) => m.label).join(" or ")} as the transcription model. The API is billed
        separately from a Claude Pro/Max subscription: create a key and add credit in the{" "}
        <Link href="https://console.anthropic.com" target="_blank" rel="noreferrer" color="blue.500">
          Anthropic Console
        </Link>.
      </Text>

      {/* ---- own key ---- */}
      <Stack gap={2} mb={5}>
        <HStack>
          <Text fontWeight="bold" fontSize="sm">Your API key:</Text>
          {ownKey ? <Badge colorPalette="green">{ownKey.hint}</Badge> : <Badge>not set</Badge>}
        </HStack>
        <HStack>
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            placeholder={ownKey ? "Paste a new key to replace it" : "sk-ant-…"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <Button
            size="sm"
            colorPalette="blue"
            loading={busy}
            disabled={!keyInput.trim()}
            onClick={async () => {
              if (await run(() => setClaudeKey(keyInput.trim()), "API key saved")) setKeyInput("");
            }}
          >
            Save
          </Button>
          {ownKey && (
            <Button
              size="sm"
              variant="outline"
              colorPalette="red"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Remove your API key? Anyone you shared it with loses access, and its usage log is deleted."))
                  run(deleteClaudeKey, "API key removed");
              }}
            >
              Remove
            </Button>
          )}
        </HStack>
        <Text fontSize="xs" color="gray.500">
          The key is checked with Anthropic when saved, stored encrypted on the server and never sent back to the browser.
        </Text>
      </Stack>

      {/* ---- sharing ---- */}
      {ownKey && (
        <Stack gap={2} mb={5}>
          <Text fontWeight="bold" fontSize="sm">Share your key</Text>
          <Text fontSize="xs" color="gray.500">
            People you share it with transcribe at your expense. A user with their own key always uses that one first.
          </Text>
          <Checkbox.Root checked={shareAll} onCheckedChange={(e) => setShareAll(e.checked)}>
            <Checkbox.HiddenInput />
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <Checkbox.Label>All users</Checkbox.Label>
          </Checkbox.Root>
          {!shareAll && users.length > 0 && (
            <VStack align="start" gap={1} pl={1}>
              {users.map((u) => (
                <Checkbox.Root
                  key={u.id}
                  checked={shareIds.includes(u.id)}
                  onCheckedChange={(e) => toggleUser(u.id, e.checked)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                  <Checkbox.Label>{u.username}</Checkbox.Label>
                </Checkbox.Root>
              ))}
            </VStack>
          )}
          <Box>
            <Button
              size="sm"
              loading={busy}
              onClick={() => run(() => setClaudeSharing(shareAll, shareAll ? [] : shareIds), "Sharing updated")}
            >
              Save sharing
            </Button>
          </Box>
        </Stack>
      )}

      {/* ---- key in use: usage and credit ---- */}
      <Stack gap={2}>
        <Text fontWeight="bold" fontSize="sm">Key in use</Text>
        {!active ? (
          <Text fontSize="sm" color="gray.500">
            No key available to you yet. Add your own above, or ask a colleague to share theirs.
          </Text>
        ) : (
          <>
            <Text fontSize="sm">
              {active.source === "own" ? "Your own key" : `Shared by ${active.owner}`}
            </Text>
            <Stack borderWidth="1px" borderRadius="md" p={3} gap={4}>
              <UsagePeriod title="Last 24 hours" usage={active.usage_24h} />
              <UsagePeriod
                title={active.usage_since
                  ? `Total (since ${new Date(active.usage_since).toLocaleString()})`
                  : "Total"}
                usage={active.usage_total}
              />
              <HStack justify="space-between" align="start" gap={3}>
                <Text fontSize="xs" color="gray.500">
                  Counts only requests made through Ritus. Input tokens include cached ones. Cost is calculated from the
                  public per-token prices.
                </Text>
                {active.source === "own" && (
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette="red"
                    flexShrink={0}
                    disabled={busy || !active.usage_total.requests}
                    onClick={() => {
                      if (window.confirm("Reset the usage statistics of your key? The credit estimate is kept."))
                        run(resetClaudeUsage, "Usage reset");
                    }}
                  >
                    Reset usage
                  </Button>
                )}
              </HStack>
            </Stack>

            <Box borderWidth="1px" borderRadius="md" p={3}>
              <Text fontWeight="bold" fontSize="sm" mb={1}>Credit</Text>
              {active.credit ? (
                <Text fontSize="sm">
                  Estimated remaining: <b>{fmtUsd(active.credit.estimated_remaining_usd)}</b>
                  <Text as="span" fontSize="xs" color="gray.500">
                    {" "}({fmtUsd(active.credit.basis_usd)} entered on {new Date(active.credit.basis_at).toLocaleString()},
                    minus {fmtUsd(active.credit.spent_since_usd)} spent since)
                  </Text>
                </Text>
              ) : (
                <Text fontSize="sm" color="gray.500">
                  {active.source === "own" ? "Enter your balance below to track it." : "The key's owner has not entered a balance."}
                </Text>
              )}
              <Text fontSize="xs" color="gray.500" mt={1}>
                Anthropic does not expose the credit balance through its API, so this is an estimate. The exact figure is in
                Console → Billing.
              </Text>
              {active.source === "own" && (
                <HStack mt={2}>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    step={0.01}
                    w="160px"
                    placeholder="Balance now (USD)"
                    value={creditInput}
                    onChange={(e) => setCreditInput(e.target.value)}
                  />
                  <Button
                    size="sm"
                    loading={busy}
                    disabled={creditInput === ""}
                    onClick={async () => {
                      if (await run(() => setClaudeCredit(Number(creditInput)), "Balance saved")) setCreditInput("");
                    }}
                  >
                    Set balance
                  </Button>
                </HStack>
              )}
            </Box>
          </>
        )}
      </Stack>
      </Collapsible.Content>
    </Collapsible.Root>
  );
};

export default ClaudeSettings;
