import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  Filter,
  Image as ImageIcon,
  ImagePlus,
  LoaderCircle,
  MessageCircle,
  Search,
  ShieldCheck,
  Share2,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";

export type FeedbackImageAttachment = {
  id: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  viewUrl: string;
  downloadUrl: string;
};

export type FeedbackSubmission = {
  id: number | string;
  submitterName: string;
  submitterTeam: string;
  styleId: number | null;
  styleName: string;
  styleNumber: string | null;
  colourway: string;
  styleImage?: string | null;
  styleNameFreetext: string;
  pulseId: number | null;
  pulseMode: "investigate" | "champion" | null;
  feedbackTypes: string[];
  sentiment: "positive" | "mixed" | "negative";
  urgency: "note" | "discuss" | "urgent";
  commentText: string;
  reviewed: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  imageAttachments: FeedbackImageAttachment[];
};

export type FeedbackStyleResult = {
  id: number | null;
  name: string;
  code: string;
  image?: string | null;
  status?: string | null;
};

type FeedbackAnalytics = {
  viewer?: { role: string | null };
  stats?: {
    totalSubmissionsThisQuarter?: number;
    mostFlaggedStyleThisQuarter?: string | null;
    mostCommonFeedbackTypeThisQuarter?: string | null;
    negativePercentThisQuarter?: number;
  };
  submissions?: FeedbackSubmission[];
  styleSummaries?: Array<Record<string, unknown>>;
  stylePulses?: StylePulse[];
};

const feedbackTypeOptions = [
  { label: "Sizing", hint: "e.g. Not true to size" },
  { label: "Fit", hint: "e.g. Arms fit very tight" },
  { label: "Fabric Quality", hint: undefined },
  { label: "Stitching Quality", hint: "e.g. Seams ripping" },
  { label: "Price", hint: "e.g. Customers complaining it's too expensive" },
  { label: "Stock Availability", hint: "e.g. Supply not meeting demand" },
  { label: "Style Adjustments", hint: "e.g. Too short" },
  { label: "Colour & Print", hint: "e.g. Customers asking for it in Red" },
  { label: "Other", hint: undefined },
] as const;
const feedbackTypes = feedbackTypeOptions.map(({ label }) => label);
const pulseInvestigateTypes = ["Fit doesn't work for our customer", "Fabric feels low quality", "Price feels too high", "Colour/print not right for this market", "Poor VM / hard to style on the floor", "Customers haven't noticed it", "Size availability issues", "Strong competition from another style", "Other"];
const pulseChampionTypes = ["The fit is excellent", "Fabric quality stands out", "Great value for money", "Colour/print is a hit", "Versatile — works for multiple occasions", "Customers are recommending it to others", "Strong repeat purchases", "VM / styling is working well", "Other"];
type PulseMode = "investigate" | "champion";
type StylePulse = {
  id: number;
  styleId: number | null;
  styleNumber: string;
  styleName: string;
  styleImage?: string | null;
  mode: PulseMode;
  colourway?: string | null;
  sharePath: string;
  createdAt: string;
  responseCount: number;
};
const teamOptions = [
  "Vivo Sarit", "Vivo Junction", "Vivo Moi Avenue", "Vivo Mama Ngina St", "Vivo Yaya", "Vivo Village Market",
  "Vivo Garden City", "Vivo Kigali Heights", "Vivo Acacia", "Vivo Galleria", "Vivo Capital Centre", "Vivo Two Rivers",
  "Vivo Imaara", "Vivo Hub", "Vivo Runda", "Vivo TRM", "Vivo Nakuru", "Vivo City Mall", "Vivo Eldoret",
  "The Oasis Mall", "Vivo Kisumu", "Vivo Signature Mall", "Safari Sarit & Zoya", "Vivo MSA Digo Road",
  "Vivo Kileleshwa", "Vivo T-Mall", "Vivo Greenspan", "Vivo Meru", "Online Team", "Marketing Team",
  "Customer Service", "Other",
];
const departmentOptions = [
  "Retail", "E-commerce", "CEX", "Production",
  "QC", "Studio", "Warehouse", "Other",
];
const feedbackImageTypes = ["image/jpeg", "image/png", "image/heic", "image/heif"];
const feedbackImageExtensions: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif" };
const feedbackImageMaxFiles = 4;
const feedbackImageMaxBytes = 8 * 1024 * 1024;

type PendingFeedbackImage = {
  id: string;
  file: File;
  contentType: string;
  previewUrl: string | null;
  progress: number;
  state: "ready" | "uploading" | "uploaded" | "error";
  uploadToken?: string;
  error?: string;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error || `Request failed (${response.status})`));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function feedbackFileContentType(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const byExtension = feedbackImageExtensions[extension] || "";
  return feedbackImageTypes.includes(file.type) && file.type === byExtension ? file.type : "";
}

function putFeedbackImage(url: string, uploadToken: string, file: File, contentType: string, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const upload = new XMLHttpRequest();
    upload.open("PUT", url);
    upload.setRequestHeader("Content-Type", contentType);
    upload.setRequestHeader("X-Feedback-Upload-Token", uploadToken);
    upload.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.max(1, Math.round((event.loaded / event.total) * 100)));
    };
    upload.onerror = () => reject(new Error("The image upload was interrupted"));
    upload.onload = () => upload.status >= 200 && upload.status < 300
      ? resolve()
      : reject(new Error(`The image upload failed (${upload.status})`));
    upload.send(file);
  });
}

function imageSizeLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.max(1, Math.round(bytes / 1024 / 1024 * 10) / 10)} MB`;
}

function submissionsFrom(value: unknown): FeedbackSubmission[] {
  if (Array.isArray(value)) return value as FeedbackSubmission[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.submissions)) return record.submissions as FeedbackSubmission[];
  if (Array.isArray(record.items)) return record.items as FeedbackSubmission[];
  return [];
}

function styleResultsFrom(value: unknown): FeedbackStyleResult[] {
  if (Array.isArray(value)) return value as FeedbackStyleResult[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items as FeedbackStyleResult[];
  if (Array.isArray(record.styles)) return record.styles as FeedbackStyleResult[];
  if (Array.isArray(record.results)) return record.results as FeedbackStyleResult[];
  return [];
}

function displayDate(value: unknown) {
  if (!value) return "No date";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function shortTime(value: unknown) {
  if (!value) return "";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function sentimentLabel(value: FeedbackSubmission["sentiment"]) {
  return value === "positive" ? "Positive" : value === "negative" ? "Negative" : "Mixed";
}

function sentimentIcon(value: FeedbackSubmission["sentiment"], size = 15) {
  if (value === "positive") return <ThumbsUp size={size} />;
  if (value === "negative") return <ThumbsDown size={size} />;
  return <CircleAlert size={size} />;
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "VT";
}

export function useFeedbackAnalytics() {
  return useQuery<FeedbackAnalytics>({
    queryKey: ["workspace", "feedback"],
    queryFn: () => request<FeedbackAnalytics>("/api/workspace/feedback"),
  });
}

export function useStyleFeedback(styleId: number) {
  return useQuery<FeedbackSubmission[]>({
    queryKey: ["workspace", "feedback", "style", styleId],
    queryFn: async () => {
      const response = await request<unknown>(`/api/workspace/feedback?styleId=${encodeURIComponent(styleId)}`);
      return submissionsFrom(response);
    },
    enabled: Boolean(styleId),
  });
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="feedback-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function FeedbackStyleSearch({
  value,
  selected,
  onChange,
  onSelect,
}: {
  value: string;
  selected: FeedbackStyleResult | null;
  onChange: (value: string) => void;
  onSelect: (style: FeedbackStyleResult | null) => void;
}) {
  const results = useQuery<FeedbackStyleResult[]>({
    queryKey: ["feedback", "style-search", value],
    enabled: value.trim().length > 1 && !selected,
    queryFn: async () => styleResultsFrom(await request<unknown>(`/api/workspace/feedback/styles/search?q=${encodeURIComponent(value.trim())}`)),
  });
  const showResults = !selected && value.trim().length > 1;
  return <div className="feedback-style-search">
    <div className={`feedback-search-input ${selected ? "has-selection" : ""}`}>
      <Search size={16} />
      <input
        value={selected ? `${selected.code} · ${selected.name}` : value}
        onChange={(event) => { onSelect(null); onChange(event.target.value); }}
        placeholder="Search by style name or number"
        aria-label="Search for a style"
        data-testid="input-feedback-style-search"
      />
      {selected && <button type="button" onClick={() => { onSelect(null); onChange(""); }} aria-label="Clear selected style" data-testid="button-clear-feedback-style"><X size={15} /></button>}
    </div>
    {showResults && <div className="feedback-search-results" role="listbox" aria-label="Style search results">
      {results.isLoading && <div className="feedback-search-loading">Searching the style catalogue…</div>}
       {!results.isLoading && results.data?.length ? results.data.slice(0, 6).map((style) => <button type="button" key={`${style.id ?? "unlinked"}-${style.code}`} role="option" className="feedback-style-option" onClick={() => { onSelect(style); onChange(""); }} data-testid={`option-feedback-style-${style.id ?? style.code}`}>
        <span className="feedback-style-thumb">{style.image ? <img src={style.image} alt="" /> : <span>{style.code.slice(-2)}</span>}</span>
        <span><b>{style.name}</b><small>{style.code}{style.status ? ` · ${style.status}` : ""}</small></span>
        <ArrowRight size={14} />
      </button>) : null}
       {!results.isLoading && !results.data?.length && <div className="feedback-search-loading">No matching style found. Try a style number or name.</div>}
    </div>}
  </div>;
}

export function PublicFeedbackPage() {
  const generalColourway = "All colourways / General";
  const pulseParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const targetStyleNumber = pulseParams.get("style")?.trim() || "";
  const pulseModeParam = pulseParams.get("mode")?.trim();
  const pulseMode = pulseModeParam === "investigate" || pulseModeParam === "champion" ? pulseModeParam as PulseMode : null;
  const isPulse = Boolean(targetStyleNumber && pulseMode);
  const targetColourway = pulseParams.get("colourway")?.trim() || generalColourway;
  const pulseTypes = pulseMode === "investigate" ? pulseInvestigateTypes : pulseMode === "champion" ? pulseChampionTypes : feedbackTypes;
  const [form, setForm] = useState({
    submitterName: "",
    submitterTeam: "",
    colourway: targetColourway,
    feedbackTypes: [] as string[],
    commentText: "",
  });
  const [styleSearch, setStyleSearch] = useState("");
  const [style, setStyle] = useState<FeedbackStyleResult | null>(null);
  const [typesOpen, setTypesOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [images, setImages] = useState<PendingFeedbackImage[]>([]);
  const [imageError, setImageError] = useState("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  const typePickerRef = useRef<HTMLDivElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);
  const imagesRef = useRef<PendingFeedbackImage[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => {
    if (!typesOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!typePickerRef.current?.contains(event.target as Node)) setTypesOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTypesOpen(false);
      typeTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [typesOpen]);
  useEffect(() => () => {
    imagesRef.current.forEach((image) => { if (image.previewUrl) URL.revokeObjectURL(image.previewUrl); });
  }, []);
  const targetStyleQuery = useQuery<FeedbackStyleResult[]>({
    queryKey: ["feedback", "pulse-style", targetStyleNumber],
    enabled: isPulse,
    queryFn: async () => styleResultsFrom(await request<unknown>(`/api/workspace/feedback/styles/search?q=${encodeURIComponent(targetStyleNumber)}`)),
    staleTime: 5 * 60 * 1000,
  });
  const pulseResolution = useQuery<{ id: number | null }>({
    queryKey: ["feedback", "pulse-resolve", targetStyleNumber, pulseMode],
    enabled: isPulse,
    queryFn: () => request<{ id: number | null }>(`/api/workspace/feedback/pulses/resolve?style=${encodeURIComponent(targetStyleNumber)}&mode=${pulseMode}`),
    staleTime: 60 * 1000,
  });
  useEffect(() => {
    if (!isPulse || style || !targetStyleQuery.data?.length) return;
    const exact = targetStyleQuery.data.find((entry) => entry.code.toLowerCase() === targetStyleNumber.toLowerCase()) || targetStyleQuery.data[0];
    if (exact) setStyle(exact);
  }, [isPulse, style, targetStyleNumber, targetStyleQuery.data]);
  const styleNumber = style?.code || "";
  const colourways = useQuery<string[]>({
    queryKey: ["feedback", "colourways", styleNumber],
    enabled: Boolean(styleNumber),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const response = await request<unknown>(`/api/workspace/feedback/styles/${encodeURIComponent(styleNumber)}/colourways`);
      return Array.isArray(response) ? response.map(String) : [];
    },
  });
  const colourwayOptions = Array.from(new Set([generalColourway, targetColourway, ...(colourways.data || [])]));
  useEffect(() => {
    if (!isPulse || targetColourway === generalColourway || !colourways.data?.length) return;
    const matched = colourways.data.find((value) => value.toLowerCase() === targetColourway.toLowerCase());
    setForm((current) => ({ ...current, colourway: matched || generalColourway }));
  }, [colourways.data, generalColourway, isPulse, targetColourway]);
  const canSubmit = Boolean(
    form.submitterName.trim()
      && form.submitterTeam.trim()
      && style?.code
      && form.feedbackTypes.length
      && form.commentText.trim().length >= 8,
  );
  const imagesReady = images.every((image) => image.state !== "uploading");
  const updateImage = (id: string, patch: Partial<PendingFeedbackImage>) => setImages((current) => current.map((image) => image.id === id ? { ...image, ...patch } : image));
  const uploadImage = async (image: PendingFeedbackImage) => {
    if (image.uploadToken) return image.uploadToken;
    updateImage(image.id, { state: "uploading", progress: 1, error: "" });
    try {
      const handshake = await request<{ uploadUrl: string; uploadToken: string }>("/api/workspace/feedback/public/upload-url", {
        method: "POST",
        body: JSON.stringify({ name: image.file.name, size: image.file.size, contentType: image.contentType }),
      });
      await putFeedbackImage(handshake.uploadUrl, handshake.uploadToken, image.file, image.contentType, (progress) => updateImage(image.id, { progress }));
      updateImage(image.id, { state: "uploaded", progress: 100, uploadToken: handshake.uploadToken });
      return handshake.uploadToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not upload this image";
      updateImage(image.id, { state: "error", error: message, progress: 0 });
      throw error;
    }
  };
  const submit = useMutation({
    mutationFn: async () => {
      const imageTokens = await Promise.all(images.map(uploadImage));
      return request<FeedbackSubmission>("/api/workspace/feedback/public", {
        method: "POST",
        body: JSON.stringify({
          submitterName: form.submitterName.trim(),
          submitterTeam: form.submitterTeam.trim(),
          styleId: style?.id ?? null,
          styleName: style?.name || "",
          styleNumber: style?.code || "",
          colourway: form.colourway,
          feedbackTypes: form.feedbackTypes,
          pulseMode: isPulse ? pulseMode : null,
          pulseCampaignId: isPulse ? pulseResolution.data?.id ?? null : null,
          sentiment: "mixed",
          urgency: "note",
          commentText: form.commentText.trim(),
          feedbackImageTokens: imageTokens,
        }),
      });
    },
    onSuccess: () => setSubmitted(true),
  });
  const toggleType = (type: string) => setForm((current) => ({
    ...current,
    feedbackTypes: current.feedbackTypes.includes(type)
      ? current.feedbackTypes.filter((item) => item !== type)
      : [...current.feedbackTypes, type],
  }));
  const closeTypes = () => {
    setTypesOpen(false);
    typeTriggerRef.current?.focus();
  };
  const reset = () => {
    setSubmitted(false);
    if (!isPulse) {
      setStyle(null);
      setStyleSearch("");
    }
    setTypesOpen(false);
    images.forEach((image) => { if (image.previewUrl) URL.revokeObjectURL(image.previewUrl); });
    setImages([]);
    setImageError("");
    setForm({ submitterName: "", submitterTeam: "", colourway: isPulse ? targetColourway : generalColourway, feedbackTypes: [], commentText: "" });
  };
  const chooseImages = (files: FileList | null) => {
    if (!files || submit.isPending) return;
    const available = feedbackImageMaxFiles - images.length;
    const selected = Array.from(files);
    const accepted: PendingFeedbackImage[] = [];
    const errors: string[] = [];
    for (const file of selected) {
      const contentType = feedbackFileContentType(file);
      if (!contentType) {
        errors.push(`${file.name}: use JPEG, PNG, HEIC, or HEIF.`);
      } else if (file.size < 1 || file.size > feedbackImageMaxBytes) {
        errors.push(`${file.name}: images must be no larger than 8 MB.`);
      } else if (accepted.length >= available) {
        errors.push(`You can attach up to ${feedbackImageMaxFiles} images.`);
      } else {
        accepted.push({
          id: crypto.randomUUID(),
          file,
          contentType,
          previewUrl: contentType === "image/heic" || contentType === "image/heif" ? null : URL.createObjectURL(file),
          progress: 0,
          state: "ready",
        });
      }
    }
    if (accepted.length) setImages((current) => [...current, ...accepted]);
    setImageError(errors.join(" "));
    if (imageInputRef.current) imageInputRef.current.value = "";
  };
  const removeImage = (id: string) => {
    if (submit.isPending) return;
    setImages((current) => {
      const image = current.find((item) => item.id === id);
      if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
      return current.filter((item) => item.id !== id);
    });
    setImageError("");
  };
  return <main className="public-feedback-page">
    <header className="public-feedback-header">
      <a href="/" className="public-feedback-brand" aria-label="Vivo home" data-testid="link-feedback-vivo-home"><span>V</span><strong>Vivo</strong></a>
      <div className="public-feedback-header-meta"><ShieldCheck size={14} /> Internal product feedback</div>
    </header>
    <div className="public-feedback-layout">
      <section className="public-feedback-card" aria-labelledby="feedback-form-title">
        {submitted ? <div className="feedback-success">
          <div className="feedback-success-mark"><CircleCheck size={28} /></div>
          <span className="feedback-kicker">Received by the product room</span>
          <h2>Thank you!</h2>
          <p>Your feedback has been submitted and the product team will review it.</p>
          <button className="feedback-button dark" type="button" onClick={reset} data-testid="button-submit-another-feedback">Submit another <ArrowRight size={16} /></button>
        </div> : <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (canSubmit) submit.mutate(); }} className="public-feedback-form">
          <div className="feedback-form-heading"><div><h2 id="feedback-form-title">Style Feedback Form</h2></div><span className="feedback-required">* Required</span></div>

          <section className="feedback-step feedback-step-who" aria-labelledby="feedback-step-who">
            <div className="feedback-step-heading"><span className="feedback-step-number">1</span><div><h3 id="feedback-step-who">Who are you?</h3></div></div>
            <div className="feedback-form-grid">
              <div className="feedback-field"><input required value={form.submitterName} onChange={(event) => setForm((current) => ({ ...current, submitterName: event.target.value }))} placeholder="Your name" autoComplete="name" aria-label="Your name" data-testid="input-feedback-name" /></div>
              <Field label="Department"><select required value={form.submitterTeam} onChange={(event) => setForm((current) => ({ ...current, submitterTeam: event.target.value }))} data-testid="select-feedback-department"><option value="">Select your department…</option>{departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}</select></Field>
            </div>
          </section>

          <section className="feedback-step feedback-step-style" aria-labelledby="feedback-step-style">
            <div className="feedback-step-heading"><span className="feedback-step-number">2</span><div><h3 id="feedback-step-style">Which style?</h3></div></div>
            {isPulse ? <div className="feedback-pulse-locked-style"><span>Style Pulse is focused on</span><strong>{style?.name || (targetStyleQuery.isLoading ? "Loading style…" : targetStyleNumber)}</strong><small>{style?.code || targetStyleNumber}{style?.status ? ` · ${style.status}` : ""}</small></div> : <Field label="Search the style catalogue"><FeedbackStyleSearch value={styleSearch} selected={style} onChange={setStyleSearch} onSelect={(selected) => { setStyle(selected); setForm((current) => ({ ...current, colourway: generalColourway })); }} /></Field>}
            {isPulse && targetStyleQuery.isError && <div className="feedback-form-error"><CircleAlert size={16} /> We couldn't find that style in the catalogue.</div>}
            {style && <div className={`feedback-style-confirmation ${style.image ? "" : "no-image"}`} data-testid="feedback-style-confirmation">
              <div className="feedback-style-confirmation-media">{style.image ? <img src={style.image} alt="" /> : <ImageIcon size={20} />}</div>
               <div className="feedback-style-confirmation-copy"><span>{isPulse ? "Style Pulse focus" : "Style selected"}</span><strong>{style.name}</strong><small>{style.code}</small></div>
               {!isPulse && <button type="button" className="feedback-style-change" onClick={() => { setStyle(null); setStyleSearch(""); setForm((current) => ({ ...current, colourway: generalColourway })); }} data-testid="button-change-feedback-style">Change</button>}
            </div>}
          </section>

          {style && <section className="feedback-step feedback-step-colourway" aria-labelledby="feedback-step-colourway">
            <div className="feedback-step-heading"><h3 id="feedback-step-colourway">Which colourway?</h3></div>
            <Field label="Colourway"><select value={form.colourway} onChange={(event) => setForm((current) => ({ ...current, colourway: event.target.value }))} data-testid="select-feedback-colourway" disabled={colourways.isLoading}><option value={generalColourway}>{generalColourway}</option>{colourwayOptions.filter((value) => value !== generalColourway).map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
            {colourways.isLoading && <p className="feedback-loading-note">Loading available colourways…</p>}
          </section>}

          <section className="feedback-step feedback-step-issue" aria-labelledby="feedback-step-issue">
            <div className="feedback-step-heading"><span className="feedback-step-number">3</span><div><h3 id="feedback-step-issue">{isPulse ? pulseMode === "investigate" ? "What’s getting in the way?" : "What’s working well?" : "What's the issue?"}</h3></div></div>
            <fieldset className="feedback-issue-fieldset">
              <legend>Choose all that apply</legend>
               <div ref={typePickerRef} className={`feedback-type-picker ${typesOpen ? "open" : ""}`}>
                 <button ref={typeTriggerRef} type="button" className="feedback-type-trigger" onClick={() => setTypesOpen((open) => !open)} aria-expanded={typesOpen} aria-controls="feedback-type-options"><span>{form.feedbackTypes.length ? `${form.feedbackTypes.length} selected · ${form.feedbackTypes.slice(0, 2).join(", ")}${form.feedbackTypes.length > 2 ? "…" : ""}` : isPulse ? pulseMode === "investigate" ? "Select the barriers you’re hearing" : "Select the reasons customers love it" : "Select one or more issue types"}</span><ChevronDown size={16} /></button>
                  {typesOpen && <div className="feedback-type-options" id="feedback-type-options" role="group" aria-label="Feedback issue types">{pulseTypes.map((type) => {
                   const hint = !isPulse ? feedbackTypeOptions.find((option) => option.label === type)?.hint : undefined;
                   return <label key={type} className={`feedback-type-option ${form.feedbackTypes.includes(type) ? "selected" : ""}`}><input type="checkbox" checked={form.feedbackTypes.includes(type)} onChange={() => toggleType(type)} data-testid={`checkbox-feedback-type-${type.toLowerCase().replaceAll(" ", "-")}`} /><span className="feedback-type-copy"><strong>{type}</strong>{hint && <small>{hint}</small>}</span>{form.feedbackTypes.includes(type) && <Check size={15} />}</label>;
                  })}<button type="button" className="feedback-type-done" onClick={closeTypes} data-testid="button-close-feedback-types">Done</button></div>}
              </div>
            </fieldset>
          </section>

          <section className="feedback-step feedback-step-more" aria-labelledby="feedback-step-more">
            <div className="feedback-step-heading"><span className="feedback-step-number">4</span><div><h3 id="feedback-step-more">Tell us more</h3></div></div>
            <div className="feedback-field">
              {isPulse && <span>What are customers saying?</span>}
              <textarea required minLength={8} rows={6} value={form.commentText} onChange={(event) => setForm((current) => ({ ...current, commentText: event.target.value }))} placeholder={isPulse ? pulseMode === "investigate" ? "What are customers saying when they put it back?" : "What are customers saying when they buy it?" : "Share your specific feedback here."} aria-label={isPulse ? "What are customers saying?" : "Your feedback"} data-testid="textarea-feedback-comment" />
            </div>
          </section>

          <section className="feedback-step feedback-step-images" aria-labelledby="feedback-step-images">
            <div className="feedback-step-heading"><span className="feedback-step-number">5</span><div><span className="feedback-step-kicker">Optional</span><h3 id="feedback-step-images">Add photos</h3></div></div>
            <p className="feedback-image-help">Attach up to 4 JPEG, PNG, HEIC, or HEIF images (8 MB each) to show fit, quality, styling, or production details.</p>
            <input ref={imageInputRef} className="feedback-image-input" type="file" accept=".jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png,image/heic,image/heif" multiple onChange={(event) => chooseImages(event.target.files)} data-testid="input-feedback-images" />
            <button className="feedback-image-picker" type="button" onClick={() => imageInputRef.current?.click()} disabled={submit.isPending || images.length >= feedbackImageMaxFiles} data-testid="button-add-feedback-images"><ImagePlus size={16} /> Add photos <span>{images.length}/{feedbackImageMaxFiles}</span></button>
            {imageError && <div className="feedback-form-error"><CircleAlert size={16} /> {imageError}</div>}
            {!!images.length && <div className="feedback-image-list" aria-label="Selected feedback images">{images.map((image) => <article className={`feedback-image-card ${image.state}`} key={image.id}>
              <div className="feedback-image-preview">{image.previewUrl ? <img src={image.previewUrl} alt="" /> : <ImageIcon size={22} />}</div>
              <div className="feedback-image-copy"><strong>{image.file.name}</strong><small>{image.contentType.replace("image/", "").toUpperCase()} · {imageSizeLabel(image.file.size)}</small><span>{image.state === "uploading" ? <><LoaderCircle size={12} /> Uploading {image.progress}%</> : image.state === "uploaded" ? "Ready to attach" : image.state === "error" ? image.error : "Ready to upload when you submit"}</span></div>
              <button type="button" className="feedback-image-remove" onClick={() => removeImage(image.id)} disabled={submit.isPending} aria-label={`Remove ${image.file.name}`} data-testid={`button-remove-feedback-image-${image.id}`}><Trash2 size={15} /></button>
            </article>)}</div>}
          </section>

          {submit.isError && <div className="feedback-form-error"><CircleAlert size={16} /> {submit.error instanceof Error ? submit.error.message : "We couldn't send that note. Please try again."}</div>}
          {!canSubmit && <p className="feedback-inline-hint">Complete your name, department, style, issue type, and observation to submit.</p>}
          <div className="feedback-submit-step">
            <div className="feedback-step-heading"><span className="feedback-step-number">6</span><div><h3>Submit</h3></div></div>
            <button className="feedback-button dark feedback-submit" type="submit" disabled={submit.isPending || !canSubmit || !imagesReady} data-testid="button-submit-feedback">{submit.isPending ? "Sending to the room…" : "Submit feedback"} <ArrowRight size={16} /></button>
          </div>
          <p className="feedback-privacy"><ShieldCheck size={14} /> Shared with the Vivo product team for product decisions.</p>
        </form>}
      </section>
    </div>
    <footer className="public-feedback-footer"><span>Vivo Fashion Group</span><span>Product feedback / East Africa</span></footer>
  </main>;
}

function Metric({ label, value, note, accent }: { label: string; value: string; note: string; accent?: string }) {
  return <div className={`feedback-metric ${accent || ""}`}><span>{label}</span><strong data-testid={`metric-feedback-${label.toLowerCase().replaceAll(" ", "-")}`}>{value}</strong><small>{note}</small></div>;
}

function FeedbackAttachmentPreview({ attachment }: { attachment: FeedbackImageAttachment }) {
  const supportsPreview = attachment.contentType === "image/jpeg" || attachment.contentType === "image/png";
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!supportsPreview) return undefined;
    let cancelled = false;
    let currentUrl = "";
    void fetch(attachment.viewUrl, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load image");
        currentUrl = URL.createObjectURL(await response.blob());
        if (cancelled) URL.revokeObjectURL(currentUrl);
        else setObjectUrl(currentUrl);
      })
      .catch(() => { if (!cancelled) setUnavailable(true); });
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [attachment.viewUrl, supportsPreview]);
  return <article className="feedback-attachment" data-testid={`feedback-image-${attachment.id}`}>
    {supportsPreview && objectUrl && !unavailable
      ? <a href={objectUrl} target="_blank" rel="noreferrer" className="feedback-attachment-image" title={`Open ${attachment.filename} at full size`}><img src={objectUrl} alt={`Feedback attachment: ${attachment.filename}`} /></a>
      : <a href={attachment.downloadUrl} className="feedback-attachment-fallback" download><ImageIcon size={18} /><span>{supportsPreview ? "Image unavailable" : "HEIC / HEIF image"}</span></a>}
    <div><strong>{attachment.filename}</strong><small>{attachment.contentType.replace("image/", "").toUpperCase()} · {imageSizeLabel(attachment.sizeBytes)}</small><a href={attachment.downloadUrl} download><Download size={12} /> Download</a></div>
  </article>;
}

function FeedbackRow({ item, onReview, reviewing, canReview }: { item: FeedbackSubmission; onReview: (item: FeedbackSubmission) => void; reviewing: boolean; canReview: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = item.commentText.length > 190;
  return <article className={`feedback-row ${item.reviewed ? "reviewed" : ""}`} data-testid={`row-feedback-${item.id}`}>
    <div className={`feedback-sentiment-mark ${item.sentiment}`}>{sentimentIcon(item.sentiment, 17)}</div>
    <div className="feedback-row-main">
      <div className="feedback-row-top"><div><strong>{item.styleName || item.styleNameFreetext || "Unassigned style"}</strong>{item.styleNumber && <span className="mono">{item.styleNumber}</span>}</div><span className={`feedback-urgency-badge ${item.urgency}`}>{item.urgency === "urgent" ? "Needs attention" : item.urgency === "discuss" ? "Discuss soon" : "Note"}</span></div>
      <p className={!expanded && isLong ? "feedback-comment-truncated" : ""}>{item.commentText}</p>
      {isLong && <button className="feedback-comment-toggle" type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Read full comment"}</button>}
      <div className="feedback-row-meta"><span className="feedback-avatar">{initials(item.submitterName)}</span><span>{item.submitterName || "Vivo team"} · {item.submitterTeam || "Team"}</span><span className="feedback-dot">·</span><span>{displayDate(item.createdAt)} {shortTime(item.createdAt)}</span>{item.reviewed && <span className="reviewed-label"><Check size={12} /> Reviewed</span>}</div>
      <div className="feedback-tag-row">{(item.feedbackTypes || []).map((type) => <span key={type}>{type}</span>)}</div>
      {!!item.imageAttachments?.length && <section className="feedback-attachments" aria-label={`Images attached to feedback ${item.id}`}><span>Photos</span><div>{item.imageAttachments.map((attachment) => <FeedbackAttachmentPreview key={attachment.id} attachment={attachment} />)}</div></section>}
    </div>
     {canReview && !item.reviewed && <button className="feedback-review-button" type="button" onClick={() => onReview(item)} disabled={reviewing} data-testid={`button-review-feedback-${item.id}`}>{reviewing ? "Saving…" : "Mark reviewed"} <Check size={14} /></button>}
  </article>;
}

function styleSummaryFrom(items: FeedbackSubmission[]) {
  const map = new Map<string, { name: string; code: string; count: number; urgent: number; positive: number; mixed: number; negative: number; styleId: number | null; styleImage: string | null; latestComment: string; latestDate: string; feedbackTypes: Record<string, number> }>();
  items.forEach((item) => {
    const key = String(item.styleId ?? item.styleNumber ?? item.styleName ?? item.styleNameFreetext ?? "unassigned");
    const current = map.get(key) || { name: item.styleName || item.styleNameFreetext || "Unassigned style", code: item.styleNumber || "", count: 0, urgent: 0, positive: 0, mixed: 0, negative: 0, styleId: item.styleId, styleImage: item.styleImage || null, latestComment: item.commentText, latestDate: item.createdAt, feedbackTypes: {} };
    current.count += 1;
    current.urgent += item.urgency === "urgent" ? 1 : 0;
    current.positive += item.sentiment === "positive" ? 1 : 0;
    current.mixed += item.sentiment === "mixed" ? 1 : 0;
    current.negative += item.sentiment === "negative" ? 1 : 0;
    (item.feedbackTypes || []).forEach((type) => { current.feedbackTypes[type] = (current.feedbackTypes[type] || 0) + 1; });
    if (!current.styleImage && item.styleImage) current.styleImage = item.styleImage;
    map.set(key, current);
  });
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function PaletteFallback() {
  return <span className="feedback-summary-thumb-placeholder">Style</span>;
}

function StylePulsesView({ pulses }: { pulses: StylePulse[] }) {
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copyPulseLink = async (pulse: StylePulse) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${pulse.sharePath}`);
      setCopiedId(pulse.id);
      window.setTimeout(() => setCopiedId((current) => current === pulse.id ? null : current), 1800);
    } catch {
      setCopiedId(null);
    }
  };
  if (!pulses.length) return <div className="feedback-empty feedback-pulses-empty"><div><Share2 size={20} /></div><h3>No Style Pulses yet</h3><p>Create a Style Pulse from a PLM style.</p></div>;
  return <div className="feedback-pulses-list">
    {pulses.map((pulse) => {
      const link = `${window.location.origin}${pulse.sharePath}`;
      const modeLabel = pulse.mode === "investigate" ? "Investigate" : "Champion";
      return <article className="feedback-pulse-row" key={pulse.id} data-testid={`row-style-pulse-${pulse.id}`}>
        <div className={`feedback-pulse-row-mark ${pulse.mode}`}>{pulse.mode === "investigate" ? "!" : "★"}</div>
        <div className="feedback-pulse-row-image">{pulse.styleImage ? <img src={pulse.styleImage} alt="" /> : <ImageIcon size={18} />}</div>
        <div className="feedback-pulse-row-main"><div><span className={`feedback-pulse-mode ${pulse.mode}`}>{modeLabel}</span><strong>{pulse.styleName}</strong><small>{pulse.styleNumber}{pulse.colourway ? ` · ${pulse.colourway}` : ""}</small></div><span className="feedback-pulse-date">{displayDate(pulse.createdAt)}</span></div>
        <div className="feedback-pulse-response"><b>{pulse.responseCount}</b><span>{pulse.responseCount === 1 ? "response" : "responses"}</span></div>
        <div className="feedback-pulse-actions"><button type="button" className="button button-quiet" onClick={() => copyPulseLink(pulse)} data-testid={`button-copy-style-pulse-${pulse.id}`}><Copy size={13} />{copiedId === pulse.id ? "Copied" : "Copy link"}</button><a className="button button-quiet" href={`https://wa.me/?text=${encodeURIComponent(`Style Pulse · ${pulse.styleName}\n${link}`)}`} target="_blank" rel="noreferrer" data-testid={`button-whatsapp-style-pulse-${pulse.id}`}><Share2 size={13} /> WhatsApp</a></div>
      </article>;
    })}
  </div>;
}

