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
} from "@chakra-ui/react";
import { LuArrowLeft, LuPlus, LuTrash2, LuPencil, LuUserPlus } from "react-icons/lu";
import {
  fetchUsers,
  createUser,
  updateUser,
  deleteUser,
  fetchProjects,
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
  const navigate = useNavigate();
  const { currentUser } = useAuth();

  useEffect(() => {
    if (currentUser?.is_admin) {
      fetchUsers().then(setUsers);
    }
    fetchProjects().then((data) => {
      // Combine owned and shared projects
      setProjects([...(data.owned || []), ...(data.shared || [])]);
    });
  }, [currentUser]);

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
    </Box>
  );
};

export default UserDetails;