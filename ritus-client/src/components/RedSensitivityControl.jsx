import { Checkbox, Stack, Text } from "@chakra-ui/react";
import RedSensitivitySlider from "./RedSensitivitySlider";

// Red-ink sensitivity for a transcription run: either worked out per project
// (a manual level set on the project always wins) or one slider value for all.
const RedSensitivityControl = ({
  auto,
  onAutoChange,
  sensitivity,
  onSensitivityChange,
}) => (
  <Stack spacing={2}>
    <Checkbox.Root checked={auto} onCheckedChange={(e) => onAutoChange(!!e.checked)}>
      <Checkbox.HiddenInput />
      <Checkbox.Control>
        <Checkbox.Indicator />
      </Checkbox.Control>
      <Checkbox.Label>Automatically determine red level for each project</Checkbox.Label>
    </Checkbox.Root>
    {auto ? (
      <Text fontSize="xs" color="gray.600" pl="6">
        Sample pages from the middle of each manuscript are checked first, and
        the sensitivity is lowered until red covers a plausible share of the
        text. A level set by hand on a project is used as is.
      </Text>
    ) : (
      <RedSensitivitySlider
        sensitivity={sensitivity}
        onSensitivityChange={onSensitivityChange}
      />
    )}
  </Stack>
);

export default RedSensitivityControl;
