import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, CalendarDays, Edit3, ExternalLink, FileText, Library, Plus, Trash2, X } from "lucide-react";
import { useLocation, useParams } from "wouter";

type ResourceCategory = "Technical" | "Planning" | "Strategy" | "Buying";

type Resource = {
  id: number;
  title: string;
  category: ResourceCategory;
  description: string;
  sourceUrl: string;
  contentMarkdown?: string;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: number | null;
};

type ResourceForm = {
  title: string;
  category: ResourceCategory;
  description: string;
  sourceUrl: string;
  contentMarkdown: string;
};

const CATEGORY_ORDER: ResourceCategory[] = ["Technical", "Planning", "Strategy", "Buying"];
const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  Technical: "Technical Specs",
  Planning: "Planning",
  Strategy: "Strategy",
  Buying: "Buying",
};
const EMPTY_FORM: ResourceForm = { title: "", category: "Planning", description: "", sourceUrl: "", contentMarkdown: "" };

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error || `Request failed (${response.status})`));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function useResources() {
  return useQuery<Resource[]>({
    queryKey: ["workspace", "resources"],
    queryFn: () => request<Resource[]>("/api/workspace/resources"),
  });
}

function useResource(id: string | undefined) {
  return useQuery<Resource>({
    queryKey: ["workspace", "resource", id],
    enabled: Boolean(id),
    queryFn: () => request<Resource>(`/api/workspace/resources/${id}`),
  });
}

function formatDate(value: string | null) {
  if (!value) return "No date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function InlineMarkdown({ text }: { text: string }) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
        if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
        if (token.startsWith("*") && token.endsWith("*")) return <em key={index}>{token.slice(1, -1)}</em>;
        const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
        return <span key={index}>{token}</span>;
      })}
    </>
  );
}

function tableCells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function MarkdownContent({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (/^---+$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }
    if (line.startsWith("|") && index + 1 < lines.length && isTableDivider(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        <div className="resource-table-wrap" key={`table-${index}`}>
          <table className="resource-table">
            <thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}><InlineMarkdown text={cell} /></th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}><InlineMarkdown text={row[cellIndex] || ""} /></td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = <InlineMarkdown text={heading[2]} />;
      blocks.push(level === 1 ? <h1 key={index}>{text}</h1> : level === 2 ? <h2 key={index}>{text}</h2> : level === 3 ? <h3 key={index}>{text}</h3> : <h4 key={index}>{text}</h4>);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? "").trim();
        const match = ordered ? current.match(/^\d+\.\s+(.+)$/) : current.match(/^[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} /></li>)}</List>);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("> ")) {
        quote.push((lines[index] ?? "").trim().slice(2));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}><InlineMarkdown text={quote.join(" ")} /></blockquote>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = (lines[index] ?? "").trim();
      if (!next || /^#{1,4}\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+\.\s+/.test(next) || next.startsWith("|") || next.startsWith("> ") || /^---+$/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}><InlineMarkdown text={paragraph.join(" ")} /></p>);
  }
  return <div className="resource-markdown">{blocks}</div>;
}

