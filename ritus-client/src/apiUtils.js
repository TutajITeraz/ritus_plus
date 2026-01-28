import { SERVER_URL } from "./config";
import { toaster } from "@/components/ui/toaster";

// Authentication utilities
export const getAuthToken = () => localStorage.getItem('authToken');
export const setAuthToken = (token) => localStorage.setItem('authToken', token);
export const removeAuthToken = () => localStorage.removeItem('authToken');
export const getCurrentUser = () => {
  const userStr = localStorage.getItem('currentUser');
  return userStr ? JSON.parse(userStr) : null;
};
export const setCurrentUser = (user) => localStorage.setItem('currentUser', JSON.stringify(user));
export const removeCurrentUser = () => localStorage.removeItem('currentUser');

const getAuthHeaders = () => {
  const token = getAuthToken();
  console.log('Auth token retrieved:', token ? token.substring(0, 50) + '...' : 'null');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
};

const apiRequest = async (url, options = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    // Token expired or invalid
    removeAuthToken();
    removeCurrentUser();
    window.location.href = '/login';
    throw new Error('Authentication required');
  }

  return response;
};

export const login = async (username, password) => {
  try {
    const response = await fetch(`${SERVER_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw new Error("Invalid credentials");
    const data = await response.json();
    // Note: Token and user storage is now handled by AuthContext
    return data;
  } catch (error) {
    toaster.create({
      title: "Login Failed",
      description: error.message || "Invalid credentials",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const logout = () => {
  // Note: Token and user removal is now handled by AuthContext
  window.location.href = '/login';
};

export const fetchProjects = async () => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/projects`);
    if (!response.ok) throw new Error("Failed to fetch projects");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to fetch projects",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const createProject = async (projectData) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/projects`, {
      method: "POST",
      body: JSON.stringify(projectData),
    });
    if (!response.ok) throw new Error("Failed to create project");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to create project",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const deleteProject = async (id) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/projects/${id}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error("Failed to delete project");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to delete project",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const fetchProject = async (id) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/projects/${id}`);
    if (!response.ok) throw new Error("Failed to fetch project");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to fetch project",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const updateProject = async (id, data) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error("Failed to update project");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to update project",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const fetchImages = async (projectId) => {
  try {
    const response = await apiRequest(
      `${SERVER_URL}/api/projects/${projectId}/images`
    );
    if (!response.ok) throw new Error("Failed to fetch images");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to fetch images",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const uploadImages = async (projectId, formData) => {
  try {
    const headers = getAuthHeaders(); // Don't set Content-Type for FormData
    const response = await fetch(
      `${SERVER_URL}/api/projects/${projectId}/upload`,
      {
        method: "POST",
        headers,
        body: formData,
      }
    );
    if (response.status === 401) {
      removeAuthToken();
      removeCurrentUser();
      window.location.href = '/login';
      throw new Error('Authentication required');
    }
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || "Upload failed");
    }
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to upload images",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const deleteImage = async (imageId) => {
  try {
    const headers = getAuthHeaders();
    const response = await fetch(`${SERVER_URL}/api/images/${imageId}`, {
      method: "DELETE",
      headers,
    });
    if (response.status === 401) {
      removeAuthToken();
      removeCurrentUser();
      window.location.href = '/login';
      throw new Error('Authentication required');
    }
    if (!response.ok) throw new Error("Failed to delete image");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to delete image",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const updateImage = async (imageId, data) => {
  try {
    const headers = {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    };
    const response = await fetch(`${SERVER_URL}/api/images/${imageId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(data),
    });
    if (response.status === 401) {
      removeAuthToken();
      removeCurrentUser();
      window.location.href = '/login';
      throw new Error('Authentication required');
    }
    if (!response.ok)
      throw new Error(`Failed to update image: ${response.status}`);
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to update image",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const transcribeImage = async (imageId, modelName) => {
  try {
    const headers = getAuthHeaders();
    const formData = new FormData();
    formData.append("modelName", modelName);
    const response = await fetch(`${SERVER_URL}/api/transcribe/${imageId}`, {
      method: "POST",
      headers,
      body: formData,
    });
    if (response.status === 401) {
      removeAuthToken();
      removeCurrentUser();
      window.location.href = '/login';
      throw new Error('Authentication required');
    }
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || "Transcription failed");
    }
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to transcribe image",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const fetchProjectContent = async (projectId) => {
  try {
    const response = await fetch(
      `${SERVER_URL}/api/projects/${projectId}/content`
    );
    if (!response.ok) throw new Error("Failed to fetch project content");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to fetch project content",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

/*
export const saveProjectContent = async (projectId, contentRows) => {
  try {
    // First, fetch existing content to determine which rows to update or create
    const existingContent = await fetchProjectContent(projectId);
    const existingIds = new Set(existingContent.map((row) => row.id));

    // Separate rows into create and update operations
    const createRows = contentRows.filter(
      (row) => !row.id || !existingIds.has(row.id)
    );
    const updateRows = contentRows.filter(
      (row) => row.id && existingIds.has(row.id)
    );

    // Perform create operations
    for (const row of createRows) {
      const response = await fetch(
        `${SERVER_URL}/api/projects/${projectId}/content`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: row }),
        }
      );
      if (!response.ok) throw new Error("Failed to create content row");
    }

    // Perform update operations
    for (const row of updateRows) {
      const response = await fetch(
        `${SERVER_URL}/api/projects/${projectId}/content/${row.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: row }),
        }
      );
      if (!response.ok) throw new Error("Failed to update content row");
    }

    // Delete rows that are no longer in contentRows
    const currentIds = new Set(
      contentRows.map((row) => row.id).filter((id) => id)
    );
    const deleteIds = existingContent
      .filter((row) => !currentIds.has(row.id))
      .map((row) => row.id);
    for (const id of deleteIds) {
      const response = await fetch(
        `${SERVER_URL}/api/projects/${projectId}/content/${id}`,
        {
          method: "DELETE",
        }
      );
      if (!response.ok) throw new Error("Failed to delete content row");
    }

    toaster.create({
      title: "Success",
      description: "Project content saved successfully",
      type: "success",
      duration: 3000,
    });
    return { message: "Content saved" };
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to save project content",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};
*/
export const saveProjectContent = async (projectId, contentRows) => {
  try {
    const existingContent = await fetchProjectContent(projectId);
    const payload = {
      delete: existingContent.map((row) => row.id),
      create: contentRows,
    };

    const response = await fetch(
      `${SERVER_URL}/api/projects/${projectId}/content/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok)
      throw new Error("Failed to perform bulk content operations");

    toaster.create({
      title: "Success",
      description: "Project content saved successfully",
      type: "success",
      duration: 3000,
    });

    return { message: "Content saved" };
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to save project content",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const startBatchProcess = async (projectId, similarityThreshold) => {
  try {
    const response = await fetch(
      `${SERVER_URL}/api/projects/${projectId}/batch-process`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          similarity_threshold: similarityThreshold * 100,
        }),
      }
    );
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to start batch process");
    }
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to start batch process",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const getBatchProcessStatus = async (projectId) => {
  try {
    const response = await fetch(
      `${SERVER_URL}/api/projects/${projectId}/batch-process`
    );
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        errorData.error || "Failed to fetch batch process status"
      );
    }
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to fetch batch process status",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const cancelBatchProcess = async (projectId) => {
  try {
    const response = await fetch(
      `${SERVER_URL}/api/projects/${projectId}/batch-process`,
      {
        method: "DELETE",
      }
    );
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to cancel batch process");
    }
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to cancel batch process",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const aiAutoFix = async (question) => {
  try {
    console.log("fetch to ai send...");
    const response = await fetch(`${SERVER_URL}/api/ai-autofix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    console.log("ai data reveived:");
    console.log(data);

    if (data.error) {
      throw new Error(data.error);
    }

    return data.text;
  } catch (error) {
    toaster.create({
      title: "AI Auto Fix Error",
      description: error.message || "Failed to process AI auto fix",
      type: "error",
      duration: 5000,
    });
    throw error;
  }
};

// User management functions
export const fetchUsers = async () => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/users`);
    if (!response.ok) throw new Error("Failed to fetch users");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to fetch users",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const createUser = async (userData) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/users`, {
      method: "POST",
      body: JSON.stringify(userData),
    });
    if (!response.ok) throw new Error("Failed to create user");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to create user",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const updateUser = async (userId, userData) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify(userData),
    });
    if (!response.ok) throw new Error("Failed to update user");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to update user",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const deleteUser = async (userId) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/users/${userId}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error("Failed to delete user");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to delete user",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const shareProject = async (userId, projectId) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/users/${userId}/projects/${projectId}/share`, {
      method: "POST",
    });
    if (!response.ok) throw new Error("Failed to share project");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to share project",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const unshareProject = async (userId, projectId) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/users/${userId}/projects/${projectId}/unshare`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error("Failed to unshare project");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to unshare project",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};

export const updateProjectShares = async (projectId, userIds) => {
  try {
    const response = await apiRequest(`${SERVER_URL}/api/projects/${projectId}/shares`, {
      method: "POST",
      body: JSON.stringify({ user_ids: userIds }),
    });
    if (!response.ok) throw new Error("Failed to update project shares");
    return await response.json();
  } catch (error) {
    toaster.create({
      title: "Error",
      description: error.message || "Failed to update project shares",
      type: "error",
      duration: 3000,
    });
    throw error;
  }
};
