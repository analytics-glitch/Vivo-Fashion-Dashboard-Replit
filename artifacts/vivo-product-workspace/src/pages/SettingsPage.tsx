import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  getListWorkspaceTeamQueryKey,
  useCreateWorkspaceTeamMember,
  useDeleteWorkspaceTeamMember,
  useListWorkspaceTeam,
  useUpdateWorkspaceTeamMember,
} from '@workspace/api-client-react';
import type { WorkspaceTeamMember } from '@workspace/api-client-react';

export const TEAM_ROLES = ['Admin', 'Design', 'Buying', 'Retail', 'Finance'] as const;

const MODULES = ['PLM', 'Range Plan', 'Style Catalogue', 'Showcase', 'Settings'] as const;
type Access = 'Admin' | 'Edit' | 'View' | 'No Access';
const ACCESS_MATRIX: Record<(typeof TEAM_ROLES)[number], Record<(typeof MODULES)[number], Access>> = {
  Admin:   { PLM: 'Admin', 'Range Plan': 'Admin', 'Style Catalogue': 'Admin', Showcase: 'Admin', Settings: 'Admin' },
  Design:  { PLM: 'Edit',  'Range Plan': 'View',  'Style Catalogue': 'View',  Showcase: 'Edit',  Settings: 'No Access' },
  Buying:  { PLM: 'View',  'Range Plan': 'Edit',  'Style Catalogue': 'View',  Showcase: 'View',  Settings: 'No Access' },
  Retail:  { PLM: 'View',  'Range Plan': 'View',  'Style Catalogue': 'View',  Showcase: 'View',  Settings: 'No Access' },
  Finance: { PLM: 'No Access', 'Range Plan': 'View', 'Style Catalogue': 'View', Showcase: 'No Access', Settings: 'No Access' },
};

function fmtDate(value?: string) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function AccessPill({ level }: { level: Access }) {
  const tone = level === 'Admin' ? 'access-admin' : level === 'Edit' ? 'access-edit' : level === 'View' ? 'access-view' : 'access-none';
  return <span className={`access-pill ${tone}`}>{level}</span>;
}

type Draft = { id: number | null; name: string; role: string; department: string };
const emptyDraft: Draft = { id: null, name: '', role: 'Design', department: '' };

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const team = useListWorkspaceTeam({ query: { queryKey: getListWorkspaceTeamQueryKey() }, request: { credentials: 'include' } });
  const createMember = useCreateWorkspaceTeamMember();
  const updateMember = useUpdateWorkspaceTeamMember();
  const deleteMember = useDeleteWorkspaceTeamMember();
  const [tab, setTab] = useState<'team' | 'access'>('team');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListWorkspaceTeamQueryKey() });
  const busy = createMember.isPending || updateMember.isPending;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setError('');
    const data = { name: draft.name.trim(), role: draft.role, department: draft.department.trim() };
    if (!data.name) { setError('Name is required.'); return; }
    const opts = {
      onSuccess: () => { setDraft(null); refresh(); },
      onError: (e: unknown) => setError((e as { error?: string })?.error || 'Could not save the team member.'),
    };
    if (draft.id == null) createMember.mutate({ data }, opts);
    else updateMember.mutate({ id: draft.id, data }, opts);
  };

  const remove = (member: WorkspaceTeamMember) => {
    if (!window.confirm(`Remove ${member.name} from the team?`)) return;
    deleteMember.mutate({ id: member.id }, { onSuccess: refresh });
  };

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Workspace administration</div>
          <h1>Settings</h1>
          <p>Manage the team and see who can reach each part of the workspace.</p>
        </div>
        {tab === 'team' && (
          <div className="heading-action">
            <button className="button button-dark" onClick={() => { setError(''); setDraft({ ...emptyDraft }); }} data-testid="button-add-member">
              <Plus size={15} /> Add member
            </button>
          </div>
        )}
      </div>

      <div className="settings-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')} data-testid="tab-team-members">Team Members</button>
        <button role="tab" aria-selected={tab === 'access'} className={tab === 'access' ? 'active' : ''} onClick={() => setTab('access')} data-testid="tab-access-rights">Access Rights</button>
      </div>

      {tab === 'team' ? (
        <div className="panel settings-panel">
          {team.isLoading ? (
            <p className="settings-empty">Loading the team…</p>
          ) : team.isError ? (
            <p className="settings-empty">Couldn't load the team. <button className="button button-quiet" onClick={() => team.refetch()}>Retry</button></p>
          ) : team.data?.length ? (
            <table className="settings-table" data-testid="table-team-members">
              <thead>
                <tr><th>Name</th><th>Role</th><th>Department</th><th>Date Added</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {team.data.map((member) => (
                  <tr key={member.id} data-testid={`row-team-member-${member.id}`}>
                    <td className="settings-name">{member.name}</td>
                    <td><span className="role-chip">{member.role}</span></td>
                    <td>{member.department || '—'}</td>
                    <td className="mono">{fmtDate(member.createdAt)}</td>
                    <td className="settings-actions">
                      <button className="icon-button" aria-label={`Edit ${member.name}`} onClick={() => { setError(''); setDraft({ id: member.id, name: member.name, role: member.role, department: member.department || '' }); }} data-testid={`button-edit-member-${member.id}`}><Pencil size={14} /></button>
                      <button className="icon-button danger" aria-label={`Remove ${member.name}`} onClick={() => remove(member)} data-testid={`button-remove-member-${member.id}`}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="settings-empty">No team members yet. Add the first one to unlock the identity selector.</p>
          )}
        </div>
      ) : (
        <div className="panel settings-panel">
          <p className="settings-note">Reference matrix for workspace access by role. Display-only for now — permissions are not yet enforced.</p>
          <table className="settings-table access-table" data-testid="table-access-rights">
            <thead>
              <tr><th>Role</th>{MODULES.map((m) => <th key={m}>{m}</th>)}</tr>
            </thead>
            <tbody>
              {TEAM_ROLES.map((role) => (
                <tr key={role} data-testid={`row-access-${role.toLowerCase()}`}>
                  <td className="settings-name">{role}</td>
                  {MODULES.map((m) => <td key={m}><AccessPill level={ACCESS_MATRIX[role][m]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft && (
        <div className="settings-modal-backdrop" onClick={() => setDraft(null)}>
          <div className="settings-modal" role="dialog" aria-modal="true" aria-label={draft.id == null ? 'Add team member' : 'Edit team member'} onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-head">
              <h3>{draft.id == null ? 'Add member' : 'Edit member'}</h3>
              <button className="icon-button" onClick={() => setDraft(null)} aria-label="Close" data-testid="button-close-member-modal"><X size={16} /></button>
            </div>
            <form onSubmit={save}>
              <label>Name
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Full name" autoFocus data-testid="input-member-name" />
              </label>
              <label>Role
                <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} data-testid="select-member-role">
                  {TEAM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label>Department
                <input value={draft.department} onChange={(e) => setDraft({ ...draft, department: e.target.value })} placeholder='e.g. "Creative", "Merchandising"' data-testid="input-member-department" />
              </label>
              {error && <div className="form-error">{error}</div>}
              <div className="settings-modal-actions">
                <button type="button" className="button button-quiet" onClick={() => setDraft(null)} data-testid="button-cancel-member">Cancel</button>
                <button type="submit" className="button button-dark" disabled={busy} data-testid="button-save-member">{busy ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
