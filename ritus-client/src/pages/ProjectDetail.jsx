// components/ProjectDetail.jsx
import { useState, useEffect } from "react";
import { Flex, Spinner, Text, VStack } from "@chakra-ui/react";
import { useParams } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import ImageArea from "../components/ImageArea";
import { fetchProject, fetchImages } from "../apiUtils";

const ProjectDetail = () => {
  const [project, setProject] = useState(null);
  const [images, setImages] = useState([]);
  const [mainImage, setMainImage] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const { id } = useParams();

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setProject(null);
    setImages([]);
    setMainImage(null);

    Promise.all([fetchProject(id), fetchImages(id)])
      .then(([projectData, imageData]) => {
        if (cancelled) return;
        setProject(projectData);
        setImages(imageData);
        if (imageData.length > 0) setMainImage(imageData[0].original);
      })
      .catch((error) => {
        // fetchProject/fetchImages already reported the error to the user
        console.error("Failed to load project:", error);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (isLoading) {
    return (
      <Flex h="100vh" align="center" justify="center">
        <VStack colorPalette="teal" spacing={3}>
          <Spinner size="xl" color="colorPalette.600" />
          <Text color="colorPalette.600">Loading project...</Text>
        </VStack>
      </Flex>
    );
  }

  return (
    <Flex h="100vh">
      <Sidebar
        project={project}
        setProject={setProject}
        images={images}
        setImages={setImages} // Added
        mainImage={mainImage}
        setMainImage={setMainImage} // Added
        projectId={id} // Added
      />
      <ImageArea
        images={images}
        setImages={setImages}
        mainImage={mainImage}
        setMainImage={setMainImage}
        projectId={id}
      />
    </Flex>
  );
};

export default ProjectDetail;
