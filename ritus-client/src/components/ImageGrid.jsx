"use client";

import { Box, Image, Badge, HStack, Button, Text } from "@chakra-ui/react";
import { LuTrash2 } from "react-icons/lu";
import { deleteImage } from "../apiUtils";

const ImageGrid = ({ images, setMainImage, mainImage, setImages }) => {
  const handleDeleteImage = async (imageId) => {
    await deleteImage(imageId);
    setImages(images.filter((img) => img.id !== imageId));
    if (mainImage === images.find((img) => img.id === imageId)?.original) {
      setMainImage(images.length > 1 ? images[0].original : null);
    }
  };

  return (
    <Box
      h="170px"
      overflowY="hidden"
      overflowX="auto"
      bg="white"
      borderRadius="md"
      boxShadow="md"
      p={2}
      position="absolute"
      bottom={0}
      left={0}
      right={0}
      m={4}
    >
      <HStack spacing={4} pb={2} h="100%" minW="fit-content">
        {images.map((img) => (
          <Box key={img.id} flexShrink={0}>
            <Image
              src={img.thumbnail}
              alt={img.name}
              borderRadius="md"
              cursor="pointer"
              onClick={() => setMainImage(img.original)}
              objectFit="cover"
              h="120px"
              w="180px"
              border={mainImage === img.original ? "4px solid" : "2px solid"}
              borderColor={
                mainImage === img.original ? "blue.500" : "transparent"
              }
            />
            <HStack mt={1} justify="space-between">
              <Text fontSize="s">{img.name}</Text>
              <HStack>
                {img.enhanced && <Badge colorScheme="green">Enhanced</Badge>}
                {img.transcribed_text && (
                  <Badge colorPalette="blue">
                    {img.line_count} {img.line_count === 1 ? "line" : "lines"}
                  </Badge>
                )}
                <Button
                  size="xs"
                  variant="subtle"
                  colorPalette="red"
                  onClick={() => handleDeleteImage(img.id)}
                >
                  <LuTrash2 />
                </Button>
              </HStack>
            </HStack>
          </Box>
        ))}
      </HStack>
    </Box>
  );
};

export default ImageGrid;
