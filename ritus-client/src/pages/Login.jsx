import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  VStack,
  Input,
  Button,
  Text,
  Image,
  Alert,
} from "@chakra-ui/react";
import { login as apiLogin, getCurrentUser } from "../apiUtils";
import { useAuth } from "../App";

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { login, currentUser } = useAuth();

  useEffect(() => {
    // Check if already logged in
    if (currentUser) {
      navigate("/");
    }
  }, [navigate, currentUser]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const data = await apiLogin(username, password);
      login(data.user, data.access_token);
      // Small delay to ensure auth state updates
      setTimeout(() => {
        navigate("/");
      }, 100);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box
      minH="100vh"
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="gray.50"
    >
      <Box
        p={8}
        maxWidth="400px"
        borderWidth={1}
        borderRadius={8}
        boxShadow="lg"
        bg="white"
      >
        <VStack spacing={4}>
          <Image src="/logo.svg" alt="Ritus Logo" height="60px" />
          <Text fontSize="2xl" fontWeight="bold">
            Login to Ritus
          </Text>

          {error && (
            <Alert.Root status="error">
              <Alert.Indicator />
              <Alert.Title>{error}</Alert.Title>
            </Alert.Root>
          )}

          <form onSubmit={handleLogin} style={{ width: "100%" }}>
            <VStack spacing={4}>
              <Box width="100%">
                <Text mb={2} fontWeight="medium">
                  Username
                </Text>
                <Input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter username"
                  required
                />
              </Box>

              <Box width="100%">
                <Text mb={2} fontWeight="medium">
                  Password
                </Text>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  required
                />
              </Box>

              <Button
                type="submit"
                colorScheme="blue"
                width="100%"
                isLoading={isLoading}
                loadingText="Logging in..."
              >
                Login
              </Button>
            </VStack>
          </form>
        </VStack>
      </Box>
    </Box>
  );
};

export default Login;