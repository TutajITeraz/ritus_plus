// components/Controls.jsx
import { Button, HStack } from "@chakra-ui/react";
import { useTransformContext } from "react-zoom-pan-pinch";

const Controls = () => {
  const { zoomIn, zoomOut, resetTransform } = useTransformContext();
  return (
    <HStack position="absolute" top={2} right={2} zIndex={10}>
      <Button size="sm" onClick={() => zoomIn()}>+</Button>
      <Button size="sm" onClick={() => zoomOut()}>-</Button>
      <Button size="sm" onClick={() => resetTransform()}>Reset</Button>
    </HStack>
  );
};

export default Controls;