import { Text } from "@chakra-ui/react";

// Shown in place of the line-pipeline options when a Claude model is picked.
const ClaudeModelNote = () => (
  <Text fontSize="sm" color="gray.600">
    Claude reads the whole page at once and marks rubrics, functions and prayer
    breaks itself, so edge, column, red-level and correction options do not apply.
  </Text>
);

export default ClaudeModelNote;
