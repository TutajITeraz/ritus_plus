import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  VStack,
  HStack,
  Text,
  Button,
  Input,
  Table,
  Dialog,
  Portal,
  Badge,
  IconButton,
  Stack,
} from "@chakra-ui/react";
import { LuArrowLeft, LuPlus, LuTrash2, LuPencil, LuUserPlus } from "react-icons/lu";
import {
  fetchUsers,
  createUser,
  updateUser,
  deleteUser,
  fetchProjects,
  getDomainConfig,
  saveDomainConfig,
} from "../apiUtils";
import { useAuth } from "../App";

const UserDetails = () => {
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [newUser, setNewUser] = useState({
    username: "",
    password: "",
    is_admin: false,
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [domainConfig, setDomainConfig] = useState({});
  const [transcriptionWorkers, setTranscriptionWorkers] = useState(1);
  const [newDomain, setNewDomain] = useState({ domain: "", sleep_seconds: 0, timeout: 60 });
  const [domainConfigSaving, setDomainConfigSaving] = useState(false);
  const navigate = useNavigate();
  const { currentUser } = useAuth();

  useEffect(() => {
    if (currentUser?.is_admin) {
      fetchUsers().then(setUsers);
      getDomainConfig().then((cfg) => {
        const { transcription_workers, ...domainOnly } = cfg;
        setTranscriptionWorkers(transcription_workers ?? 1);
        setDomainConfig(domainOnly);
      }).catch(() => {});
    }
    fetchProjects().then((data) => {
      setProjects([...(data.owned || []), ...(data.shared || [])]);
    });
  }, [currentUser]);

  const handleSaveDomainConfig = async () => {
    setDomainConfigSaving(true);
    try {
      await saveDomainConfig({ transcription_workers: Number(transcriptionWorkers), ...domainConfig });
    } catch (e) {
      console.error("Failed to save domain config:", e);
    } finally {
      setDomainConfigSaving(false);
    }
  };

  const handleAddDomain = () => {
    const d = newDomain.domain.trim().toLowerCase();
    if (!d) return;
    setDomainConfig((prev) => ({
      ...prev,
      [d]: { sleep_seconds: Number(newDomain.sleep_seconds), timeout: Number(newDomain.timeout) },
    }));
    setNewDomain({ domain: "", sleep_seconds: 0, timeout: 60 });
  };

  const handleRemoveDomain = (domain) => {
    setDomainConfig((prev) => {
      const next = { ...prev };
      delete next[domain];
      return next;
    });
  };

  const handleCreateUser = async () => {
    try {
      await createUser(newUser);
      setUsers([...users, { ...newUser, id: Date.now(), created_at: new Date().toISOString() }]);
      setIsCreateDialogOpen(false);
      setNewUser({ username: "", password: "", is_admin: false });
    } catch (error) {
      console.error("Failed to create user:", error);
    }
  };

  const handleUpdateUser = async () => {
    try {
      const updateData = {};
      if (newUser.password) updateData.password = newUser.password;
      if (currentUser.is_admin && editingUser) {
        updateData.is_admin = newUser.is_admin;
      }

      await updateUser(editingUser.id, updateData);
      setUsers(users.map(u => u.id === editingUser.id ? { ...u, ...updateData } : u));
      setIsEditDialogOpen(false);
      setEditingUser(null);
      setNewUser({ username: "", password: "", is_admin: false });
    } catch (error) {
      console.error("Failed to update user:", error);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (window.confirm("Are you sure you want to delete this user?")) {
      try {
        await deleteUser(userId);
        setUsers(users.filter(u => u.id !== userId));
      } catch (error) {
        console.error("Failed to delete user:", error);
      }
    }
  };

  const openEditDialog = (user) => {
    setEditingUser(user);
    setNewUser({
      username: user.username,
      password: "",
      is_admin: user.is_admin,
    });
    setIsEditDialogOpen(true);
  };

  if (!currentUser) {
    return <Box p={4}>Please log in to access this page.</Box>;
  }

  return (
    <Box p={4}>
      <HStack mb={6} spacing={4}>
        <Button
          onClick={() => navigate("/")}
          variant="outline"
          size="sm"
        >
          <LuArrowLeft />
          Back to Projects
        </Button>
        <Text fontSize="2xl" fontWeight="bold">
          {currentUser.is_admin ? "User Management" : "My Profile"}
        </Text>
      </HStack>

      {currentUser.is_admin ? (
        <VStack spacing={6} align="stretch">
          <HStack justify="space-between">
            <Text fontSize="xl" fontWeight="bold">
              Users
            </Text>
            <Button
              onClick={() => setIsCreateDialogOpen(true)}
              colorScheme="blue"
            >
              <LuUserPlus />
              Add User
            </Button>
          </HStack>

          <VStack spacing={4} align="stretch">
            {users.map((user) => (
              <HStack key={user.id} justify="space-between" p={4} border="1px solid" borderColor="gray.200" borderRadius="md">
                <VStack align="start" spacing={0}>
                  <Text fontWeight="bold">{user.username}</Text>
                  <Badge colorPalette={user.is_admin ? "red" : "blue"}>
                    {user.is_admin ? "Admin" : "User"}
                  </Badge>
                </VStack>
                <HStack>
                  <Text>{new Date(user.created_at).toLocaleDateString()}</Text>
                  <Button
                    onClick={() => openEditDialog(user)}
                    variant="ghost"
                    size="sm"
                    aria-label="Edit user"
                  >
                    <LuPencil />
                  </Button>
                  {user.id !== currentUser.id && (
                    <IconButton
                      onClick={() => handleDeleteUser(user.id)}
                      variant="ghost"
                      colorPalette="red"
                      size="sm"
                      aria-label="Delete user"
                    >
                      <LuTrash2 />
                    </IconButton>
                  )}
                </HStack>
              </HStack>
            ))}
          </VStack>
        </VStack>
      ) : (
        <VStack spacing={6} align="stretch">
          <Box>
            <Text fontSize="xl" fontWeight="bold" mb={4}>
              Profile Information
            </Text>
            <VStack align="start">
              <Text fontSize="lg" fontWeight="bold">
                {currentUser.username}
              </Text>
              <Badge colorPalette="blue">User</Badge>
            </VStack>
          </Box>

          <Box>
            <Text fontSize="lg" fontWeight="bold" mb={4}>
              Change Password
            </Text>
            <VStack spacing={4} maxW="400px">
              <Input
                type="password"
                placeholder="New password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <Button
                onClick={async () => {
                  try {
                    await updateUser(currentUser.id, { password: currentPassword });
                    setCurrentPassword("");
                    alert("Password updated successfully!");
                  } catch (error) {
                    console.error("Failed to update password:", error);
                  }
                }}
                colorScheme="blue"
                isDisabled={!currentPassword}
              >
                Update Password
              </Button>
            </VStack>
          </Box>
        </VStack>
      )}

      {/* Create User Dialog */}
      <Dialog.Root
        open={isCreateDialogOpen}
        onOpenChange={(e) => setIsCreateDialogOpen(e.open)}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Create New User</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack spacing={4}>
                  <Input
                    placeholder="Username"
                    value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  />
                  <Input
                    type="password"
                    placeholder="Password"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  />
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  onClick={() => setIsCreateDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleCreateUser}>Create</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Edit User Dialog */}
      <Dialog.Root
        open={isEditDialogOpen}
        onOpenChange={(e) => setIsEditDialogOpen(e.open)}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Edit User</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack spacing={4}>
                  <Text>Username: {editingUser?.username}</Text>
                  <Input
                    type="password"
                    placeholder="New password (leave empty to keep current)"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  />
                  {currentUser.is_admin && (
                    <HStack>
                      <input
                        type="checkbox"
                        checked={newUser.is_admin}
                        onChange={(e) => setNewUser({ ...newUser, is_admin: e.target.checked })}
                      />
                      <Text>Admin privileges</Text>
                    </HStack>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  onClick={() => setIsEditDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleUpdateUser}>Update</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Domain Config Section – admin only */}
      {currentUser?.is_admin && (
        <Box mt={8}>
          <Text fontSize="xl" fontWeight="bold" mb={4}>Domain Configuration</Text>
          <Text fontSize="sm" color="gray.500" mb={3}>
            Configure per-domain sleep delays and timeouts for IIIF downloads.
            Changes are saved to <strong>domain_config.json</strong> on the server.
          </Text>

          {/* Transcription concurrency setting */}
          <HStack mb={5} spacing={4} align="center">
            <Text fontWeight="bold" fontSize="sm" whiteSpace="nowrap">
              Parallel pages per project:
            </Text>
            <Input
              size="sm"
              type="number"
              min={1}
              max={64}
              step={1}
              value={transcriptionWorkers}
              onChange={(e) => setTranscriptionWorkers(e.target.value)}
              w="80px"
            />
            <Text fontSize="xs" color="gray.500">
              Strony transkrybowane jednocześnie w ramach jednego projektu (np. 4 lub 8 dla 8 rdzeni CPU).
              Projekty są kolejkowane i transkrybowane jeden po drugim.
            </Text>
          </HStack>
          <Table.Root size="sm" mb={4}>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Domain</Table.ColumnHeader>
                <Table.ColumnHeader>Sleep between images (s)</Table.ColumnHeader>
                <Table.ColumnHeader>Request timeout (s)</Table.ColumnHeader>
                <Table.ColumnHeader></Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {Object.entries(domainConfig).map(([domain, cfg]) => (
                <Table.Row key={domain}>
                  <Table.Cell>{domain}</Table.Cell>
                  <Table.Cell>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      step={0.5}
                      value={cfg.sleep_seconds}
                      onChange={(e) =>
                        setDomainConfig((prev) => ({
                          ...prev,
                          [domain]: { ...prev[domain], sleep_seconds: Number(e.target.value) },
                        }))
                      }
                      w="80px"
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <Input
                      size="sm"
                      type="number"
                      min={5}
                      step={5}
                      value={cfg.timeout}
                      onChange={(e) =>
                        setDomainConfig((prev) => ({
                          ...prev,
                          [domain]: { ...prev[domain], timeout: Number(e.target.value) },
                        }))
                      }
                      w="80px"
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <IconButton
                      aria-label="Remove domain"
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={() => handleRemoveDomain(domain)}
                    >
                      <LuTrash2 />
                    </IconButton>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>

          {/* Add new domain row */}
          <Stack spacing={2} mb={4}>
            <Text fontWeight="bold" fontSize="sm">Add domain</Text>
            <HStack>
              <Input
                size="sm"
                placeholder="e.g. gallica.bnf.fr"
                value={newDomain.domain}
                onChange={(e) => setNewDomain({ ...newDomain, domain: e.target.value })}
                w="220px"
              />
              <Input
                size="sm"
                type="number"
                min={0}
                step={0.5}
                placeholder="Sleep (s)"
                value={newDomain.sleep_seconds}
                onChange={(e) => setNewDomain({ ...newDomain, sleep_seconds: e.target.value })}
                w="100px"
              />
              <Input
                size="sm"
                type="number"
                min={5}
                step={5}
                placeholder="Timeout (s)"
                value={newDomain.timeout}
                onChange={(e) => setNewDomain({ ...newDomain, timeout: e.target.value })}
                w="100px"
              />
              <Button size="sm" onClick={handleAddDomain} disabled={!newDomain.domain.trim()}>
                <LuPlus /> Add
              </Button>
            </HStack>
          </Stack>

          <Button colorPalette="blue" loading={domainConfigSaving} onClick={handleSaveDomainConfig}>
            Save Domain Config
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default UserDetails;