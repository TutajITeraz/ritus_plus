// components/ProjectList.jsx
import { useState, useEffect, useRef } from "react";
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
  Progress,
} from "@chakra-ui/react";
import { LuPlus, LuTrash2 } from "react-icons/lu";
import { FaDownload, FaStop } from "react-icons/fa";
import { MdImageNotSupported } from "react-icons/md";
import { useNavigate } from "react-router-dom";
import { fetchProjects, createProject, deleteProject, fetchUsers, updateProjectShares, startIiifDownload, getIiifDownloadStatus, cancelIiifDownload } from "../apiUtils";
import { useAuth } from "../App";
import { toaster } from "@/components/ui/toaster";
import BatchProjectCreator from "../components/BatchProjectCreator";

const typeCollection = createListCollection({
  items: [
    { label: "Files", value: "files" },
    { label: "IIIF", value: "iiif" },
  ],
});

// ---------------------------------------------------------------------------
// Per-project IIIF download status widget
// ---------------------------------------------------------------------------
const IiifProjectStatus = ({ project, jobStatus, onDownload, onCancel }) => {
  const status = jobStatus?.status;
  const current = jobStatus?.current_page ?? 0;
  const total = jobStatus?.total_pages ?? 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  if (status === "running" || status === "pending") {
    return (
      <Stack spacing={1}>
        <Text fontSize="sm" color="blue.600">{status === "pending" ? "Starting download…" : "Downloading in background…"}</Text>
        <Progress.Root value={status === "pending" ? null : pct} maxW="260px">
          <HStack gap="3">
            <Progress.Track flex="1">
              <Progress.Range />
            </Progress.Track>
            <Progress.ValueText>{current}/{total || "?"}</Progress.ValueText>
          </HStack>
        </Progress.Root>
        <Button size="xs" variant="subtle" colorPalette="red" onClick={onCancel}>
          <FaStop /> Cancel
        </Button>
      </Stack>
    );
  }

  if (status === "waiting") {
    return (
      <Stack spacing={1}>
        <Text fontSize="sm" color="orange.500">Waiting… (same domain busy)</Text>
        <Button size="xs" variant="subtle" colorPalette="red" onClick={onCancel}>
          <FaStop /> Cancel
        </Button>
      </Stack>
    );
  }

  if (status === "failed") {
    return (
      <Stack spacing={1}>
        <Text fontSize="sm" color="red.600">Download failed: {jobStatus?.error_message}</Text>
        <Button size="xs" variant="subtle" onClick={() => onDownload(null)}>
          <FaDownload /> Retry
        </Button>
      </Stack>
    );
  }

  if (status === "cancelled") {
    return (
      <Stack spacing={1}>
        <Text fontSize="sm" color="orange.600">
          Cancelled at page {current}/{total || "?"}
        </Text>
        <Button size="xs" variant="subtle" onClick={() => onDownload(null)}>
          <FaDownload /> Resume
        </Button>
      </Stack>
    );
  }

  if (status === "completed") {
    return (
      <Text fontSize="sm" color="green.600">✓ Download complete</Text>
    );
  }

  // No job or status="none" – show Download button
  if (!project.iiif_url) return null;
  return (
    <Button size="sm" variant="subtle" onClick={() => onDownload(null)}>
      <FaDownload /> Download IIIF
    </Button>
  );
};

