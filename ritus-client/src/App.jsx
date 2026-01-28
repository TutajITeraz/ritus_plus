import { ChakraProvider, defaultSystem, Box } from "@chakra-ui/react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "@/components/ui/toaster";
import { useEffect, useState, createContext, useContext } from "react";
import ProjectList from "./pages/ProjectList";
import ProjectDetail from "./pages/ProjectDetail";
import TableEditor from "./pages/TableEditor";
import Login from "./pages/Login";
import UserDetails from "./pages/UserDetails";
import { getCurrentUser, logout } from "./apiUtils";

// Authentication Context
const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);

  const checkAuth = () => {
    const user = getCurrentUser();
    const token = localStorage.getItem('authToken');
    const authenticated = !!(user && token);
    setIsAuthenticated(authenticated);
    setCurrentUser(user);
    return authenticated;
  };

  useEffect(() => {
    checkAuth();

    // Listen for storage changes
    const handleStorageChange = () => checkAuth();
    window.addEventListener('storage', handleStorageChange);

    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const login = (user, token) => {
    localStorage.setItem('authToken', token);
    localStorage.setItem('currentUser', JSON.stringify(user));
    setIsAuthenticated(true);
    setCurrentUser(user);
  };

  const logoutUser = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    setIsAuthenticated(false);
    setCurrentUser(null);
  };

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      currentUser,
      login,
      logout: logoutUser,
      checkAuth
    }}>
      {children}
    </AuthContext.Provider>
  );
};

const AuthWrapper = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (isAuthenticated === null) {
    return <Box>Loading...</Box>;
  }

  return isAuthenticated ? children : <Navigate to="/login" state={{ from: location }} replace />;
};

function App() {
  return (
    <ChakraProvider value={defaultSystem}>
      <AuthProvider>
        <BrowserRouter>
          <Box minH="100vh">
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                path="/projects"
                element={
                  <AuthWrapper>
                    <ProjectList />
                  </AuthWrapper>
                }
              />
              <Route
                path="/project/:id"
                element={
                  <AuthWrapper>
                    <ProjectDetail />
                  </AuthWrapper>
                }
              />
              <Route
                path="/users"
                element={
                  <AuthWrapper>
                    <UserDetails />
                  </AuthWrapper>
                }
              />
              <Route
                path="/"
                element={
                  <AuthWrapper>
                    <ProjectList />
                  </AuthWrapper>
                }
              />
              <Route
                path="/table/:id?"
                element={
                  <AuthWrapper>
                    <TableEditor />
                  </AuthWrapper>
                }
              />
            </Routes>
            <Toaster />
          </Box>
        </BrowserRouter>
      </AuthProvider>
    </ChakraProvider>
  );
}

export default App;
