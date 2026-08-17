import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CircleAlert,
  GripVertical,
  ImagePlus,
  LockKeyhole,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Upload,
  UsersRound,
  X,
} from 'lucide-react';
import {
  getListWorkspaceTeamDirectoryQueryKey,
  getGetWorkspaceSessionQueryKey,
  useCreateWorkspaceTeamDirectoryMember,
  useGetWorkspaceSession,
  useListWorkspaceTeamDirectory,
  useReorderWorkspaceTeamDirectory,
  useRequestWorkspaceTeamDirectoryPhotoUpload,
  useUpdateWorkspaceTeamDirectoryMember,
} from '@workspace/api-client-react';
import type {
  WorkspaceTeamDirectoryMember,
  WorkspaceTeamDirectoryMemberInput,
} from '@workspace/api-client-react';

const SECTIONS = ['Leadership', 'Design Team', 'CAD Team', 'Sample Team', 'Buying & Planning'] as const;
type SectionName = (typeof SECTIONS)[number];
type Draft = Pick<WorkspaceTeamDirectoryMember, 'name' | 'description'> & { birthday: string };

const photoUrl = (member: WorkspaceTeamDirectoryMember) => {
  if (!member.photoUrl) return '';
  if (member.photoUrl.startsWith('/objects/')) return `/api/storage${member.photoUrl}`;
  return member.photoUrl;
};

const memberInitials = (name: string, roleTitle: string) => {
  const source = name.trim() || roleTitle.trim() || 'Vivo';
  const letters = source.split(/\s+/).map((part) => part[0]).filter(Boolean).join('');
  return letters.slice(0, 2).toUpperCase();
};

const asDraft = (member: WorkspaceTeamDirectoryMember): Draft => ({
  name: member.name || '',
  description: member.description || '',
  birthday: member.birthday || '',
});

function TeamSkeleton() {
  return (
    <div className="team-skeleton-grid" aria-label="Loading team directory">
      {[1, 2, 3, 4].map((item) => <div className="team-skeleton-card" key={item} />)}
    </div>
  );
}

function MemberPhoto({
  member,
  editing,
  onPhotoSelected,
  uploading,
}: {
  member: WorkspaceTeamDirectoryMember;
  editing: boolean;
  onPhotoSelected: (file: File) => void;
  uploading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const src = photoUrl(member);
  return (
    <div className="team-member-photo">
      {src ? (
        <img src={src} alt={member.name ? `${member.name}, ${member.roleTitle}` : member.roleTitle} data-testid={`img-team-member-${member.id}`} />
      ) : (
        <div className="team-initials" data-testid={`avatar-team-member-${member.id}`} aria-label="Initials placeholder">
          {memberInitials(member.name, member.roleTitle)}
        </div>
      )}
      {member.isLma && <span className="team-member-lma" data-testid={`badge-lma-${member.id}`}><ShieldCheck /> LMA</span>}
      {editing && (
        <>
          <button
            type="button"
            className="team-photo-button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            data-testid={`button-upload-photo-${member.id}`}
          >
            {uploading ? <><Upload size={13} /> Uploading…</> : <><ImagePlus size={13} /> {src ? 'Change photo' : 'Add photo'}</>}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onPhotoSelected(file);
            }}
            data-testid={`input-photo-${member.id}`}
          />
        </>
      )}
    </div>
  );
}

