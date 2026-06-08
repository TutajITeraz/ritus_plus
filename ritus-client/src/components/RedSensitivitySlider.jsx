import { Box, HStack, Slider, Text } from "@chakra-ui/react";

const RedSensitivitySlider = ({ sensitivity, onSensitivityChange, disabled = false }) => (
  <Box>
    <Slider.Root
      min={0}
      max={100}
      step={1}
      value={[sensitivity]}
      onValueChange={(e) => onSensitivityChange(e.value[0])}
      disabled={disabled}
    >
      <HStack justify="space-between">
        <Slider.Label>Red detection sensitivity</Slider.Label>
        <Text fontSize="sm" fontWeight="medium">
          {Math.round(sensitivity)}%
        </Text>
      </HStack>
      <Slider.Control>
        <Slider.Track>
          <Slider.Range />
        </Slider.Track>
        <Slider.Thumb index={0}>
          <Slider.HiddenInput />
        </Slider.Thumb>
      </Slider.Control>
    </Slider.Root>
    <Text fontSize="sm" color="gray.600" mt={1}>
      Higher sensitivity detects more red ink fragments.
    </Text>
  </Box>
);

export default RedSensitivitySlider;
