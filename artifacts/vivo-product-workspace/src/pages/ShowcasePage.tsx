import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useParams } from 'wouter';
import {
  ArrowLeft, ArrowRight, Check, CircleAlert, GalleryHorizontalEnd, ImagePlus, Link2, MessageCircle,
  Package, Pencil, Plus, Save, Search, Trash2, X,
} from 'lucide-react';
import {
  getGetShowcaseBoardQueryKey, getListShowcaseBoardsQueryKey, getListWorkspaceStylesQueryKey,
  useAddShowcaseImages, useCreateShowcaseBoard, useCreateShowcaseComment, useCreateShowcaseSection,
  useDeleteShowcaseBoard, useDeleteShowcaseImage, useDeleteShowcaseSection, useGetShowcaseBoard,
  useListShowcaseBoards, useListWorkspaceStyles, useUpdateShowcaseBoard, useUpdateShowcaseSection,
} from '@workspace/api-client-react';
import type { ShowcaseBoard, ShowcaseBoardSummary, ShowcaseSection, WorkspaceStyle } from '@workspace/api-client-react';

export const SHOWCASE_PURPOSES = ['Trend Brief', 'Drop Preview', 'Range Review', 'Line Sheet', 'Moodboard', 'Other'] as const;

type Identity = { id: string; name: string; role: string };
function readIdentity(): Identity | null {
  const id = localStorage.getItem('workspace_user_id');
  if (!id) return null;
  return { id, name: localStorage.getItem('workspace_user_name') || '', role: localStorage.getItem('workspace_user_role') || '' };
}
const initials = (name: string) => (name || 'V T').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const longDate = (value?: string | null) => {
  if (!value) return 'No date';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const timeStamp = (value?: string | null) => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const styleImage = (style: WorkspaceStyle) => style.image || `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 560"><rect width="480" height="560" fill="${style.id % 2 ? '#d8d0c4' : '#d6dde0'}"/><path d="M134 118 195 80h90l61 38 54 91-55 36-33-57v254H168V188l-33 57-55-36z" fill="${style.id % 2 ? '#ede8df' : '#f4f0e8'}" stroke="#1A1A2E" stroke-width="4"/><path d="M195 81c4 45 86 45 90 0M167 264h146" fill="none" stroke="#C9A96E" stroke-width="4"/><text x="24" y="522" fill="#1A1A2E" font-family="sans-serif" font-size="18" letter-spacing="4">VIVO PLM</text></svg>`)}`;

function Editable({ as = 'div', value, editing, onCommit, className = '', placeholder, testId }: {
  as?: 'h1' | 'h2' | 'p' | 'div'; value: string; editing: boolean; onCommit: (next: string) => void; className?: string; placeholder: string; testId: string;
}) {
  const Tag = as;
  return (
    <Tag
      className={`sc-editable ${className} ${editing ? 'is-editing' : ''} ${!value ? 'is-empty' : ''}`}
      contentEditable={editing}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      data-testid={testId}
      onBlur={(event) => { const next = (event.currentTarget.textContent || '').trim(); if (next !== value) onCommit(next); }}
    >
      {value}
    </Tag>
  );
}

function PurposeTag({ purpose }: { purpose: string }) {
  return <span className={`sc-purpose sc-purpose-${purpose.toLowerCase().replaceAll(' ', '-')}`}>{purpose}</span>;
}

export default function ShowcasePage() {
  const params = useParams<{ id?: string }>();
  if (params.id) return <ShowcaseBoardPage id={Number(params.id)} />;
  return <ShowcaseIndex />;
}

function ShowcaseIndex() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const boards = useListShowcaseBoards({ query: { queryKey: getListShowcaseBoardsQueryKey() }, request: { credentials: 'include' } });
  const create = useCreateShowcaseBoard();
  const [filter, setFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState<string>('Trend Brief');
  const [description, setDescription] = useState('');
  const filtered = (boards.data || []).filter((board) => !filter || board.purpose === filter);
  const createBoard = () => {
    if (!title.trim()) return;
    const identity = readIdentity();
    create.mutate({
      data: { title: title.trim(), purpose, description: description.trim(), creatorUserId: identity ? Number(identity.id) : null, creatorName: identity?.name || '', creatorRole: identity?.role || '' },
    }, {
      onSuccess: (created) => {
        setModalOpen(false); setTitle(''); setDescription('');
        queryClient.invalidateQueries({ queryKey: getListShowcaseBoardsQueryKey() });
        setLocation(`/product-workspace/showcase/${created.id}`);
      },
    });
  };
  return (
    <section className="page showcase-index-page">
      <div className="page-heading">
        <div><div className="eyebrow">Creative boards</div><h1>Showcase</h1><p>Trend research, drop previews and range reviews — shared as living documents.</p></div>
        <div className="heading-action"><button className="button button-dark" onClick={() => setModalOpen(true)} data-testid="button-new-showcase-board"><Plus size={16} /> New Board</button></div>
      </div>
      <div className="sc-filter-row" role="tablist" aria-label="Filter boards by purpose">
        <button className={`sc-filter ${filter === '' ? 'active' : ''}`} onClick={() => setFilter('')} data-testid="button-filter-all">All boards</button>
        {SHOWCASE_PURPOSES.map((item) => (
          <button key={item} className={`sc-filter ${filter === item ? 'active' : ''}`} onClick={() => setFilter(filter === item ? '' : item)} data-testid={`button-filter-${item.toLowerCase().replaceAll(' ', '-')}`}>{item}</button>
        ))}
      </div>
      {boards.isLoading ? (
        <div className="sc-card-grid">{[0, 1, 2].map((i) => <div className="skeleton sc-card-skeleton" key={i} />)}</div>
      ) : boards.isError ? (
        <div className="empty-state error-state"><CircleAlert size={22} /><h3>Could not load the gallery</h3><p>The workspace service is unreachable. Your boards are safe.</p><button className="button button-dark" onClick={() => boards.refetch()} data-testid="button-retry-showcase">Try again</button></div>
      ) : filtered.length ? (
        <div className="sc-card-grid">
          {filtered.map((board) => <ShowcaseCard key={board.id} board={board} onOpen={() => setLocation(`/product-workspace/showcase/${board.id}`)} />)}
        </div>
      ) : (
        <div className="empty-state"><div className="empty-symbol"><GalleryHorizontalEnd size={20} /></div><h3>{filter ? `No ${filter} boards yet` : 'The gallery is waiting'}</h3><p>Start a board to share trend research, a drop preview or a range review with the room.</p><button className="button button-gold" onClick={() => setModalOpen(true)} data-testid="button-empty-new-board"><Plus size={15} /> New Board</button></div>
      )}
      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal-card sc-new-modal" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header"><div><span className="eyebrow">Showcase</span><h2>New board</h2></div><button className="icon-button" onClick={() => setModalOpen(false)} aria-label="Close new board dialog" data-testid="button-close-new-showcase"><X size={17} /></button></div>
            <label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. SS27 colour direction" data-testid="input-showcase-title" /></label>
            <label>Purpose<select value={purpose} onChange={(event) => setPurpose(event.target.value)} data-testid="select-showcase-purpose">{SHOWCASE_PURPOSES.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>Description <small>(optional)</small><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What should the room take away from this board?" rows={3} data-testid="input-showcase-description" /></label>
            {create.isError && <div className="form-error">The board could not be created. Check the title and try again.</div>}
            <button className="button button-dark button-wide" onClick={createBoard} disabled={create.isPending || !title.trim()} data-testid="button-create-showcase-board">{create.isPending ? 'Creating…' : 'Create board'} <ArrowRight size={16} /></button>
          </div>
        </div>
      )}
    </section>
  );
}

function ShowcaseCard({ board, onOpen }: { board: ShowcaseBoardSummary; onOpen: () => void }) {
  return (
    <button className="sc-card" onClick={onOpen} data-testid={`card-showcase-board-${board.id}`}>
      <div className="sc-card-cover">
        {board.coverImage ? <img src={board.coverImage} alt="" loading="lazy" /> : <div className="sc-card-placeholder"><GalleryHorizontalEnd size={26} /><span>No cover yet</span></div>}
        <PurposeTag purpose={board.purpose} />
      </div>
      <div className="sc-card-body">
        <h3>{board.title}</h3>
        <div className="sc-card-meta">
          <span className="avatar small" style={{ background: '#C9A96E' }}>{initials(board.creatorName)}</span>
          <span className="sc-card-creator"><b>{board.creatorName || 'Workspace member'}</b><small>{board.creatorRole || '—'}</small></span>
          <span className="sc-card-facts">{longDate(board.createdAt)}<i>·</i><MessageCircle size={13} /> {board.commentCount ?? 0}</span>
        </div>
      </div>
    </button>
  );
}

function ShowcaseBoardPage({ id }: { id: number }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const board = useGetShowcaseBoard(id, { query: { queryKey: getGetShowcaseBoardQueryKey(id) }, request: { credentials: 'include' } });
  const updateBoard = useUpdateShowcaseBoard();
  const deleteBoard = useDeleteShowcaseBoard();
  const createSection = useCreateShowcaseSection();
  const updateSection = useUpdateShowcaseSection();
  const deleteSection = useDeleteShowcaseSection();
  const addImages = useAddShowcaseImages();
  const deleteImage = useDeleteShowcaseImage();
  const createComment = useCreateShowcaseComment();
  const [editing, setEditing] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [notice, setNotice] = useState('');
  const [plmSection, setPlmSection] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pendingBoard = useRef<{ title?: string; description?: string; purpose?: string }>({});
  const pendingSections = useRef<Map<number, { title?: string; body?: string }>>(new Map());
  const identity = readIdentity();
  const isAdmin = identity?.role === 'Admin';
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2600); return () => clearTimeout(timer); }, [notice]);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetShowcaseBoardQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListShowcaseBoardsQueryKey() });
  };
  const data = board.data as ShowcaseBoard | undefined;
  const stageBoard = (patch: { title?: string; description?: string; purpose?: string }) => { pendingBoard.current = { ...pendingBoard.current, ...patch }; };
  const stageSection = (sectionId: number, patch: { title?: string; body?: string }) => {
    pendingSections.current.set(sectionId, { ...(pendingSections.current.get(sectionId) || {}), ...patch });
  };
  const save = async () => {
    try {
      if (Object.keys(pendingBoard.current).length) {
        await updateBoard.mutateAsync({ id, data: pendingBoard.current });
        pendingBoard.current = {};
      }
      for (const [sectionId, patch] of Array.from(pendingSections.current.entries())) {
        await updateSection.mutateAsync({ id: sectionId, data: patch });
        pendingSections.current.delete(sectionId);
      }
      setNotice('Board saved');
    } catch {
      setNotice('Save failed — your edits are kept, try again');
    } finally {
      invalidate();
    }
  };
  const changePurpose = (purpose: string) => updateBoard.mutate({ id, data: { purpose } }, { onSuccess: invalidate });
  const addSection = () => createSection.mutate({ id, data: { title: 'New section', body: '' } }, { onSuccess: invalidate });
  const removeSection = (sectionId: number) => { if (window.confirm('Remove this section and its images?')) deleteSection.mutate({ id: sectionId }, { onSuccess: invalidate }); };
  const removeImage = (imageId: number) => deleteImage.mutate({ id: imageId }, { onSuccess: invalidate });
  const removeBoard = () => deleteBoard.mutate({ id }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListShowcaseBoardsQueryKey() }); setLocation('/product-workspace/showcase'); } });
  const share = async () => { try { await navigator.clipboard.writeText(window.location.href); setNotice('Link copied'); } catch { setNotice('Copy failed'); } };
  const uploadFiles = (sectionId: number, event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).filter((file) => /image\/(png|jpe?g|webp)/.test(file.type));
    event.target.value = '';
    if (!files.length) { setNotice('Only jpg, png or webp images'); return; }
    Promise.all(files.map((file) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }))).then((dataUrls) => {
      addImages.mutate({ id: sectionId, data: { images: dataUrls.map((imageData) => ({ imageData, sourceType: 'upload' as const })) } }, {
        onSuccess: invalidate,
        onError: () => setNotice('Upload failed — images may be too large'),
      });
    }).catch(() => setNotice('Could not read those files'));
  };
  const pullFromPlm = (sectionId: number, styles: WorkspaceStyle[]) => {
    addImages.mutate({ id: sectionId, data: { images: styles.map((style) => ({ sourceType: 'plm' as const, plmStyleId: style.id, caption: style.name })) } }, {
      onSuccess: () => { setPlmSection(null); invalidate(); },
      onError: () => setNotice('Could not add those styles'),
    });
  };
  const submitComment = () => {
    if (!comment.trim()) return;
    if (!identity?.name) { setNotice('Pick who you are first (top right)'); return; }
    createComment.mutate({ id, data: { userName: identity.name, userRole: identity.role, commentText: comment.trim() } }, {
      onSuccess: () => { setComment(''); invalidate(); },
    });
  };
  if (board.isLoading) return <section className="page"><div className="loading-grid"><div className="skeleton skeleton-hero" /><div className="skeleton skeleton-panel" /></div></section>;
  if (board.isError || !data) return <section className="page"><div className="empty-state error-state"><CircleAlert size={22} /><h3>Could not open this board</h3><p>It may have been deleted, or the service is unreachable.</p><button className="button button-dark" onClick={() => setLocation('/product-workspace/showcase')} data-testid="button-back-to-gallery">Back to Showcase</button></div></section>;
  const comments = data.comments || [];
  return (
    <section className="page sc-board-page">
      <div className="sc-toolbar">
        <button className="back-link" onClick={() => setLocation('/product-workspace/showcase')} data-testid="button-back-showcase"><ArrowLeft size={15} /> Showcase</button>
        <div className="sc-toolbar-actions">
          {notice && <span className="sc-notice" data-testid="text-showcase-notice"><Check size={13} /> {notice}</span>}
          <button className={`button button-quiet ${editing ? '' : 'sc-toggle-off'}`} onClick={() => setEditing(!editing)} data-testid="button-toggle-edit">{editing ? <>View</> : <><Pencil size={14} /> Edit</>}</button>
          <button className="button button-quiet" onClick={share} data-testid="button-share-board"><Link2 size={14} /> Share</button>
          <button className="button button-dark" onClick={save} disabled={updateBoard.isPending || updateSection.isPending} data-testid="button-save-board"><Save size={14} /> Save</button>
          {isAdmin && <button className="button button-quiet sc-delete" onClick={() => setConfirmDelete(true)} data-testid="button-delete-board"><Trash2 size={14} /></button>}
          <button className="button button-quiet sc-comments-toggle" onClick={() => setCommentsOpen(!commentsOpen)} data-testid="button-toggle-comments"><MessageCircle size={14} /> {comments.length}</button>
        </div>
      </div>
      <div className="sc-board-layout">
        <article className="sc-document">
          <header className="sc-doc-header">
            {editing ? (
              <select className="sc-purpose-select" value={data.purpose} onChange={(event) => changePurpose(event.target.value)} data-testid="select-board-purpose">{SHOWCASE_PURPOSES.map((item) => <option key={item}>{item}</option>)}</select>
            ) : <PurposeTag purpose={data.purpose} />}
            <Editable as="h1" value={data.title} editing={editing} onCommit={(title) => stageBoard({ title })} className="sc-doc-title" placeholder="Untitled board" testId="text-board-title" />
            <div className="sc-doc-byline">
              <span className="avatar small" style={{ background: '#C9A96E' }}>{initials(data.creatorName)}</span>
              <span><b>{data.creatorName || 'Workspace member'}</b>{data.creatorRole ? ` · ${data.creatorRole}` : ''}</span>
              <i>·</i><span>{longDate(data.createdAt)}</span>
            </div>
            <Editable as="p" value={data.description || ''} editing={editing} onCommit={(description) => stageBoard({ description })} className="sc-doc-subtitle" placeholder="Add a short introduction for the room…" testId="text-board-description" />
          </header>
          {(data.sections || []).map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              editing={editing}
              onCommitTitle={(title) => stageSection(section.id, { title })}
              onCommitBody={(body) => stageSection(section.id, { body })}
              onRemove={() => removeSection(section.id)}
              onUpload={(event) => uploadFiles(section.id, event)}
              onPullPlm={() => setPlmSection(section.id)}
              onRemoveImage={removeImage}
              uploading={addImages.isPending}
            />
          ))}
          {editing && (
            <button className="sc-add-section" onClick={addSection} disabled={createSection.isPending} data-testid="button-add-section"><Plus size={16} /> Add Section</button>
          )}
          {!editing && !(data.sections || []).length && (
            <div className="empty-state"><div className="empty-symbol"><GalleryHorizontalEnd size={20} /></div><h3>This board is a blank page</h3><p>Switch to Edit to add the first section.</p></div>
          )}
        </article>
        <aside className={`sc-comments ${commentsOpen ? 'is-open' : ''}`} aria-label="Board comments">
          <div className="sc-comments-head"><div><span className="eyebrow">The thread</span><h3>Comments <span className="count">{comments.length}</span></h3></div><button className="icon-button sc-comments-close" onClick={() => setCommentsOpen(false)} aria-label="Close comments" data-testid="button-close-comments"><X size={16} /></button></div>
          <div className="sc-comments-list">
            {comments.length ? comments.map((item) => (
              <div className="sc-comment" key={item.id} data-testid={`comment-showcase-${item.id}`}>
                <span className="avatar small" style={{ background: '#1A1A2E' }}>{initials(item.userName)}</span>
                <div><div className="sc-comment-head"><b>{item.userName}</b>{item.userRole && <span className="sc-role-badge">{item.userRole}</span>}<time>{timeStamp(item.createdAt)}</time></div><p>{item.commentText}</p></div>
              </div>
            )) : <p className="sc-comments-empty">No comments yet. Start the conversation.</p>}
          </div>
          <div className="sc-comment-input">
            <input value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitComment(); }} placeholder={identity?.name ? `Comment as ${identity.name}…` : 'Pick who you are to comment'} data-testid="input-showcase-comment" />
            <button onClick={submitComment} disabled={createComment.isPending || !comment.trim()} aria-label="Add comment" data-testid="button-add-showcase-comment"><ArrowRight size={16} /></button>
          </div>
        </aside>
      </div>
      {plmSection !== null && <PlmPickerModal onClose={() => setPlmSection(null)} onAdd={(styles) => pullFromPlm(plmSection, styles)} adding={addImages.isPending} />}
      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="modal-card sc-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header"><div><span className="eyebrow">Delete board</span><h2>Remove “{data.title}”?</h2></div><button className="icon-button" onClick={() => setConfirmDelete(false)} aria-label="Close delete dialog" data-testid="button-close-delete-board"><X size={17} /></button></div>
            <p className="sc-confirm-copy">This removes the board, its sections, images and comments for everyone. This cannot be undone.</p>
            <div className="button-group sc-confirm-actions">
              <button className="button button-quiet" onClick={() => setConfirmDelete(false)} data-testid="button-cancel-delete-board">Keep board</button>
              <button className="button button-dark sc-delete-confirm" onClick={removeBoard} disabled={deleteBoard.isPending} data-testid="button-confirm-delete-board"><Trash2 size={14} /> {deleteBoard.isPending ? 'Deleting…' : 'Delete board'}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SectionBlock({ section, editing, onCommitTitle, onCommitBody, onRemove, onUpload, onPullPlm, onRemoveImage, uploading }: {
  section: ShowcaseSection; editing: boolean; onCommitTitle: (title: string) => void; onCommitBody: (body: string) => void;
  onRemove: () => void; onUpload: (event: ChangeEvent<HTMLInputElement>) => void; onPullPlm: () => void; onRemoveImage: (id: number) => void; uploading: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const images = section.images || [];
  return (
    <section className="sc-section" data-testid={`section-showcase-${section.id}`}>
      <div className="sc-section-head">
        <Editable as="h2" value={section.title} editing={editing} onCommit={onCommitTitle} className="sc-section-title" placeholder="Section title" testId={`text-section-title-${section.id}`} />
        {editing && <button className="icon-button sc-section-remove" onClick={onRemove} aria-label="Remove section" data-testid={`button-remove-section-${section.id}`}><Trash2 size={15} /></button>}
      </div>
      <Editable as="p" value={section.body} editing={editing} onCommit={onCommitBody} className="sc-section-body" placeholder="Write the story for this section…" testId={`text-section-body-${section.id}`} />
      {(images.length > 0 || editing) && (
        <div className={`sc-image-grid sc-grid-${Math.min(images.length || 1, 3)}`}>
          {images.map((image) => (
            <figure className="sc-image" key={image.id} data-testid={`image-showcase-${image.id}`}>
              <img src={image.imageData} alt={image.caption || 'Showcase image'} loading="lazy" />
              {image.caption && <figcaption>{image.caption}</figcaption>}
              {editing && <button className="sc-image-remove" onClick={() => onRemoveImage(image.id)} aria-label="Remove image" data-testid={`button-remove-image-${image.id}`}><X size={13} /></button>}
            </figure>
          ))}
          {editing && (
            <div className="sc-image-actions">
              <button className="sc-image-add" onClick={() => fileInput.current?.click()} disabled={uploading} data-testid={`button-upload-image-${section.id}`}><ImagePlus size={17} /><span>{uploading ? 'Adding…' : 'Upload images'}</span><small>jpg · png · webp</small></button>
              <button className="sc-image-add" onClick={onPullPlm} disabled={uploading} data-testid={`button-pull-plm-${section.id}`}><Package size={17} /><span>Pull from PLM</span><small>style library</small></button>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={onUpload} data-testid={`input-file-${section.id}`} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function PlmPickerModal({ onClose, onAdd, adding }: { onClose: () => void; onAdd: (styles: WorkspaceStyle[]) => void; adding: boolean }) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Map<number, WorkspaceStyle>>(new Map());
  const styles = useListWorkspaceStyles(undefined, { query: { queryKey: getListWorkspaceStylesQueryKey() }, request: { credentials: 'include' } });
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (styles.data || []).filter((style) => !query || style.name.toLowerCase().includes(query) || style.code.toLowerCase().includes(query) || (style.category || '').toLowerCase().includes(query));
  }, [styles.data, search]);
  const toggle = (style: WorkspaceStyle) => setPicked((current) => { const next = new Map(current); if (next.has(style.id)) next.delete(style.id); else next.set(style.id, style); return next; });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card sc-plm-modal" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header"><div><span className="eyebrow">Style library</span><h2>Pull from PLM</h2></div><button className="icon-button" onClick={onClose} aria-label="Close style picker" data-testid="button-close-plm-picker"><X size={17} /></button></div>
        <label className="modal-search"><Search size={16} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search styles by name, number or category" data-testid="input-plm-search" /></label>
        <div className="sc-plm-results">
          {styles.isLoading ? <div className="skeleton picker-loading" /> : matches.length ? matches.map((style) => (
            <button key={style.id} className={`sc-plm-row ${picked.has(style.id) ? 'is-picked' : ''}`} onClick={() => toggle(style)} data-testid={`button-pick-style-${style.id}`}>
              <span className="sc-plm-thumb" style={{ backgroundImage: `url(${styleImage(style)})` }} />
              <span className="sc-plm-copy"><strong>{style.name}</strong><small>{style.code} · {style.category} · {style.brand}</small></span>
              <span className="sc-plm-check">{picked.has(style.id) && <Check size={14} />}</span>
            </button>
          )) : <p className="modal-muted">No styles match that search.</p>}
        </div>
        <button className="button button-dark button-wide" onClick={() => onAdd(Array.from(picked.values()))} disabled={adding || picked.size === 0} data-testid="button-add-picked-styles">{adding ? 'Adding…' : `Add ${picked.size || ''} ${picked.size === 1 ? 'style' : 'styles'}`.trim()} <ArrowRight size={16} /></button>
      </div>
    </div>
  );
}
