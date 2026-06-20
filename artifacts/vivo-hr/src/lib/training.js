import axios from "axios";

// Staff Training analytics — backed by the real Google Sheet
// (`hr_training*` tables synced from the Training spreadsheet) served by this
// project's FastAPI backend under /api/hr/training. The same staff session
// gates these endpoints, so the Bearer token is attached from localStorage.
export const TRAINING_API = "/api/hr/training";

export const trainingClient = axios.create({ baseURL: TRAINING_API });

trainingClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("vivo_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
