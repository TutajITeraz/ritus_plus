import { ChakraProvider, defaultSystem, Box } from "@chakra-ui/react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "@/components/ui/toaster";
import ProjectList from "./pages/ProjectList";
import ProjectDetail from "./pages/ProjectDetail";
import TableEditor from "./pages/TableEditor";

function AppTableOnly() {
  return (
    <ChakraProvider value={defaultSystem}>
      <BrowserRouter>
        <Box minH="100vh">
          <Routes>
            <Route path="/projects" element={<ProjectList />} />
            <Route path="/project/:id" element={<ProjectDetail />} />
            <Route path="/table/:id?" element={<TableEditor />} />
            <Route path="/" element={<ProjectList />} />
            <Route path="*" element={<ProjectList />} />
          </Routes>
          <Toaster />
        </Box>
      </BrowserRouter>
    </ChakraProvider>
  );
}

export default AppTableOnly;