function ResourceModal({ initial, onClose, onSaved }: { initial: ResourceForm & { id?: number }; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ResourceForm>(initial);
  const isEditing = Boolean(initial.id);
  const save = useMutation({
    mutationFn: () => request<Resource>(isEditing ? `/api/workspace/resources/${initial.id}` : "/api/workspace/resources", {
      method: isEditing ? "PUT" : "POST",
      body: JSON.stringify(form),
    }),
    onSuccess: () => { onSaved(); onClose(); },
  });
  const set = (key: keyof ResourceForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  return (
    <div className="resource-modal-backdrop" onClick={onClose}>
      <div className="resource-modal" role="dialog" aria-modal="true" aria-labelledby="resource-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="resource-modal-head">
          <div><span className="eyebrow gold-eyebrow">Reference library</span><h2 id="resource-modal-title">{isEditing ? "Edit document" : "Add document"}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close document form"><X size={18} /></button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }} className="resource-form">
          <label>Title<input value={form.title} onChange={(event) => set("title", event.target.value)} placeholder="Document title" required /></label>
          <label>Category<select value={form.category} onChange={(event) => set("category", event.target.value)}>{CATEGORY_ORDER.map((category) => <option value={category} key={category}>{CATEGORY_LABELS[category]}</option>)}</select></label>
          <label>Description<textarea value={form.description} onChange={(event) => set("description", event.target.value)} placeholder="Short description shown on the document card" rows={3} required /></label>
          <label>Google Drive URL<input type="url" value={form.sourceUrl} onChange={(event) => set("sourceUrl", event.target.value)} placeholder="https://docs.google.com/…" required /></label>
          <label>Markdown content<textarea className="resource-editor" value={form.contentMarkdown} onChange={(event) => set("contentMarkdown", event.target.value)} placeholder="# Heading&#10;&#10;Write the document in markdown…" rows={18} required /></label>
          {save.isError && <p className="resource-form-error">{save.error instanceof Error ? save.error.message : "Could not save document."}</p>}
          <div className="resource-form-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-dark" disabled={save.isPending}>{save.isPending ? "Saving…" : isEditing ? "Save changes" : "Add document"}</button></div>
        </form>
      </div>
    </div>
  );
}

function resourceForm(resource?: Resource): ResourceForm & { id?: number } {
  return resource ? { id: resource.id, title: resource.title, category: resource.category, description: resource.description, sourceUrl: resource.sourceUrl || "", contentMarkdown: resource.contentMarkdown || "" } : { ...EMPTY_FORM };
}

function ResourceCard({ resource, isAdmin, onRead, onEdit, onDelete }: { resource: Resource; isAdmin: boolean; onRead: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <article className="resource-card" data-testid={`resource-card-${resource.id}`}>
      <div className="resource-card-top"><span className="resource-category">{resource.category}</span><FileText size={18} /></div>
      <div className="resource-card-body"><h3>{resource.title}</h3><p>{resource.description}</p></div>
      <div className="resource-card-foot"><span><CalendarDays size={13} /> Updated {formatDate(resource.updatedAt)}</span><div className="resource-card-actions"><button className="button button-dark resource-read-button" onClick={onRead} data-testid={`button-read-resource-${resource.id}`}>Read <ArrowLeft size={14} className="resource-read-arrow" /></button>{resource.sourceUrl && <a className="button button-quiet resource-drive-button" href={resource.sourceUrl} target="_blank" rel="noreferrer" data-testid={`button-open-drive-${resource.id}`}>Open in Google Drive <ExternalLink size={13} /></a>}</div></div>
      {isAdmin && <div className="resource-admin-actions"><button onClick={onEdit} aria-label={`Edit ${resource.title}`}><Edit3 size={14} /> Edit</button><button onClick={onDelete} aria-label={`Delete ${resource.title}`}><Trash2 size={14} /> Delete</button></div>}
    </article>
  );
}

function ResourcesIndex({ isAdmin }: { isAdmin: boolean }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const resources = useResources();
  const [modal, setModal] = useState<(ResourceForm & { id?: number }) | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => request<void>(`/api/workspace/resources/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace", "resources"] }),
  });
  const grouped = useMemo(() => CATEGORY_ORDER.map((category) => ({ category, items: (resources.data || []).filter((item) => item.category === category) })), [resources.data]);
  if (resources.isLoading) return <section className="page resources-page"><div className="resource-loading-grid"><div /><div /><div /></div></section>;
  if (resources.isError) return <section className="page"><div className="empty-state error-state"><FileText size={22} /><h3>Could not open Resources</h3><p>{resources.error instanceof Error ? resources.error.message : "The workspace service did not respond."}</p><button className="button button-dark" onClick={() => resources.refetch()}>Try again</button></div></section>;
  return (
    <section className="page resources-page">
      <PageHeading eyebrow="Reference library" title="Resources" description="The operating language of the product team, in one considered room." action={isAdmin ? <button className="button button-gold" onClick={() => setModal(resourceForm())}><Plus size={16} /> Add document</button> : undefined} />
      <div className="resources-intro"><div className="resources-intro-icon"><Library size={24} /></div><div><strong>Read the way Vivo works.</strong><p>SOPs, standards and operating references for the decisions that move product forward.</p></div><span>{resources.data?.length || 0} documents</span></div>
      {grouped.map(({ category, items }) => <section className="resource-category-section" key={category}><div className="resource-section-heading"><div><span className="eyebrow gold-eyebrow">{CATEGORY_LABELS[category]}</span><h2>{CATEGORY_LABELS[category]}</h2></div><span>{items.length} {items.length === 1 ? "document" : "documents"}</span></div>{items.length ? <div className="resource-card-grid">{items.map((resource) => <ResourceCard key={resource.id} resource={resource} isAdmin={isAdmin} onRead={() => setLocation(`/product-workspace/resources/${resource.id}`)} onEdit={async () => { const full = await request<Resource>(`/api/workspace/resources/${resource.id}`); setModal(resourceForm(full)); }} onDelete={() => { if (window.confirm(`Delete “${resource.title}”?`)) remove.mutate(resource.id); }} />)}</div> : <div className="resource-empty">No documents in this category yet.</div>}</section>)}
      {modal && <ResourceModal initial={modal} onClose={() => setModal(null)} onSaved={() => queryClient.invalidateQueries({ queryKey: ["workspace", "resources"] })} />}
    </section>
  );
}

function ResourceReader({ isAdmin }: { isAdmin: boolean }) {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const resource = useResource(id);
  const [modal, setModal] = useState<(ResourceForm & { id?: number }) | null>(null);
  const queryClient = useQueryClient();
  if (resource.isLoading) return <section className="page resources-page"><div className="resource-reader-skeleton" /></section>;
  if (resource.isError || !resource.data) return <section className="page"><div className="empty-state error-state"><FileText size={22} /><h3>Could not open this document</h3><p>{resource.error instanceof Error ? resource.error.message : "This document may have been removed."}</p><button className="button button-dark" onClick={() => setLocation("/product-workspace/resources")}>Back to Resources</button></div></section>;
  const document = resource.data;
  return (
    <section className="page resources-page resource-reader-page">
      <button className="back-link" onClick={() => setLocation("/product-workspace/resources")}><ArrowLeft size={15} /> Back to Resources</button>
      <div className="resource-breadcrumb"><span>Resources</span><b>/</b><strong>{document.title}</strong></div>
      <div className="resource-reader-head"><div><span className="resource-category">{CATEGORY_LABELS[document.category]}</span><h1>{document.title}</h1><p>{document.description}</p><div className="resource-reader-meta"><CalendarDays size={14} /> Updated {formatDate(document.updatedAt)}</div></div><div className="resource-reader-actions">{document.sourceUrl && <a className="button button-gold" href={document.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open in Google Drive</a>}{isAdmin && <button className="button button-quiet" onClick={() => setModal(resourceForm(document))}><Edit3 size={15} /> Edit document</button>}</div></div>
      <article className="resource-reader"><MarkdownContent content={document.contentMarkdown || ""} /></article>
      {modal && <ResourceModal initial={modal} onClose={() => setModal(null)} onSaved={() => { queryClient.invalidateQueries({ queryKey: ["workspace", "resource", id] }); queryClient.invalidateQueries({ queryKey: ["workspace", "resources"] }); }} />}
    </section>
  );
}

export default function ResourcesPage() {
  const session = useQuery<{ user: { role?: string } | null }>({ queryKey: ["workspace", "session"], queryFn: () => request<{ user: { role?: string } | null }>("/api/workspace/session") });
  const isAdmin = session.data?.user?.role === "Admin" || localStorage.getItem("workspace_user_role") === "Admin";
  const { id } = useParams<{ id?: string }>();
  return id ? <ResourceReader isAdmin={isAdmin} /> : <ResourcesIndex isAdmin={isAdmin} />;
}
