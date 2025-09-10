// components/ProjectDetail.jsx
import { useState, useEffect } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { useParams } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import ImageArea from "../components/ImageArea";
import { fetchProject, fetchImages } from "../apiUtils";

const ProjectDetail = () => {
  const [project, setProject] = useState(null);
  const [images, setImages] = useState([]);
  const [mainImage, setMainImage] = useState(null);
  const { id } = useParams();

  useEffect(() => {
    fetchProject(id).then(setProject);
    fetchImages(id).then((data) => {
      setImages(data);
      if (data.length > 0) setMainImage(data[0].original);
    });
  }, [id]);

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