const ProjectList = () => {
  const [projectData, setProjectData] = useState({ owned: [], shared: [] });
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newProject, setNewProject] = useState({
    name: "New Project",
    type: "files",
    iiif_url: "",
  });
  const [users, setUsers] = useState([]);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [sharingProject, setSharingProject] = useState(null);
  const [selectedUsers, setSelectedUsers] = useState([]);
  // Server-side IIIF download state
  const [iiifJobStatuses, setIiifJobStatuses] = useState({});
  const [conflictDialog, setConflictDialog] = useState({ open: false, projectId: null, imageCount: 0 });
  const pollingRef = useRef(null);
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth();

  useEffect(() => {
    fetchProjects().then((data) => {
      setProjectData(data);
      // Seed iiifJobStatuses from the projects response
      const statuses = {};
      [...(data.owned || []), ...(data.shared || [])].forEach((p) => {
        if (p.iiif_download_job) statuses[p.id] = p.iiif_download_job;
      });
      setIiifJobStatuses(statuses);
    });
    if (currentUser) {
      fetchUsers().then(setUsers);
    }
  }, [currentUser]);

  // Poll running jobs every 3s
  useEffect(() => {
    const runningIds = Object.entries(iiifJobStatuses)
      .filter(([, s]) => s?.status === "running" || s?.status === "pending" || s?.status === "waiting")
      .map(([id]) => parseInt(id));

    if (runningIds.length === 0) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
      return;
    }
    if (pollingRef.current) return; // already polling

    pollingRef.current = setInterval(async () => {
      const updates = {};
      await Promise.all(
        runningIds.map(async (projectId) => {
          try {
            const status = await getIiifDownloadStatus(projectId);
            updates[projectId] = status;
          } catch (_) {}
        })
      );
      setIiifJobStatuses((prev) => ({ ...prev, ...updates }));
      // Refresh project list when any job completes
      const anyDone = Object.values(updates).some(
        (s) => s?.status === "completed" || s?.status === "failed" || s?.status === "cancelled"
      );
      if (anyDone) {
        fetchProjects().then((data) => {
          setProjectData(data);
          const statuses = {};
          [...(data.owned || []), ...(data.shared || [])].forEach((p) => {
            if (p.iiif_download_job) statuses[p.id] = p.iiif_download_job;
          });
          setIiifJobStatuses((prev) => ({ ...prev, ...statuses }));
        });
      }
    }, 3000);

    return () => {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    };
  }, [iiifJobStatuses]);

  const handleServerIiifDownload = async (projectId, confirm = null) => {
    try {
      const { status, data } = await startIiifDownload(projectId, confirm);
      if (status === 409 && data.conflict) {
        setConflictDialog({ open: true, projectId, imageCount: data.image_count });
        return;
      }
      if (status === 409 && !data.conflict) {
        toaster.create({ title: "Already running", description: data.error, type: "warning", duration: 3000 });
        return;
      }
      // Mark as running immediately
      setIiifJobStatuses((prev) => ({
        ...prev,
        [projectId]: { status: "running", current_page: 0, total_pages: 0 },
      }));
      toaster.create({ title: "Download started", description: `Starting from page ${data.start_page}`, type: "success", duration: 3000 });
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    }
  };

  const handleCancelIiifDownload = async (projectId) => {
    try {
      await cancelIiifDownload(projectId);
      setIiifJobStatuses((prev) => ({ ...prev, [projectId]: { ...prev[projectId], status: "cancelled" } }));
    } catch (e) {
      toaster.create({ title: "Error", description: e.message, type: "error", duration: 5000 });
    }
  };

  const handleCreateProject = async () => {
    const data = await createProject(newProject);
    if (data) {
      setProjectData(prev => ({
        ...prev,
        owned: [...prev.owned, { id: data.id, ...newProject, first_thumbnail: null, owner_id: currentUser.id, is_owner: true, image_count: 0, transcribed_count: 0 }]
      }));
      setIsDialogOpen(false);
      if (newProject.type === "iiif" && newProject.iiif_url) {
        // Start server-side download immediately; navigate to project page
        await handleServerIiifDownload(data.id);
        navigate(`/project/${data.id}`);
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
          <Text fontSize="sm" color="gray.500">v. 1.9</Text>
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
                    {project.iiif_url && (
                      <HStack>
                        <Text fontWeight="bold" fontSize="xs">IIIF URL:</Text>
                        <Text fontSize="sm" color="gray.500" maxW="400px" isTruncated>{project.iiif_url}</Text>
                      </HStack>
                    )}
                    {project.image_count > 0 && (
                      <HStack>
                        <Text fontSize="sm" color="gray.600">{project.image_count} images</Text>
                        {project.transcribed_count > 0 && (
                          <Text fontSize="sm" color="green.600">· {project.transcribed_count} transcribed</Text>
                        )}
                      </HStack>
                    )}
                  </Stack>
                  <HStack alignItems="flex-start">
                    {project.type === "iiif" && (
                      <IiifProjectStatus
                        project={project}
                        jobStatus={iiifJobStatuses[project.id]}
                        onDownload={(confirm) => handleServerIiifDownload(project.id, confirm)}
                        onCancel={() => handleCancelIiifDownload(project.id)}
                      />
                    )}
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
                    {project.iiif_url && (
                      <HStack>
                        <Text fontWeight="bold" fontSize="sm">IIIF URL:</Text>
                        <Text fontSize="sm" color="gray.500" maxW="400px" isTruncated>{project.iiif_url}</Text>
                      </HStack>
                    )}
                    {project.image_count > 0 && (
                      <HStack>
                        <Text fontSize="sm" color="gray.600">{project.image_count} images</Text>
                        {project.transcribed_count > 0 && (
                          <Text fontSize="sm" color="green.600">· {project.transcribed_count} transcribed</Text>
                        )}
                      </HStack>
                    )}
                    <Text fontSize="sm" color="gray.600">Shared with you</Text>
                  </Stack>
                  {project.type === "iiif" && (
                    <IiifProjectStatus
                      project={project}
                      jobStatus={iiifJobStatuses[project.id]}
                      onDownload={(confirm) => handleServerIiifDownload(project.id, confirm)}
                      onCancel={() => handleCancelIiifDownload(project.id)}
                    />
                  )}
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
      {/* Conflict Dialog */}
      <Dialog.Root
        open={conflictDialog.open}
        onOpenChange={(e) => setConflictDialog((prev) => ({ ...prev, open: e.open }))}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Project already has images</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>This project already has {conflictDialog.imageCount} downloaded image(s). What would you like to do?</Text>
              </Dialog.Body>
              <Dialog.Footer gap={2}>
                <Button variant="outline" onClick={() => setConflictDialog({ open: false, projectId: null, imageCount: 0 })}>Cancel</Button>
                <Button variant="outline" onClick={() => {
                  setConflictDialog({ open: false, projectId: null, imageCount: 0 });
                  handleServerIiifDownload(conflictDialog.projectId, "append");
                }}>Append after existing</Button>
                <Button colorPalette="red" onClick={() => {
                  setConflictDialog({ open: false, projectId: null, imageCount: 0 });
                  handleServerIiifDownload(conflictDialog.projectId, "restart");
                }}>Restart from page 1</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

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