export function WorkspaceFeedbackPage() {
  const queryClient = useQueryClient();
  const analytics = useFeedbackAnalytics();
  const [view, setView] = useState<"inbox" | "styles" | "pulses">("inbox");
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<"all" | "week" | "month">("all");
  const [teamFilter, setTeamFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sentimentFilter, setSentimentFilter] = useState<"all" | FeedbackSubmission["sentiment"]>("all");
  const [styleSearch, setStyleSearch] = useState("");
  const [status, setStatus] = useState<"all" | "open" | "reviewed">("all");
  const [urgency, setUrgency] = useState<"all" | "urgent" | "discuss">("all");
  const [reviewingId, setReviewingId] = useState<number | string | null>(null);
  const [copied, setCopied] = useState(false);
  const submissions = useMemo(() => submissionsFrom(analytics.data), [analytics.data]);
  const review = useMutation({
    mutationFn: (id: number | string) => request<FeedbackSubmission>(`/api/workspace/feedback/${id}/review`, { method: "PATCH", body: JSON.stringify({ reviewed: true }) }),
    onMutate: (id) => setReviewingId(id),
    onSuccess: (_updated, id) => {
      setReviewingId(null);
      queryClient.setQueryData<FeedbackAnalytics>(["workspace", "feedback"], (old) => old ? {
        ...old,
        submissions: submissionsFrom(old).map((item) => item.id === id ? { ...item, reviewed: true, reviewedAt: new Date().toISOString() } : item),
      } : old);
      queryClient.invalidateQueries({ queryKey: ["workspace", "feedback", "style"] });
    },
    onError: () => setReviewingId(null),
  });
  const filtered = useMemo(() => submissions.filter((item) => {
    const needle = search.trim().toLowerCase();
    const styleNeedle = styleSearch.trim().toLowerCase();
    const createdAt = new Date(item.createdAt).getTime();
    const cutoff = dateRange === "week" ? Date.now() - 7 * 24 * 60 * 60 * 1000 : dateRange === "month" ? Date.now() - 30 * 24 * 60 * 60 * 1000 : 0;
    return (!needle || `${item.styleName} ${item.styleNumber || ""} ${item.commentText} ${item.submitterName}`.toLowerCase().includes(needle))
      && (!styleNeedle || `${item.styleName} ${item.styleNumber || ""} ${item.styleNameFreetext}`.toLowerCase().includes(styleNeedle))
      && (!cutoff || (Number.isFinite(createdAt) && createdAt >= cutoff))
      && (teamFilter === "all" || item.submitterTeam === teamFilter)
      && (typeFilter === "all" || item.feedbackTypes.includes(typeFilter))
      && (sentimentFilter === "all" || item.sentiment === sentimentFilter)
      && (status === "all" || (status === "open" ? !item.reviewed : item.reviewed))
      && (urgency === "all" || item.urgency === urgency);
  }), [submissions, search, dateRange, teamFilter, typeFilter, sentimentFilter, styleSearch, status, urgency]);
  const openCount = submissions.filter((item) => !item.reviewed).length;
  const stats = analytics.data?.stats;
  const summaries = useMemo(() => styleSummaryFrom(filtered), [filtered]);
  const isAdmin = analytics.data?.viewer?.role === "Admin";
  const clearFilters = () => { setSearch(""); setStyleSearch(""); setDateRange("all"); setTeamFilter("all"); setTypeFilter("all"); setSentimentFilter("all"); setStatus("all"); setUrgency("all"); };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/feedback`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  if (analytics.isLoading) return <section className="page feedback-workspace-page"><div className="feedback-loading-heading" /><div className="feedback-loading-metrics"><span /><span /><span /><span /></div><div className="feedback-loading-panel" /></section>;
  if (analytics.isError) return <section className="page"><div className="empty-state error-state"><CircleAlert size={22} /><h3>Feedback inbox is unavailable</h3><p>{analytics.error instanceof Error ? analytics.error.message : "The workspace service did not respond."}</p><button className="button button-dark" onClick={() => analytics.refetch()} data-testid="button-retry-feedback">Try again</button></div></section>;
  return <section className="page feedback-workspace-page">
     <div className="feedback-workspace-heading"><div><h1>Feedback Inbox</h1></div><div className="feedback-heading-actions"><button className="button button-quiet" type="button" onClick={copyLink} data-testid="button-copy-feedback-link"><span>{copied ? "Copied" : "Copy feedback link"}</span><ArrowRight size={15} /></button><div className="feedback-heading-mark"><MessageCircle size={21} /><span>Live inbox</span></div></div></div>
     <div className="feedback-metrics"><Metric label="Submissions this quarter" value={String(stats?.totalSubmissionsThisQuarter ?? 0)} note="All teams · quarter to date" /><Metric label="Most flagged style" value={stats?.mostFlaggedStyleThisQuarter || "—"} note="This quarter" accent="gold" /><Metric label="Common feedback type" value={stats?.mostCommonFeedbackTypeThisQuarter || "—"} note="This quarter" accent="green" /><Metric label="Negative sentiment" value={`${stats?.negativePercentThisQuarter ?? 0}%`} note="This quarter" accent={(stats?.negativePercentThisQuarter ?? 0) >= 20 ? "coral" : "gold"} /></div>
      <div className="feedback-view-tabs" role="tablist"><button className={view === "inbox" ? "active" : ""} onClick={() => setView("inbox")} role="tab" aria-selected={view === "inbox"} data-testid="tab-feedback-inbox"><MessageCircle size={15} /> Inbox <span>{openCount}</span></button><button className={view === "styles" ? "active" : ""} onClick={() => setView("styles")} role="tab" aria-selected={view === "styles"} data-testid="tab-feedback-by-style"><Filter size={15} /> By style <span>{summaries.length}</span></button><button className={view === "pulses" ? "active" : ""} onClick={() => setView("pulses")} role="tab" aria-selected={view === "pulses"} data-testid="tab-feedback-style-pulses"><Share2 size={15} /> Style Pulses <span>{analytics.data?.stylePulses?.length ?? 0}</span></button></div>
     {view === "inbox" ? <div className="feedback-inbox-panel">
        <div className="feedback-toolbar"><label className="feedback-toolbar-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search feedback" aria-label="Search feedback" data-testid="input-search-feedback" />{search && <button onClick={() => setSearch("")} aria-label="Clear feedback search" data-testid="button-clear-feedback-search"><X size={14} /></button>}</label><div className="feedback-filter-group"><label><span>Date</span><select value={dateRange} onChange={(event) => setDateRange(event.target.value as typeof dateRange)} data-testid="select-feedback-date"><option value="all">All dates</option><option value="week">This week</option><option value="month">Last 30 days</option></select><ChevronDown size={13} /></label><label><span>Store / team</span><select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)} data-testid="select-feedback-team-filter"><option value="all">All stores and teams</option>{teamOptions.map((team) => <option key={team}>{team}</option>)}</select><ChevronDown size={13} /></label><label><span>Type</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} data-testid="select-feedback-type-filter"><option value="all">All types</option>{feedbackTypes.map((type) => <option key={type}>{type}</option>)}</select><ChevronDown size={13} /></label><label><span>Sentiment</span><select value={sentimentFilter} onChange={(event) => setSentimentFilter(event.target.value as typeof sentimentFilter)} data-testid="select-feedback-sentiment-filter"><option value="all">All sentiment</option><option value="positive">Positive</option><option value="mixed">Mixed</option><option value="negative">Negative</option></select><ChevronDown size={13} /></label><label><span>Style</span><input value={styleSearch} onChange={(event) => setStyleSearch(event.target.value)} placeholder="Style or number" aria-label="Filter by style" data-testid="input-filter-feedback-style" /></label><label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} data-testid="select-feedback-status"><option value="all">All feedback</option><option value="open">Open</option><option value="reviewed">Reviewed</option></select><ChevronDown size={13} /></label><label><span>Priority</span><select value={urgency} onChange={(event) => setUrgency(event.target.value as typeof urgency)} data-testid="select-feedback-urgency"><option value="all">All priorities</option><option value="urgent">Needs attention</option><option value="discuss">Discuss soon</option></select><ChevronDown size={13} /></label><button className="button button-quiet" type="button" onClick={clearFilters} data-testid="button-clear-feedback-filters">Clear</button></div></div>
       <div className="feedback-inbox-head"><h2>{filtered.length} {filtered.length === 1 ? "submission" : "submissions"}</h2></div>
        {filtered.length ? <div className="feedback-row-list">{filtered.map((item) => <FeedbackRow key={item.id} item={item} onReview={(entry) => review.mutate(entry.id)} reviewing={reviewingId === item.id} canReview={isAdmin} />)}</div> : <div className="feedback-empty"><div><MessageCircle size={20} /></div><h3>{submissions.length ? "Nothing matches" : "No feedback yet"}</h3><p>{submissions.length ? "Clear a filter or try another search." : "Submitted product feedback will appear here."}</p>{(search || styleSearch || dateRange !== "all" || teamFilter !== "all" || typeFilter !== "all" || sentimentFilter !== "all" || status !== "all" || urgency !== "all") && <button className="button button-quiet" onClick={clearFilters} data-testid="button-clear-feedback-filters-empty">Clear filters</button>}</div>}
       </div> : view === "styles" ? <div className="feedback-style-view"><div className="feedback-by-style-intro"><div><h2>Feedback by style</h2></div><p>See which styles receive the most feedback.</p></div>{summaries.length ? <div className="feedback-style-summary-list">{summaries.map((summary, index) => <article className="feedback-style-summary" key={`${summary.styleId}-${summary.code}-${summary.name}`} role="button" tabIndex={0} onClick={() => { setView("inbox"); setStyleSearch(summary.code || summary.name); }} onKeyDown={(event) => { if (event.key === "Enter") { setView("inbox"); setStyleSearch(summary.code || summary.name); } }} data-testid={`card-feedback-style-${summary.styleId || summary.code || summary.name}`}><div className="feedback-summary-index">{String(index + 1).padStart(2, "0")}</div><div className="feedback-summary-thumb">{summary.styleImage ? <img src={summary.styleImage} alt="" /> : <PaletteFallback />}</div><div className="feedback-summary-copy"><strong>{summary.name}</strong><span>{summary.code || "Style not linked"}</span><div className="feedback-sentiment-bar" aria-label={`${summary.positive} positive, ${summary.mixed} mixed, ${summary.negative} negative`}><i className="positive" style={{ width: `${summary.count ? (summary.positive / summary.count) * 100 : 0}%` }} /><i className="mixed" style={{ width: `${summary.count ? (summary.mixed / summary.count) * 100 : 0}%` }} /><i className="negative" style={{ width: `${summary.count ? (summary.negative / summary.count) * 100 : 0}%` }} /></div><div className="feedback-summary-type-pills">{Object.entries(summary.feedbackTypes || {}).sort(([, a], [, b]) => b - a).slice(0, 3).map(([type]) => <span key={type}>{type}</span>)}</div><p>{summary.latestComment}</p></div><div className="feedback-summary-count"><b>{summary.count}</b><span>{summary.count === 1 ? "submission" : "submissions"}</span><small>{summary.urgent ? `${summary.urgent} urgent` : "No urgent notes"}</small></div><ArrowRight size={16} /></article>)}</div> : <div className="feedback-empty"><div><Filter size={20} /></div><h3>No style feedback yet</h3><p>Feedback linked to a style will appear here.</p></div>}</div> : <StylePulsesView pulses={analytics.data?.stylePulses || []} />}
  </section>;
}

export function StyleFeedbackPanel({ styleId }: { styleId: number }) {
  const feedback = useStyleFeedback(styleId);
  const items = feedback.data || [];
  return <section className="style-feedback-panel" aria-labelledby="style-feedback-heading">
    <div className="style-feedback-heading"><div><span className="eyebrow gold-eyebrow">Customer voice</span><h2 id="style-feedback-heading">Feedback from the field <span>{items.length}</span></h2></div><span className="style-feedback-note"><MessageCircle size={15} /> Linked observations</span></div>
    {feedback.isLoading ? <div className="style-feedback-skeleton"><span /><span /><span /></div> : feedback.isError ? <div className="style-feedback-inline-error"><CircleAlert size={15} /> Could not load feedback for this style. <button onClick={() => feedback.refetch()} data-testid="button-retry-style-feedback">Try again</button></div> : items.length ? <div className="style-feedback-list">{items.map((item) => <div className="style-feedback-item" key={item.id} data-testid={`row-style-feedback-${item.id}`}><div className={`feedback-sentiment-mark ${item.sentiment}`}>{sentimentIcon(item.sentiment, 15)}</div><div><div className="style-feedback-item-top"><strong>{sentimentLabel(item.sentiment)}</strong><span>{displayDate(item.createdAt)}</span></div><p>{item.commentText}</p><small>{item.submitterName || "Vivo team"} · {item.submitterTeam || "Team"} · {(item.feedbackTypes || []).join(" · ")}</small></div></div>)}</div> : <div className="style-feedback-empty"><MessageCircle size={18} /><p>No feedback has been linked to this style yet.</p><a href="/feedback" data-testid="link-share-style-feedback">Share the first observation <ArrowRight size={14} /></a></div>}
  </section>;
}

export default function FeedbackPage() {
  return <WorkspaceFeedbackPage />;
}