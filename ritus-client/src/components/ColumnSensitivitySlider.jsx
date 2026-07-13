import { Box, HStack, Slider, Text } from "@chakra-ui/react";

const ColumnSensitivitySlider = ({ sensitivity, onSensitivityChange, disabled = false }) => (
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
        <Slider.Label>Column detection sensitivity</Slider.Label>
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
      Higher sensitivity splits narrower gaps between columns; lower sensitivity requires a wider gap.
    </Text>
  </Box>
);

export default ColumnSensitivitySlider;
