import { useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Filter,
  MessageCircle,
  Search,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  UsersRound,
  X,
} from "lucide-react";

export type FeedbackSubmission = {
  id: number | string;
  submitterName: string;
  submitterTeam: string;
  styleId: number | null;
  styleName: string;
  styleNumber: string | null;
  styleImage?: string | null;
  styleNameFreetext: string;
  feedbackTypes: string[];
  sentiment: "positive" | "mixed" | "negative";
  urgency: "note" | "discuss" | "urgent";
  commentText: string;
  reviewed: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
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
    totalSubmissionsThisWeek?: number;
    mostFlaggedStyle?: string | null;
    mostCommonFeedbackType?: string | null;
    negativePercentThisWeek?: number;
  };
  submissions?: FeedbackSubmission[];
  styleSummaries?: Array<Record<string, unknown>>;
};

const feedbackTypes = ["Fit & Sizing", "Fabric & Quality", "Colour & Print", "Price & Value", "Styling & VM", "Customer Reaction", "Stock & Availability", "Other"];
const teamOptions = [
  "Vivo Sarit", "Vivo Junction", "Vivo Moi Avenue", "Vivo Mama Ngina St", "Vivo Yaya", "Vivo Village Market",
  "Vivo Garden City", "Vivo Kigali Heights", "Vivo Acacia", "Vivo Galleria", "Vivo Capital Centre", "Vivo Two Rivers",
  "Vivo Imaara", "Vivo Hub", "Vivo Runda", "Vivo TRM", "Vivo Nakuru", "Vivo City Mall", "Vivo Eldoret",
  "The Oasis Mall", "Vivo Kisumu", "Vivo Signature Mall", "Safari Sarit & Zoya", "Vivo MSA Digo Road",
  "Vivo Kileleshwa", "Vivo T-Mall", "Vivo Greenspan", "Vivo Meru", "Online Team", "Marketing Team",
  "Customer Service", "Other",
];

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
      {!results.isLoading && !results.data?.length && <div className="feedback-search-loading">No matching style found. Add a description below instead.</div>}
    </div>}
  </div>;
}

