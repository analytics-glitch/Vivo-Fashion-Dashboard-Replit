import React, { useState, useEffect } from "react";
import { api, fmtDate } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Settings, Save, Building, Scissors, Users, History, AlertCircle } from "lucide-react";

export default function AtelierSettings() {
  const [savingConfig, setSavingConfig] = useState(false);
  const [ticketFooter, setTicketFooter] = useState("");
  const [garmentPolicy, setGarmentPolicy] = useState("");
  const [policyHistory, setPolicyHistory] = useState([]);
  
  const [branches, setBranches] = useState([]);
  const [types, setTypes] = useState([]);
  const [staff, setStaff] = useState([]);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const [newBranch, setNewBranch] = useState({ code: "", name: "", active: true });
  const [newType, setNewType] = useState({ code: "", name: "", description: "", active: true });
  const [newStaffUserId, setNewStaffUserId] = useState("");

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/atelier/config');
      const ticketConfig = r.data.config.find(c => c.key === "ticket");
      if (ticketConfig) {
        setTicketFooter(ticketConfig.value.footer || "");
      }
      
      const garment = r.data.policies.find(p => p.key === "garment_alterations_policy");
      if (garment) {
        setGarmentPolicy(garment.body || "");
      }

      const [b, t, s, ph] = await Promise.all([
        api.get('/atelier/admin/branches'),
        api.get('/atelier/admin/alteration-types'),
        api.get('/atelier/admin/staff'),
        api.get('/atelier/admin/policies/garment_alterations_policy/history')
      ]);
      setBranches(b.data.branches || []);
      setTypes(t.data.alteration_types || []);
      setStaff(s.data.staff || []);
      setPolicyHistory(ph.data.versions || []);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "Failed to load settings");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      await api.put('/atelier/admin/config/ticket', {
        value: { currency: "KES", footer: ticketFooter }
      });
      await api.put('/atelier/admin/policies/garment_alterations_policy', {
        title: "Garment Alterations Policy",
        body: garmentPolicy,
        active: true
      });
      toast.success("Settings saved");
      loadSettings();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save settings");
    } finally {
      setSavingConfig(false);
    }
  };

  const createBranch = async () => {
    if (!newBranch.code || !newBranch.name) return toast.error("Code and Name required");
    try {
      const r = await api.post('/atelier/admin/branches', newBranch);
      setBranches(prev => [...prev, r.data.branch].sort((a,b) => a.name.localeCompare(b.name)));
      setNewBranch({ code: "", name: "", active: true });
      toast.success("Branch added");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to add branch");
    }
  };

  const toggleBranch = async (id, active) => {
    try {
      const r = await api.patch(`/atelier/admin/branches/${id}`, { active });
      setBranches(prev => prev.map(b => b.id === id ? r.data.branch : b));
    } catch (e) {
      toast.error("Failed to update branch");
    }
  };

  const createType = async () => {
    if (!newType.code || !newType.name) return toast.error("Code and Name required");
    try {
      const r = await api.post('/atelier/admin/alteration-types', newType);
      setTypes(prev => [...prev, r.data.alteration_type].sort((a,b) => a.name.localeCompare(b.name)));
      setNewType({ code: "", name: "", description: "", active: true });
      toast.success("Alteration type added");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to add type");
    }
  };

  const toggleType = async (id, active) => {
    try {
      const r = await api.patch(`/atelier/admin/alteration-types/${id}`, { active });
      setTypes(prev => prev.map(t => t.id === id ? r.data.alteration_type : t));
    } catch (e) {
      toast.error("Failed to update type");
    }
  };

  const toggleStaff = async (userId, active) => {
    try {
      await api.put(`/atelier/admin/staff/${userId}`, { active });
      setStaff(prev => prev.map(s => s.user_id === userId ? { ...s, atelier_enabled: active } : s));
    } catch (e) {
      toast.error("Failed to update staff");
    }
  };

  const addStaff = async () => {
    if (!newStaffUserId) return toast.error("User ID required");
    try {
      await api.put(`/atelier/admin/staff/${newStaffUserId}`, { active: true });
      toast.success("Staff member authorized for Atelier");
      setNewStaffUserId("");
      loadSettings();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to authorize staff");
    }
  };

  if (loading) {
    return <div className="p-10 text-center text-[var(--muted)]">Loading settings...</div>;
  }
  
  if (error) {
    return (
      <Card className="card p-6 flex flex-col items-center justify-center min-h-[300px] text-center max-w-2xl mx-auto" data-testid="error-settings-load">
        <AlertCircle className="h-10 w-10 text-[var(--danger)] mb-4" />
        <p className="text-[var(--text)] font-semibold mb-2">Error loading settings</p>
        <p className="text-[var(--muted)] text-sm mb-6">{error}</p>
        <Button onClick={loadSettings} className="btn-primary" data-testid="button-retry-settings">
          Retry
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[var(--text)] flex items-center gap-2">
            <Settings className="h-5 w-5 text-[var(--accent)]" /> Administration
          </h2>
          <p className="text-sm text-[var(--muted)]">Manage policies, locations, services, and staff access</p>
        </div>
        <Button disabled={savingConfig} onClick={handleSaveConfig} className="btn-primary h-10 px-5 shadow-sm" data-testid="button-save-settings">
          <Save className="mr-2 h-4 w-4" /> {savingConfig ? "Saving..." : "Save Policies"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card className="card p-6 rounded-xl border-t-4 border-t-[var(--accent)]">
            <h3 className="text-lg font-bold text-[var(--text)] mb-2">Ticket Footer</h3>
            <p className="text-xs text-[var(--muted)] mb-4">This note appears on the printed ticket for the customer.</p>
            <textarea
              value={ticketFooter}
              onChange={e => setTicketFooter(e.target.value)}
              className="w-full h-24 p-3 rounded-xl border border-[var(--border)] bg-white text-sm resize-none focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all" data-testid="input-ticket-footer"
              placeholder="Please present this ticket when collecting your garment."
            />
          </Card>

          <Card className="card p-6 rounded-xl">
            <h3 className="text-lg font-bold text-[var(--text)] mb-2">Garment Alterations Policy</h3>
            <p className="text-xs text-[var(--muted)] mb-4">Customer-facing guidelines for Atelier services.</p>
            <textarea
              value={garmentPolicy}
              onChange={e => setGarmentPolicy(e.target.value)}
              className="w-full h-40 p-3 rounded-xl border border-[var(--border)] bg-white text-sm resize-none focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all" data-testid="input-garment-policy"
              placeholder="Policy text..."
            />
            {policyHistory.length > 0 && (
              <div className="mt-6 pt-5 border-t border-[var(--border)]">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-3 flex items-center gap-1.5">
                  <History className="h-3 w-3" /> Version History
                </h4>
                <div className="space-y-3 max-h-40 overflow-y-auto pr-2">
                  {policyHistory.map(ph => (
                    <div key={ph.version} className="flex justify-between items-center text-xs bg-[var(--panel)] p-2 rounded-lg border border-[var(--border)]">
                      <div>
                        <span className="font-bold text-[var(--text)]">v{ph.version}</span> &middot; {fmtDate(ph.created_at)}
                      </div>
                      <div className="text-[var(--muted)]">{ph.created_by}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="card p-6 rounded-xl">
            <h3 className="text-lg font-bold text-[var(--text)] mb-4 flex items-center gap-2">
              <Building className="h-5 w-5 text-[var(--accent)]" /> Locations / Branches
            </h3>
            <div className="space-y-3 mb-4 max-h-[200px] overflow-y-auto pr-2">
              {branches.map(b => (
                <div key={b.id} className="flex justify-between items-center bg-white border border-[var(--border)] p-3 rounded-xl shadow-sm">
                  <div>
                    <div className="text-sm font-bold text-[var(--text)]">{b.name}</div>
                    <div className="text-[10px] uppercase text-[var(--muted)] mt-0.5 tracking-wider font-semibold">{b.code}</div>
                  </div>
                  <div className="flex items-center gap-2 bg-[var(--panel)] px-3 py-1.5 rounded-lg border border-[var(--border)]">
                    <Label className="text-xs text-[var(--text)] font-semibold cursor-pointer" htmlFor={`branch-${b.id}`}>Active</Label>
                    <Checkbox id={`branch-${b.id}`} checked={b.active} onCheckedChange={c => toggleBranch(b.id, !!c)} />
                  </div>
                </div>
              ))}
              {branches.length === 0 && <div className="text-xs text-[var(--muted)] italic text-center py-4">No branches loaded. Admin access required.</div>}
            </div>
            {branches.length > 0 && (
              <div className="flex gap-2 pt-5 border-t border-[var(--border)]">
                <Input placeholder="code" value={newBranch.code} onChange={e => setNewBranch(f => ({ ...f, code: e.target.value.toLowerCase() }))} className="input-pill h-10 w-24 flex-shrink-0" />
                <Input placeholder="Name" value={newBranch.name} onChange={e => setNewBranch(f => ({ ...f, name: e.target.value }))} className="input-pill h-10 flex-1" />
                <Button onClick={createBranch} size="sm" variant="outline" className="btn-ghost h-10 px-4 border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white">
                  Add
                </Button>
              </div>
            )}
          </Card>

          <Card className="card p-6 rounded-xl">
            <h3 className="text-lg font-bold text-[var(--text)] mb-4 flex items-center gap-2">
              <Scissors className="h-5 w-5 text-[var(--accent)]" /> Alteration Types
            </h3>
            <div className="space-y-3 mb-4 max-h-[250px] overflow-y-auto pr-2">
              {types.map(t => (
                <div key={t.id} className="flex justify-between items-start bg-white border border-[var(--border)] p-3 rounded-xl shadow-sm">
                  <div>
                    <div className="text-sm font-bold text-[var(--text)]">{t.name}</div>
                    <div className="text-xs text-[var(--muted)] mt-1">{t.description}</div>
                    <div className="text-[10px] uppercase text-[var(--muted)] mt-1.5 tracking-wider font-semibold">{t.code}</div>
                  </div>
                  <div className="flex items-center gap-2 mt-1 bg-[var(--panel)] px-3 py-1.5 rounded-lg border border-[var(--border)]">
                    <Label className="text-xs text-[var(--text)] font-semibold cursor-pointer" htmlFor={`type-${t.id}`}>Active</Label>
                    <Checkbox id={`type-${t.id}`} checked={t.active} onCheckedChange={c => toggleType(t.id, !!c)} />
                  </div>
                </div>
              ))}
              {types.length === 0 && <div className="text-xs text-[var(--muted)] italic text-center py-4">No types loaded. Admin access required.</div>}
            </div>
            {types.length > 0 && (
              <div className="space-y-3 pt-5 border-t border-[var(--border)]">
                <div className="flex gap-2">
                  <Input placeholder="code" value={newType.code} onChange={e => setNewType(f => ({ ...f, code: e.target.value.toLowerCase() }))} className="input-pill h-10 w-24 flex-shrink-0" />
                  <Input placeholder="Name" value={newType.name} onChange={e => setNewType(f => ({ ...f, name: e.target.value }))} className="input-pill h-10 flex-1" />
                </div>
                <div className="flex gap-2">
                  <Input placeholder="Description" value={newType.description} onChange={e => setNewType(f => ({ ...f, description: e.target.value }))} className="input-pill h-10 flex-1" />
                  <Button onClick={createType} size="sm" variant="outline" className="btn-ghost h-10 px-4 border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white">
                    Add
                  </Button>
                </div>
              </div>
            )}
          </Card>
          
          <Card className="card p-6 rounded-xl">
            <h3 className="text-lg font-bold text-[var(--text)] mb-2 flex items-center gap-2">
              <Users className="h-5 w-5 text-[var(--accent)]" /> Authorized Staff
            </h3>
            <p className="text-xs text-[var(--muted)] mb-4">Add existing user ID to grant Atelier access.</p>
            <div className="space-y-3 mb-4 max-h-[200px] overflow-y-auto pr-2">
              {staff.map(s => (
                <div key={s.user_id} className="flex justify-between items-center bg-white border border-[var(--border)] p-3 rounded-xl shadow-sm">
                  <div>
                    <div className="text-sm font-bold text-[var(--text)]">{s.name}</div>
                    <div className="text-[11px] text-[var(--muted)] mt-0.5">{s.email}</div>
                    <div className="text-[10px] uppercase text-[var(--muted)] mt-1 tracking-wider font-semibold">{s.role}</div>
                  </div>
                  <div className="flex items-center gap-2 bg-[var(--panel)] px-3 py-1.5 rounded-lg border border-[var(--border)]">
                    <Label className="text-xs text-[var(--text)] font-semibold cursor-pointer" htmlFor={`staff-${s.user_id}`}>Active</Label>
                    <Checkbox id={`staff-${s.user_id}`} checked={s.atelier_enabled} onCheckedChange={c => toggleStaff(s.user_id, !!c)} />
                  </div>
                </div>
              ))}
              {staff.length === 0 && <div className="text-xs text-[var(--muted)] italic text-center py-4">No staff loaded.</div>}
            </div>
            <div className="flex gap-2 pt-5 border-t border-[var(--border)]">
              <Input placeholder="User ID (e.g. usr_123)" value={newStaffUserId} onChange={e => setNewStaffUserId(e.target.value)} className="input-pill h-10 flex-1" />
              <Button onClick={addStaff} size="sm" variant="outline" className="btn-ghost h-10 px-4 border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white">
                Authorize
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}