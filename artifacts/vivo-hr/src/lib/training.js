import axios from "axios";

// Staff Training analytics — backed by the real Google Sheet
// (`hr_training*` tables synced from the Training spreadsheet) served by this
// project's FastAPI backend under /api/hr/training. The same staff session
// gates these endpoints via the httpOnly `session_token` cookie, which the
// browser attaches automatically on these same-origin requests (no Bearer
// header — the token is deliberately not exposed to JavaScript).
export const TRAINING_API = "/api/hr/training";

export const trainingClient = axios.create({ baseURL: TRAINING_API });
