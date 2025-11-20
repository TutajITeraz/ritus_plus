// components/ProjectList.jsx
import { useState, useEffect } from "react";
import {
  Box,
  Button,
  Flex,
  Text,
  HStack,
  Image,
  Stack,
  Dialog,
  Portal,
  Input,
  SegmentGroup,
} from "@chakra-ui/react";
import { LuPlus, LuTrash2 } from "react-icons/lu";
import { MdImageNotSupported } from "react-icons/md";
import { useNavigate } from "react-router-dom";
import { fetchProjects, createProject, deleteProject } from "../apiUtils";
import IiifDownloader from "../components/IiifDownloader";

const ProjectList = () => {
  const [projects, setProjects] = useState([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newProject, setNewProject] = useState({
    name: "New Project",
    type: "files",
    iiif_url: "",
  });
  const [isIiifDownloaderOpen, setIsIiifDownloaderOpen] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchProjects().then(setProjects);
  }, []);

  const handleCreateProject = async () => {
    const data = await createProject(newProject);
    if (data) {
      setProjects([
        ...projects,
        { id: data.id, ...newProject, first_thumbnail: null },
      ]);
      setIsDialogOpen(false);
      if (newProject.type === "iiif" && newProject.iiif_url) {
        setCreatedProjectId(data.id);
        setIsIiifDownloaderOpen(true);
      } else {
        navigate(`/project/${data.id}`);
      }
    }
  };

  const handleDeleteProject = async (id) => {
    await deleteProject(id);
    setProjects(projects.filter((p) => p.id !== id));
  };

  return (
    <Box p={4}>
      <Image src="/logo.svg" alt="Ritus Logo" height="40px" mx="auto" />
      <Box position="absolute" top={4} right={4} fontSize="sm" color="gray.500">
      v. 1.6
      </Box>
      <HStack mb={4}>
        <Text fontSize="2xl" fontWeight="bold">
          Projects
        </Text>
        <Dialog.Root
          open={isDialogOpen}
          onOpenChange={(e) => setIsDialogOpen(e.open)}
        >
          <Dialog.Trigger asChild>
            <Button leftIcon={<LuPlus />} variant="solid">
              New Project
            </Button>
          </Dialog.Trigger>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Create New Project</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  <Stack spacing={4}>
                    <Box>
                      <Text fontWeight="bold" mb={2}>
                        Name
                      </Text>
                      <Input
                        defaultValue={newProject.name}
                        onChange={(e) =>
                          setNewProject({ ...newProject, name: e.target.value })
                        }
                        variant="outline"
                        placeholder="Enter project name"
                      />
                    </Box>
                    <Box>
                      <Text fontWeight="bold" mb={2}>
                        Type
                      </Text>
                      <SegmentGroup.Root
                        value={newProject.type}
                        onValueChange={(e) =>
                          setNewProject({ ...newProject, type: e.value })
                        }
                      >
                        <SegmentGroup.Indicator />
                        <HStack>
                          <SegmentGroup.Item value="files">
                            <SegmentGroup.ItemText>Files</SegmentGroup.ItemText>
                            <SegmentGroup.ItemHiddenInput />
                          </SegmentGroup.Item>
                          <SegmentGroup.Item value="iiif">
                            <SegmentGroup.ItemText>IIIF</SegmentGroup.ItemText>
                            <SegmentGroup.ItemHiddenInput />
                          </SegmentGroup.Item>
                        </HStack>
                      </SegmentGroup.Root>
                    </Box>
                    {newProject.type === "iiif" && (
                      <Box>
                        <Text fontWeight="bold" mb={2}>
                          IIIF URL
                        </Text>
                        <Input
                          defaultValue={newProject.iiif_url}
                          onChange={(e) =>
                            setNewProject({
                              ...newProject,
                              iiif_url: e.target.value,
                            })
                          }
                          variant="outline"
                          placeholder="Enter IIIF URL here"
                        />
                      </Box>
                    )}
                  </Stack>
                </Dialog.Body>
                <Dialog.Footer>
                  <Dialog.ActionTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={() => setIsDialogOpen(false)}
                    >
                      Cancel
                    </Button>
                  </Dialog.ActionTrigger>
                  <Button onClick={handleCreateProject}>Create</Button>
                </Dialog.Footer>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      </HStack>
      <Stack spacing={4}>
        {projects.map((project) => (
          <Flex
            key={project.id}
            p={4}
            borderWidth="1px"
            borderRadius="lg"
            bg="white"
            boxShadow="sm"
          >
            <HStack spacing={4} w="full">
              <Image
                src={project.first_thumbnail}
                fallback={
                  <MdImageNotSupported
                    size={100}
                    color="gray.500"
                    bg="gray.100"
                    p={2}
                  />
                }
                boxSize="100px"
                objectFit="cover"
                borderRadius="md"
                onClick={() => navigate(`/project/${project.id}`)}
                cursor="pointer"
              />
              <Stack flex={1} spacing={2}>
                <HStack>
                  <Text fontWeight="bold">Name:</Text>
                  <Text
                    cursor="pointer"
                    onClick={() => navigate(`/project/${project.id}`)}
                    _hover={{ textDecoration: "underline" }}
                  >
                    {project.name}
                  </Text>
                </HStack>
                <HStack>
                  <Text fontWeight="bold">Type:</Text>
                  <Text>{project.type}</Text>
                </HStack>
                <HStack>
                  <Text fontWeight="bold">IIIF URL:</Text>
                  <Text>{project.iiif_url || "N/A"}</Text>
                </HStack>
              </Stack>
              <Button
                leftIcon={<LuTrash2 />}
                onClick={() => handleDeleteProject(project.id)}
                variant="subtle"
                colorScheme="red"
              >
                Delete
              </Button>
            </HStack>
          </Flex>
        ))}
      </Stack>
      {isIiifDownloaderOpen && (
        <IiifDownloader
          iiifUrl={newProject.iiif_url}
          projectId={createdProjectId}
          onClose={() => {
            setIsIiifDownloaderOpen(false);
            navigate(`/project/${createdProjectId}`);
          }}
        />
      )}
    </Box>
  );
};

export default ProjectList;
