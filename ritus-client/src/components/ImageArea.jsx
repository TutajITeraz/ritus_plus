// components/ImageArea.jsx
import { useState, useEffect } from "react";
import {
  Box,
  Button,
  Center,
  HStack,
  Text,
} from "@chakra-ui/react";
import { FaDownload } from "react-icons/fa"; // Updated icon
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import ImageGrid from "./ImageGrid";
import Controls from "./Controls";
import { fetchImages } from "../apiUtils";

const ImageArea = ({ images, setImages, mainImage, setMainImage, projectId }) => {
  useEffect(() => {
    const loadImages = async () => {
      try {
        const fetchedImages = await fetchImages(projectId);
        setImages(fetchedImages);
        if (fetchedImages.length > 0 && !mainImage) {
          setMainImage(fetchedImages[0].original);
        }
      } catch (error) {
        console.error("Failed to load images:", error);
      }
    };

    loadImages();
  }, [projectId, images.length, setImages, setMainImage, mainImage]);

  return (
    <Box flex="1" p={4} position="relative" display="flex" flexDirection="column" h="100%">
      <Box
        flex="1"
        position="relative"
        bg="white"
        borderRadius="md"
        boxShadow="md"
        mb="180px"
        overflow="hidden"
      >
        {mainImage ? (
          <Box position="relative" h="100%" w="100%">
            <TransformWrapper initialScale={1} initialPositionX={0} initialPositionY={0} minScale={0.1}>
              <Controls />
              <TransformComponent wrapperStyle={{ height: "100%", width: "100%" }}>
                <img
                  src={mainImage}
                  alt="Main Image"
                  style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }}
                />
              </TransformComponent>
            </TransformWrapper>
            <Box position="absolute" bottom={2} right={2} zIndex={10}>
              <HStack>
                <Button
                  size="sm"
                  m={1}
                  variant="subtle"
                  leftIcon={<FaDownload />}
                  onClick={() => window.open(mainImage)}
                >
                  Download
                </Button>
              </HStack>
            </Box>
          </Box>
        ) : (
          <Center h="100%">
            <Text>No image selected</Text>
          </Center>
        )}
      </Box>
      <ImageGrid images={images} setMainImage={setMainImage} mainImage={mainImage} setImages={setImages} />
    </Box>
  );
};

export default ImageArea;