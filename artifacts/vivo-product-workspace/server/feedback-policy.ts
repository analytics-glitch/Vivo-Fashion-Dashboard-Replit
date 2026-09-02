export const FEEDBACK_QUARTER_START_SQL = "date_trunc('quarter', CURRENT_DATE)";
export const FEEDBACK_IMAGE_MAX_FILES = 4;
export const FEEDBACK_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_IMAGE_UPLOAD_TTL_SECONDS = 15 * 60;
export const FEEDBACK_IMAGE_UPLOAD_RATE_WINDOW_MS = 10 * 60 * 1000;
export const FEEDBACK_IMAGE_UPLOAD_RATE_LIMIT = 20;
export const FEEDBACK_CUSTOMER_SEARCH_MIN_LENGTH = 2;
export const FEEDBACK_CUSTOMER_SEARCH_LIMIT = 8;
export const FEEDBACK_CUSTOMER_SEARCH_RATE_WINDOW_MS = 10 * 60 * 1000;
export const FEEDBACK_CUSTOMER_SEARCH_RATE_LIMIT = 30;
export const FEEDBACK_PREVIEW_STATUSES = ["pending", "generating", "ready", "failed"] as const;
export type FeedbackPreviewStatus = (typeof FEEDBACK_PREVIEW_STATUSES)[number];

const FEEDBACK_IMAGE_TYPES = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
} as const;

export type FeedbackImageContentType = keyof typeof FEEDBACK_IMAGE_TYPES;

export function feedbackImagePreviewUrl(imageId: unknown, contentType: unknown, status: unknown) {
  const id = Number(imageId);
  const normalizedType = String(contentType ?? "").trim().toLowerCase();
  return Number.isInteger(id) && id > 0 &&
    (normalizedType === "image/heic" || normalizedType === "image/heif") &&
    status === "ready"
    ? `/api/workspace/feedback/images/${id}/preview`
    : null;
}

export function feedbackImageExtension(name: unknown) {
  const value = String(name ?? "").trim().toLowerCase();
  const match = /\.([a-z0-9]{2,5})$/.exec(value);
  return match?.[1] ?? "";
}

export function validateFeedbackImageMeta(name: unknown, size: unknown, contentType: unknown) {
  const originalName = String(name ?? "").trim().replace(/[^\w.\- ()]/g, "_").slice(0, 200);
  const byteSize = Number(size);
  const declaredType = String(contentType ?? "").trim().toLowerCase() as FeedbackImageContentType;
  const extension = feedbackImageExtension(originalName);
  const extensions = FEEDBACK_IMAGE_TYPES[declaredType];
  if (!originalName || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > FEEDBACK_IMAGE_MAX_BYTES) {
    return { error: `Images must be smaller than ${FEEDBACK_IMAGE_MAX_BYTES / (1024 * 1024)} MB` as const };
  }
  if (!extensions || !extensions.includes(extension as never)) {
    return { error: "Use a JPEG, PNG, HEIC, or HEIF image with a matching file extension" as const };
  }
  return { originalName, byteSize, declaredType };
}

export function detectFeedbackImageContentType(bytes: Uint8Array): FeedbackImageContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length < 16 || bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return null;
  const brand = new TextDecoder().decode(bytes.slice(8, 12));
  if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
  if (["mif1", "msf1"].includes(brand)) return "image/heif";
  return null;
}

export function validateFeedbackImageUpload(bytes: Uint8Array, declaredSize: unknown, declaredType: FeedbackImageContentType, requestType: unknown) {
  const normalizedRequestType = String(requestType ?? "").split(";")[0].trim().toLowerCase();
  if (bytes.length < 1 || bytes.length > FEEDBACK_IMAGE_MAX_BYTES) return { error: "Images must be smaller than 8 MB" as const };
  if (bytes.length !== Number(declaredSize) || normalizedRequestType !== declaredType || detectFeedbackImageContentType(bytes) !== declaredType) {
    return { error: "The image did not match its selected file type or size" as const };
  }
  return { valid: true as const };
}

export function feedbackImageTokens(value: unknown) {
  if (!Array.isArray(value)) return { tokens: [], valid: true };
  const values = value.map((entry) => String(entry).trim());
  const valid = values.filter((token) => /^[a-f0-9]{64}$/.test(token));
  return {
    tokens: Array.from(new Set(valid)),
    valid: values.length === valid.length && valid.length <= FEEDBACK_IMAGE_MAX_FILES && new Set(valid).size === valid.length,
  };
}

export function feedbackCustomerOrigin(value: unknown) {
  return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

export function normalizeFeedbackCustomerName(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
}

export function normalizeFeedbackCustomerId(value: unknown) {
  return String(value ?? "").trim().slice(0, 120);
}