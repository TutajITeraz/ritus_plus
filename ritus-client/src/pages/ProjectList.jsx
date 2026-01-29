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
  VStack,
  Badge,
  Select,
  createListCollection,
  CloseButton,
} from "@chakra-ui/react";
import { LuPlus, LuTrash2, LuUsers } from "react-icons/lu";
import { MdImageNotSupported } from "react-icons/md";
import { useNavigate } from "react-router-dom";
import { fetchProjects, createProject, deleteProject, fetchUsers, shareProject, unshareProject, updateProjectShares } from "../apiUtils";
import { useAuth } from "../App";
import IiifDownloader from "../components/IiifDownloader";
import BatchProjectCreator from "../components/BatchProjectCreator";

const typeCollection = createListCollection({
  items: [
    { label: "Files", value: "files" },
    { label: "IIIF", value: "iiif" },
  ],
});

const ProjectList = () => {
  const [projectData, setProjectData] = useState({ owned: [], shared: [] });
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newProject, setNewProject] = useState({
    name: "New Project",
    type: "files",
    iiif_url: "",
  });
  const [isIiifDownloaderOpen, setIsIiifDownloaderOpen] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState(null);
  const [users, setUsers] = useState([]);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [sharingProject, setSharingProject] = useState(null);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth();

  useEffect(() => {
    fetchProjects().then(setProjectData);
    if (currentUser) {
      fetchUsers().then(setUsers);
    }
  }, [currentUser]);

  const handleCreateProject = async () => {
    const data = await createProject(newProject);
    if (data) {
      setProjectData(prev => ({
        ...prev,
        owned: [...prev.owned, { id: data.id, ...newProject, first_thumbnail: null, owner_id: currentUser.id, is_owner: true }]
      }));
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
    if (window.confirm("Are you sure you want to delete this project? This will permanently delete all images and data.")) {
      await deleteProject(id);
      setProjectData(prev => ({
        owned: prev.owned.filter(p => p.id !== id),
        shared: prev.shared.filter(p => p.id !== id)
      }));
    }
  };

  const handleShareProject = async (project) => {
    setSharingProject(project);
    setSelectedUsers(project.shared_users || []);
    setIsShareDialogOpen(true);
  };

  const handleConfirmShare = async () => {
    if (!sharingProject) return;

    try {
      await updateProjectShares(sharingProject.id, selectedUsers);
      setIsShareDialogOpen(false);
      setSharingProject(null);
      setSelectedUsers([]);
      // Refresh projects to show updated sharing status
      fetchProjects().then(setProjectData);
    } catch (error) {
      console.error("Failed to update project shares:", error);
    }
  };

  return (
    <Box p={4}>
      <Flex justify="space-between" align="center" mb={4}>
        <Image src="/logo.svg" alt="Ritus Logo" height="40px" />
        <HStack>
          <Text fontSize="sm" color="gray.500">v. 1.7</Text>
          {currentUser && (
            <>
              <Text fontSize="sm">Welcome, {currentUser.username}</Text>
              <Button onClick={() => navigate('/users')} variant="ghost" size="sm">
                Settings
              </Button>
              <Button onClick={logout} variant="ghost" size="sm" colorScheme="red">
                Logout
              </Button>
            </>
          )}
        </HStack>
      </Flex>
      <HStack mb={4} spacing={3}>
        <Text fontSize="2xl" fontWeight="bold">
          Projects
        </Text>
        <Dialog.Root
          open={isDialogOpen}
          onOpenChange={(e) => setIsDialogOpen(e.open)}
        >
          <Dialog.Trigger asChild>
            <Button variant="solid">
              <LuPlus />
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
                      <Select.Root
                        collection={typeCollection}
                        value={[newProject.type]}
                        onValueChange={(details) =>
                          setNewProject({ ...newProject, type: details.value[0] })
                        }
                      >
                        <Select.HiddenSelect />
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder="Select type" />
                          </Select.Trigger>
                          <Select.IndicatorGroup>
                            <Select.Indicator />
                          </Select.IndicatorGroup>
                        </Select.Control>
                        <Portal>
                          <Select.Positioner>
                            <Select.Content>
                              {typeCollection.items.map((item) => (
                                <Select.Item item={item} key={item.value}>
                                  {item.label}
                                  <Select.ItemIndicator />
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Positioner>
                        </Portal>
                      </Select.Root>
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
        <BatchProjectCreator 
          onProjectsCreated={() => fetchProjects().then(setProjectData)}
        />
      </HStack>
      
      {/* Owned Projects Section */}
      {projectData.owned.length > 0 && (
        <Box>
          <Text fontSize="xl" fontWeight="bold" mb={4}>My Projects</Text>
          <Stack spacing={4}>
            {projectData.owned.map((project) => (
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
                  <HStack>
                    <Button
                      onClick={() => handleShareProject(project)}
                      variant="subtle"
                      size="sm"
                    >
                      Share
                    </Button>
                    <Button
                      onClick={() => handleDeleteProject(project.id)}
                      variant="subtle"
                      colorScheme="red"
                      size="sm"
                    >
                      <LuTrash2 /> Delete
                    </Button>
                  </HStack>
                </HStack>
              </Flex>
            ))}
          </Stack>
        </Box>
      )}

      {/* Shared Projects Section */}
      {projectData.shared.length > 0 && (
        <Box>
          <Text fontSize="xl" fontWeight="bold" mb={4}>Shared Projects</Text>
          <Stack spacing={4}>
            {projectData.shared.map((project) => (
              <Flex
                key={project.id}
                p={4}
                borderWidth="1px"
                borderRadius="lg"
                bg="white"
                boxShadow="sm"
                opacity={0.8}
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
                    <Text fontSize="sm" color="gray.600">Shared with you</Text>
                  </Stack>
                </HStack>
              </Flex>
            ))}
          </Stack>
        </Box>
      )}

      {/* No projects message */}
      {projectData.owned.length === 0 && projectData.shared.length === 0 && (
        <Text textAlign="center" color="gray.500" mt={8}>
          No projects found. Create your first project to get started.
        </Text>
      )}
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

      {/* Share Project Dialog */}
      <Dialog.Root
        open={isShareDialogOpen}
        onOpenChange={(e) => setIsShareDialogOpen(e.open)}
        placement="center"
        motionPreset="slide-in-bottom"
        unmountOnExit
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Share Project: {sharingProject?.name}</Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body>
                <Text mb={4}>Select users to share this project with:</Text>
                <VStack align="start" spacing={2}>
                  {users.filter(user => user.id !== currentUser?.id).map((user) => (
                    <HStack key={user.id} as="label" cursor="pointer">
                      <input
                        type="checkbox"
                        checked={selectedUsers.includes(user.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedUsers([...selectedUsers, user.id]);
                          } else {
                            setSelectedUsers(selectedUsers.filter(id => id !== user.id));
                          }
                        }}
                      />
                      <HStack>
                        <Text>{user.username}</Text>
                        {user.is_admin && <Badge>Admin</Badge>}
                      </HStack>
                    </HStack>
                  ))}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="outline" onClick={() => setIsShareDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleConfirmShare} disabled={selectedUsers.length === 0}>
                  Share Project
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
};

export default ProjectList;