function MemberCard({
  member,
  editing,
  draft,
  onDraftChange,
  onPhotoSelected,
  uploading,
  onDragStart,
  onDrop,
}: {
  member: WorkspaceTeamDirectoryMember;
  editing: boolean;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  onPhotoSelected: (file: File) => void;
  uploading: boolean;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  return (
    <article
      className={`team-member-card ${editing ? 'is-editable' : ''}`}
      draggable={editing}
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
      data-testid={`card-team-member-${member.id}`}
    >
      <MemberPhoto member={member} editing={editing} onPhotoSelected={onPhotoSelected} uploading={uploading} />
      {editing && <button type="button" className="team-drag-handle" aria-label={`Reorder ${member.name || member.roleTitle}`} data-testid={`button-drag-member-${member.id}`}><GripVertical size={16} /></button>}
      <div className="team-member-body">
        <span className="team-member-role" data-testid={`text-team-role-${member.id}`}>{member.roleTitle || 'Role title'}</span>
        {editing ? (
          <div className="team-edit-fields">
            <input
              value={draft.name}
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
              placeholder="Name to be added"
              aria-label={`Name for ${member.roleTitle || 'team member'}`}
              data-testid={`input-team-name-${member.id}`}
            />
            <textarea
              value={draft.description}
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
              placeholder="A short note about this person's craft."
              aria-label={`Description for ${member.name || member.roleTitle}`}
              data-testid={`input-team-description-${member.id}`}
            />
            <label className="team-birthday-field">
              <span>Birthday (month &amp; day)</span>
              <input
                type="date"
                value={draft.birthday}
                onChange={(event) => {
                  const [, month, day] = event.target.value.split('-');
                  onDraftChange({ ...draft, birthday: month && day ? `2000-${month}-${day}` : '' });
                }}
                aria-label={`Birthday month and day for ${member.name || member.roleTitle}`}
                data-testid={`input-team-birthday-${member.id}`}
              />
            </label>
          </div>
        ) : (
          <>
            <h3 className={`team-member-name ${member.name ? '' : 'is-blank'}`} data-testid={`text-team-name-${member.id}`}>{member.name || 'Name to be added'}</h3>
            <p className="team-member-description" data-testid={`text-team-description-${member.id}`}>{member.description || 'The story behind this role is still being written.'}</p>
          </>
        )}
        {editing && uploading && <span className="team-card-saving"><Upload size={12} /> Saving photo</span>}
      </div>
    </article>
  );
}

export default function TeamDirectoryPage() {
  const queryClient = useQueryClient();
  const session = useGetWorkspaceSession({ query: { queryKey: getGetWorkspaceSessionQueryKey(), retry: false } });
  const directory = useListWorkspaceTeamDirectory({ query: { queryKey: getListWorkspaceTeamDirectoryQueryKey() } });
  const createMember = useCreateWorkspaceTeamDirectoryMember();
  const updateMember = useUpdateWorkspaceTeamDirectoryMember();
  const reorderMembers = useReorderWorkspaceTeamDirectory();
  const requestPhotoUpload = useRequestWorkspaceTeamDirectoryPhotoUpload();
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [uploadingId, setUploadingId] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const isAdmin = session.data?.user.role?.toLowerCase() === 'admin';

  const members = useMemo(() => directory.data || [], [directory.data]);
  const bySection = useMemo(() => {
    const map = new Map<SectionName, WorkspaceTeamDirectoryMember[]>();
    SECTIONS.forEach((section) => map.set(section, []));
    members.forEach((member) => {
      const section = SECTIONS.includes(member.teamSection as SectionName) ? member.teamSection as SectionName : 'Leadership';
      map.get(section)?.push(member);
    });
    map.forEach((items) => items.sort((a, b) => a.displayOrder - b.displayOrder || a.id - b.id));
    return map;
  }, [members]);
  const dirtyMembers = useMemo(
    () => members.filter((member) => {
      const draft = drafts[member.id];
      return draft && (
        draft.name !== (member.name || '')
        || draft.description !== (member.description || '')
        || draft.birthday !== (member.birthday || '')
      );
    }),
    [drafts, members],
  );

  const startEditing = () => {
    setDrafts(Object.fromEntries(members.map((member) => [member.id, asDraft(member)])));
    setNotice('');
    setError('');
    setEditing(true);
  };

  const stopEditing = () => {
    setDrafts({});
    setEditing(false);
    setError('');
  };

  const saveChanges = async () => {
    if (!dirtyMembers.length) {
      setNotice('The directory is already up to date.');
      return;
    }
    setError('');
    try {
      await Promise.all(dirtyMembers.map((member) => {
        const draft = drafts[member.id];
        const data: WorkspaceTeamDirectoryMemberInput = {
          name: draft.name,
          roleTitle: member.roleTitle,
          teamSection: member.teamSection,
          description: draft.description,
           birthday: draft.birthday || null,
          isLma: member.isLma,
        };
        return updateMember.mutateAsync({ id: member.id, data });
      }));
      await queryClient.invalidateQueries({ queryKey: getListWorkspaceTeamDirectoryQueryKey() });
      setNotice(`${dirtyMembers.length} ${dirtyMembers.length === 1 ? 'profile' : 'profiles'} saved.`);
      setEditing(false);
      setDrafts({});
    } catch {
      setError('Some profile changes could not be saved. Review the fields and try again.');
    }
  };

  const addMember = (section: SectionName) => {
    setError('');
    const newRoleCount = (bySection.get(section) || []).filter((member) => member.roleTitle.startsWith('New role')).length;
    createMember.mutate({
      data: {
        name: '',
        roleTitle: `New role ${newRoleCount + 1}`,
        teamSection: section,
        description: '',
        birthday: null,
        isLma: false,
      },
    }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListWorkspaceTeamDirectoryQueryKey() });
        setNotice(`New member slot added to ${section}.`);
      },
      onError: () => setError('Could not add a member slot. Please try again.'),
    });
  };

  const uploadPhoto = (member: WorkspaceTeamDirectoryMember, file: File) => {
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('Photos must be JPG or PNG files.');
      return;
    }
    if (file.size > 8388608) {
      setError('Photos must be smaller than 8 MB.');
      return;
    }
    setError('');
    setNotice('');
    setUploadingId(member.id);
    requestPhotoUpload.mutate({
      data: { name: file.name, size: file.size, contentType: file.type as 'image/jpeg' | 'image/png' },
    }, {
      onSuccess: async (upload) => {
        try {
          const response = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
          if (!response.ok) throw new Error('Photo upload failed');
          await updateMember.mutateAsync({
            id: member.id,
            data: {
              name: member.name || '',
              roleTitle: member.roleTitle,
              teamSection: member.teamSection,
              description: member.description || '',
              birthday: member.birthday || null,
              isLma: member.isLma,
              photoPath: upload.objectPath,
            },
          });
          await queryClient.invalidateQueries({ queryKey: getListWorkspaceTeamDirectoryQueryKey() });
          setNotice(`${member.name || member.roleTitle}’s photo was updated.`);
        } catch {
          setError('The photo could not be saved. Please try again.');
        } finally {
          setUploadingId(null);
        }
      },
      onError: () => {
        setUploadingId(null);
        setError('The photo upload could not be started. Please try again.');
      },
    });
  };

  const reorder = (section: SectionName, targetId: number) => {
    if (draggedId === null || draggedId === targetId) return;
    const items = [...(bySection.get(section) || [])];
    const from = items.findIndex((item) => item.id === draggedId);
    const to = items.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    setDraggedId(null);
    reorderMembers.mutate({
      data: { items: items.map((item, index) => ({ id: item.id, displayOrder: index })) },
    }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListWorkspaceTeamDirectoryQueryKey() });
        setNotice(`${section} order saved.`);
      },
      onError: () => setError('The new order could not be saved. Please try again.'),
    });
  };

  if (session.isLoading || directory.isLoading) {
    return <section className="page team-directory-page"><TeamSkeleton /></section>;
  }
  if (directory.isError) {
    return (
      <section className="page team-directory-page">
        <div className="empty-state error-state"><CircleAlert size={22} /><h3>Could not open the team directory</h3><p>We couldn't reach the workspace service. Your directory is safe.</p><button className="button button-dark" onClick={() => directory.refetch()} data-testid="button-retry-team-directory">Try again</button></div>
      </section>
    );
  }

  return (
    <section className={`page team-directory-page ${editing ? 'is-editing' : ''}`}>
      <div className="page-heading team-directory-heading">
        <div>
          <div className="eyebrow">Product Department</div>
          <h1>Meet the Team</h1>
          <p>The people shaping the Vivo range, from first sketch to final buy.</p>
        </div>
        <div className="team-heading-actions">
          {isAdmin ? (
            editing ? (
              <>
                <button className="button button-quiet" onClick={stopEditing} disabled={updateMember.isPending} data-testid="button-cancel-team-edit"><X size={15} /> Cancel</button>
                <button className="button button-dark" onClick={saveChanges} disabled={updateMember.isPending || reorderMembers.isPending} data-testid="button-save-team-directory"><Save size={15} /> {updateMember.isPending ? 'Saving…' : 'Save changes'}</button>
              </>
            ) : (
              <button className="button button-dark" onClick={startEditing} data-testid="button-edit-team-directory"><Pencil size={15} /> Edit directory</button>
            )
          ) : (
            <span className="team-view-note"><LockKeyhole size={14} /> Directory view</span>
          )}
        </div>
      </div>

      {notice && <div className="team-save-bar" role="status" data-testid="status-team-directory"><p><Check size={14} /> <strong>{notice}</strong></p><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss notification" data-testid="button-dismiss-team-notice"><X size={15} /></button></div>}
      {error && <div className="team-error" role="alert" data-testid="status-team-directory-error"><CircleAlert size={15} /> {error}</div>}

      <div className="team-intro">
        <div className="team-intro-card"><span className="eyebrow gold-eyebrow">The product room</span><h2>Good product starts with <em>good conversation.</em></h2></div>
        <div className="team-intro-copy"><p>Every handoff carries a point of view. This is the Product Department behind Vivo’s range — the makers, thinkers, and careful finishers who keep the edit moving.</p><div className="team-intro-stat"><strong>{members.length}</strong><span>people and role slots</span></div></div>
      </div>

      {SECTIONS.map((section) => {
        const sectionMembers = bySection.get(section) || [];
        return (
          <section className="team-section" key={section} aria-labelledby={`team-section-${section.replaceAll(' ', '-').toLowerCase()}`}>
            <div className="team-section-header">
              <div className="team-section-title"><h2 id={`team-section-${section.replaceAll(' ', '-').toLowerCase()}`}>{section}</h2><span className="team-section-count">{String(sectionMembers.length).padStart(2, '0')} {sectionMembers.length === 1 ? 'member' : 'members'}</span></div>
              {editing && isAdmin && <button className="team-section-action" onClick={() => addMember(section)} disabled={createMember.isPending} data-testid={`button-add-team-member-${section.replaceAll(' ', '-').toLowerCase()}`}><Plus size={14} /> Add member</button>}
            </div>
            {sectionMembers.length ? (
              <div className="team-member-grid">
                {sectionMembers.map((member) => (
                  <MemberCard
                    key={member.id}
                    member={member}
                    editing={editing}
                    draft={drafts[member.id] || asDraft(member)}
                    onDraftChange={(draft) => setDrafts((current) => ({ ...current, [member.id]: draft }))}
                    onPhotoSelected={(file) => uploadPhoto(member, file)}
                    uploading={uploadingId === member.id}
                    onDragStart={() => setDraggedId(member.id)}
                    onDrop={() => reorder(section, member.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="team-empty"><UsersRound size={16} /> {editing ? 'Add the first member to this section.' : 'No members have been added to this section yet.'}</div>
            )}
            {editing && sectionMembers.length > 0 && <div className="team-footnote"><GripVertical size={11} /> Drag cards to adjust the order within this section.</div>}
          </section>
        );
      })}

      {editing && <div className="team-save-bar"><p><strong>{dirtyMembers.length}</strong> unsaved {dirtyMembers.length === 1 ? 'change' : 'changes'} <span>·</span> photo uploads save immediately</p><button className="button button-dark" onClick={saveChanges} disabled={updateMember.isPending || !dirtyMembers.length} data-testid="button-save-team-directory-bottom"><Save size={15} /> Save changes</button></div>}
    </section>
  );
}