export function PublicFeedbackPage() {
  const [form, setForm] = useState({
    submitterName: "",
     submitterTeam: "Vivo Sarit",
    styleNameFreetext: "",
    feedbackTypes: [] as string[],
    sentiment: "mixed" as FeedbackSubmission["sentiment"],
    urgency: "note" as FeedbackSubmission["urgency"],
    commentText: "",
  });
  const [style, setStyle] = useState<FeedbackStyleResult | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const submit = useMutation({
    mutationFn: () => request<FeedbackSubmission>("/api/workspace/feedback/public", {
      method: "POST",
      body: JSON.stringify({
        submitterName: form.submitterName.trim(),
        submitterTeam: form.submitterTeam,
        styleId: style?.id ?? null,
        styleName: style?.name || form.styleNameFreetext.trim(),
        styleNumber: style?.code || null,
        styleNameFreetext: form.styleNameFreetext.trim(),
        feedbackTypes: form.feedbackTypes,
        sentiment: form.sentiment,
        urgency: form.urgency,
        commentText: form.commentText.trim(),
      }),
    }),
    onSuccess: () => setSubmitted(true),
  });
  const toggleType = (type: string) => setForm((current) => ({
    ...current,
    feedbackTypes: current.feedbackTypes.includes(type)
      ? current.feedbackTypes.filter((item) => item !== type)
      : [...current.feedbackTypes, type],
  }));
  const reset = () => {
    setSubmitted(false);
    setStyle(null);
    setForm({ submitterName: "", submitterTeam: "Vivo Sarit", styleNameFreetext: "", feedbackTypes: [], sentiment: "mixed", urgency: "note", commentText: "" });
  };
  return <main className="public-feedback-page">
    <header className="public-feedback-header">
      <a href="/" className="public-feedback-brand" aria-label="Vivo home" data-testid="link-feedback-vivo-home"><span>V</span><strong>Vivo</strong></a>
      <div className="public-feedback-header-meta"><ShieldCheck size={14} /> Internal product feedback</div>
    </header>
    <div className="public-feedback-layout">
      <section className="public-feedback-intro">
        <span className="feedback-kicker">A note from the floor</span>
        <h1>Share Style Feedback</h1>
        <p>Help us improve our product by sharing what you’re hearing from customers.</p>
        <div className="public-feedback-proof"><span><UsersRound size={16} /> Retail, marketing, online and service teams</span><span><Clock3 size={16} /> About two minutes</span></div>
      </section>
      <section className="public-feedback-card" aria-labelledby="feedback-form-title">
        {submitted ? <div className="feedback-success">
          <div className="feedback-success-mark"><CircleCheck size={28} /></div>
          <span className="feedback-kicker">Received by the product room</span>
          <h2>Thank you!</h2>
          <p>Your feedback has been submitted and the product team will review it.</p>
          <button className="feedback-button dark" type="button" onClick={reset} data-testid="button-submit-another-feedback">Submit another <ArrowRight size={16} /></button>
        </div> : <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (form.feedbackTypes.length) submit.mutate(); }} className="public-feedback-form">
          <div className="feedback-form-heading"><div><span className="feedback-kicker">Customer observation</span><h2 id="feedback-form-title">Leave a useful note.</h2></div><span className="feedback-required">Required fields marked</span></div>
          <div className="feedback-form-grid">
            <Field label="Your name"><input required value={form.submitterName} onChange={(event) => setForm((current) => ({ ...current, submitterName: event.target.value }))} placeholder="Name" data-testid="input-feedback-name" /></Field>
            <Field label="Your team / store"><select value={form.submitterTeam} onChange={(event) => setForm((current) => ({ ...current, submitterTeam: event.target.value }))} data-testid="select-feedback-team">{teamOptions.map((team) => <option key={team}>{team}</option>)}</select></Field>
          </div>
          <div className="feedback-form-section">
            <Field label="Which style is this about?" hint="Optional — search the live style catalogue or describe it below."><FeedbackStyleSearch value={form.styleNameFreetext} selected={style} onChange={(value) => setForm((current) => ({ ...current, styleNameFreetext: value }))} onSelect={setStyle} /></Field>
            <input className="feedback-style-description" value={form.styleNameFreetext} onChange={(event) => setForm((current) => ({ ...current, styleNameFreetext: event.target.value }))} placeholder="Or describe the style: black wrap dress, V26-041…" aria-label="Style name or description" data-testid="input-feedback-style-description" />
          </div>
          <fieldset className="feedback-form-section"><legend>Feedback type <span>Choose all that apply</span></legend><div className="feedback-chip-grid">{feedbackTypes.map((type) => <label key={type} className={`feedback-chip ${form.feedbackTypes.includes(type) ? "selected" : ""}`}><input type="checkbox" checked={form.feedbackTypes.includes(type)} onChange={() => toggleType(type)} data-testid={`checkbox-feedback-type-${type.toLowerCase().replaceAll(" ", "-")}`} /><span>{type}</span>{form.feedbackTypes.includes(type) && <Check size={14} />}</label>)}</div></fieldset>
          <fieldset className="feedback-form-section"><legend>Overall sentiment <span>How did the customer leave it?</span></legend><div className="feedback-choice-row">{(["positive", "mixed", "negative"] as const).map((value) => <label key={value} className={`feedback-choice ${form.sentiment === value ? `selected ${value}` : ""}`}><input type="radio" name="sentiment" checked={form.sentiment === value} onChange={() => setForm((current) => ({ ...current, sentiment: value }))} data-testid={`radio-feedback-sentiment-${value}`} /><span>{sentimentIcon(value, 17)}<b>{sentimentLabel(value)}</b></span></label>)}</div></fieldset>
          <fieldset className="feedback-form-section"><legend>Urgency <span>Use your best judgement</span></legend><div className="feedback-urgency-row">{(["note", "discuss", "urgent"] as const).map((value) => <label key={value} className={`feedback-urgency ${form.urgency === value ? "selected" : ""}`}><input type="radio" name="urgency" checked={form.urgency === value} onChange={() => setForm((current) => ({ ...current, urgency: value }))} data-testid={`radio-feedback-urgency-${value}`} /><span><b>{value === "note" ? "Just to note" : value === "discuss" ? "Worth discussing soon" : "Needs attention now"}</b><small>{value === "note" ? "Useful context" : value === "discuss" ? "Worth a product conversation" : "Could affect the next decision"}</small></span></label>)}</div></fieldset>
          <Field label="Tell us more" hint="A specific quote, fit detail or buying hesitation helps the team act."><textarea required minLength={8} rows={5} value={form.commentText} onChange={(event) => setForm((current) => ({ ...current, commentText: event.target.value }))} placeholder="What are customers saying? What have you observed? Be as specific as you can — style numbers, specific issues, exact quotes if possible." data-testid="textarea-feedback-comment" /></Field>
          {submit.isError && <div className="feedback-form-error"><CircleAlert size={16} /> We couldn't send that note. Please try again.</div>}
          {form.feedbackTypes.length === 0 && <p className="feedback-inline-hint">Select at least one observation type to send your note.</p>}
          <button className="feedback-button dark feedback-submit" type="submit" disabled={submit.isPending || !form.feedbackTypes.length} data-testid="button-submit-feedback">{submit.isPending ? "Sending to the room…" : "Send feedback"} <ArrowRight size={16} /></button>
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

export function WorkspaceFeedbackPage() {
  const queryClient = useQueryClient();
  const analytics = useFeedbackAnalytics();
  const [view, setView] = useState<"inbox" | "styles">("inbox");
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
     <div className="feedback-workspace-heading"><div><span className="eyebrow gold-eyebrow">Customer voice / product decisions</span><h1>Feedback, close to the work.</h1><p>A calm inbox for the observations that should shape the next Vivo collection.</p></div><div className="feedback-heading-actions"><button className="button button-quiet" type="button" onClick={copyLink} data-testid="button-copy-feedback-link"><span>{copied ? "Copied" : "Copy feedback link"}</span><ArrowRight size={15} /></button><div className="feedback-heading-mark"><MessageCircle size={21} /><span>Live inbox</span></div></div></div>
     <div className="feedback-metrics"><Metric label="Submissions this week" value={String(stats?.totalSubmissionsThisWeek ?? 0)} note="All teams" /><Metric label="Most flagged style" value={stats?.mostFlaggedStyle || "—"} note="This week" accent="gold" /><Metric label="Common feedback type" value={stats?.mostCommonFeedbackType || "—"} note="This week" accent="green" /><Metric label="Negative sentiment" value={`${stats?.negativePercentThisWeek ?? 0}%`} note="This week" accent={(stats?.negativePercentThisWeek ?? 0) >= 20 ? "coral" : "gold"} /></div>
    <div className="feedback-view-tabs" role="tablist"><button className={view === "inbox" ? "active" : ""} onClick={() => setView("inbox")} role="tab" aria-selected={view === "inbox"} data-testid="tab-feedback-inbox"><MessageCircle size={15} /> Inbox <span>{openCount}</span></button><button className={view === "styles" ? "active" : ""} onClick={() => setView("styles")} role="tab" aria-selected={view === "styles"} data-testid="tab-feedback-by-style"><Filter size={15} /> By style <span>{summaries.length}</span></button></div>
    {view === "inbox" ? <div className="feedback-inbox-panel">
       <div className="feedback-toolbar"><label className="feedback-toolbar-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes or people" aria-label="Search feedback" data-testid="input-search-feedback" />{search && <button onClick={() => setSearch("")} aria-label="Clear feedback search" data-testid="button-clear-feedback-search"><X size={14} /></button>}</label><div className="feedback-filter-group"><label><span>Date</span><select value={dateRange} onChange={(event) => setDateRange(event.target.value as typeof dateRange)} data-testid="select-feedback-date"><option value="all">All dates</option><option value="week">This week</option><option value="month">Last 30 days</option></select><ChevronDown size={13} /></label><label><span>Store / team</span><select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)} data-testid="select-feedback-team-filter"><option value="all">All stores and teams</option>{teamOptions.map((team) => <option key={team}>{team}</option>)}</select><ChevronDown size={13} /></label><label><span>Type</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} data-testid="select-feedback-type-filter"><option value="all">All types</option>{feedbackTypes.map((type) => <option key={type}>{type}</option>)}</select><ChevronDown size={13} /></label><label><span>Sentiment</span><select value={sentimentFilter} onChange={(event) => setSentimentFilter(event.target.value as typeof sentimentFilter)} data-testid="select-feedback-sentiment-filter"><option value="all">All sentiment</option><option value="positive">Positive</option><option value="mixed">Mixed</option><option value="negative">Negative</option></select><ChevronDown size={13} /></label><label><span>Style</span><input value={styleSearch} onChange={(event) => setStyleSearch(event.target.value)} placeholder="Style or number" aria-label="Filter by style" data-testid="input-filter-feedback-style" /></label><label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} data-testid="select-feedback-status"><option value="all">All notes</option><option value="open">Open</option><option value="reviewed">Reviewed</option></select><ChevronDown size={13} /></label><label><span>Priority</span><select value={urgency} onChange={(event) => setUrgency(event.target.value as typeof urgency)} data-testid="select-feedback-urgency"><option value="all">All priorities</option><option value="urgent">Needs attention</option><option value="discuss">Discuss soon</option></select><ChevronDown size={13} /></label><button className="button button-quiet" type="button" onClick={clearFilters} data-testid="button-clear-feedback-filters">Clear</button></div></div>
      <div className="feedback-inbox-head"><div><span className="eyebrow">The room</span><h2>{filtered.length} {filtered.length === 1 ? "observation" : "observations"}</h2></div><span className="mono">{status === "all" ? "ALL NOTES" : status.toUpperCase()}</span></div>
       {filtered.length ? <div className="feedback-row-list">{filtered.map((item) => <FeedbackRow key={item.id} item={item} onReview={(entry) => review.mutate(entry.id)} reviewing={reviewingId === item.id} canReview={isAdmin} />)}</div> : <div className="feedback-empty"><div><MessageCircle size={20} /></div><h3>{submissions.length ? "Nothing matches this view" : "The inbox is ready"}</h3><p>{submissions.length ? "Try clearing a filter or searching for another style." : "Customer observations will arrive here as the field shares what it is seeing."}</p>{(search || styleSearch || dateRange !== "all" || teamFilter !== "all" || typeFilter !== "all" || sentimentFilter !== "all" || status !== "all" || urgency !== "all") && <button className="button button-quiet" onClick={clearFilters} data-testid="button-clear-feedback-filters-empty">Clear filters</button>}</div>}
     </div> : <div className="feedback-style-view"><div className="feedback-by-style-intro"><div><span className="eyebrow">Pattern, not anecdote</span><h2>Where the conversation is clustering.</h2></div><p>Styles with the most field observations rise to the top so the next product conversation has context.</p></div>{summaries.length ? <div className="feedback-style-summary-list">{summaries.map((summary, index) => <article className="feedback-style-summary" key={`${summary.styleId}-${summary.code}-${summary.name}`} role="button" tabIndex={0} onClick={() => { setView("inbox"); setStyleSearch(summary.code || summary.name); }} onKeyDown={(event) => { if (event.key === "Enter") { setView("inbox"); setStyleSearch(summary.code || summary.name); } }} data-testid={`card-feedback-style-${summary.styleId || summary.code || summary.name}`}><div className="feedback-summary-index">{String(index + 1).padStart(2, "0")}</div><div className="feedback-summary-thumb">{summary.styleImage ? <img src={summary.styleImage} alt="" /> : <PaletteFallback />}</div><div className="feedback-summary-copy"><strong>{summary.name}</strong><span>{summary.code || "Style not linked"}</span><div className="feedback-sentiment-bar" aria-label={`${summary.positive} positive, ${summary.mixed} mixed, ${summary.negative} negative`}><i className="positive" style={{ width: `${summary.count ? (summary.positive / summary.count) * 100 : 0}%` }} /><i className="mixed" style={{ width: `${summary.count ? (summary.mixed / summary.count) * 100 : 0}%` }} /><i className="negative" style={{ width: `${summary.count ? (summary.negative / summary.count) * 100 : 0}%` }} /></div><div className="feedback-summary-type-pills">{Object.entries(summary.feedbackTypes || {}).sort(([, a], [, b]) => b - a).slice(0, 3).map(([type]) => <span key={type}>{type}</span>)}</div><p>{summary.latestComment}</p></div><div className="feedback-summary-count"><b>{summary.count}</b><span>{summary.count === 1 ? "observation" : "observations"}</span><small>{summary.urgent ? `${summary.urgent} urgent` : "No urgent notes"}</small></div><ArrowRight size={16} /></article>)}</div> : <div className="feedback-empty"><div><Filter size={20} /></div><h3>No style patterns yet</h3><p>Once feedback is linked to a style, the range view will take shape here.</p></div>}</div>}
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