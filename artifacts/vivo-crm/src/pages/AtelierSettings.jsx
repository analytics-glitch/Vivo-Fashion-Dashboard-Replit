import React, { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { formatDate } from "@/lib/api";
import { Settings, Save, Plus, Building, Scissors, Users, History } from "lucide-react";

export default function AtelierSettings() {
  const [savingConfig, setSavingConfig] = useState(false);
  const [ticketFooter, setTicketFooter] = useState("");
  const [garmentPolicy, setGarmentPolicy] = useState("");
  const [policyHistory, setPolicyHistory] = useState([]);
  
  const [branches, setBranches] = useState([]);
  const [types, setTypes] = useState([]);
  const [staff, setStaff] = useState([]);
  
  const [loading, setLoading] = useState(true);
  
  const [newBranch, setNewBranch] = useState({ code: "", name: "", active: true });
  const [newType, setNewType] = useState({ code: "", name: "", description: "", active: true });
  const [newStaffUserId, setNewStaffUserId] = useState("");

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      // Config & policies are public to staff
      const r = await api.get('/atelier/config');
      const ticketConfig = r.data.config.find(c => c.key === "ticket");
      if (ticketConfig) {
        setTicketFooter(ticketConfig.value.footer || "");
      }
      
      const garment = r.data.policies.find(p => p.key === "garment_alterations_policy");
      if (garment) {
        setGarmentPolicy(garment.body || "");
      }

      // Admin endpoints for full arrays
      try {
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
      } catch {
        // user not admin, skip admin tables
      }

    } catch {
      // ignore
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
    return <div className="p-10 text-[var(--vivo-muted)]">Loading settings...</div>;
  }

  return (
    <div className="p-6 md:p-10 max-w-[1000px] mx-auto min-h-screen">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-3xl text-[var(--vivo-navy)] flex items-center gap-3">
            <Settings className="h-8 w-8" /> Atelier Settings
          </h1>
          <p className="text-sm text-[var(--vivo-muted)] mt-1">Configure policies, locations, and services</p>
        </div>
        <Button disabled={savingConfig} onClick={handleSaveConfig} className="h-10 px-6 rounded-sm bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy-700)] shadow-sm">
          <Save className="mr-2 h-4 w-4" /> {savingConfig ? "Saving..." : "Save Policies"}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card className="vivo-card p-6 rounded-sm border-t-4 border-t-[var(--vivo-navy)]">
            <h3 className="font-display text-lg text-[var(--vivo-navy)] mb-4">Ticket Footer</h3>
            <p className="text-xs text-[var(--vivo-muted)] mb-3">This note appears on the printed ticket for the customer.</p>
            <textarea
              value={ticketFooter}
              onChange={e => setTicketFooter(e.target.value)}
              className="w-full h-24 p-3 rounded-sm border border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] text-sm resize-none"
              placeholder="Please present this ticket when collecting your garment."
            />
          </Card>

          <Card className="vivo-card p-6 rounded-sm">
            <h3 className="font-display text-lg text-[var(--vivo-navy)] mb-4">Garment Alterations Policy</h3>
            <p className="text-xs text-[var(--vivo-muted)] mb-3">Customer-facing guidelines for Atelier services.</p>
            <textarea
              value={garmentPolicy}
              onChange={e => setGarmentPolicy(e.target.value)}
              className="w-full h-32 p-3 rounded-sm border border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] text-sm resize-none"
              placeholder="Policy text..."
            />
            {policyHistory.length > 0 && (
              <div className="mt-4 pt-4 border-t border-[var(--vivo-border)]">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--vivo-muted)] mb-2 flex items-center gap-1">
                  <History className="h-3 w-3" /> Version History
                </h4>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {policyHistory.map(ph => (
                    <div key={ph.version} className="flex justify-between items-center text-xs">
                      <div>
                        <span className="font-medium">v{ph.version}</span> · {formatDate(ph.created_at)}
                      </div>
                      <div className="text-[var(--vivo-muted)]">{ph.created_by}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="vivo-card p-6 rounded-sm">
            <h3 className="font-display text-lg text-[var(--vivo-navy)] mb-4 flex items-center gap-2">
              <Building className="h-5 w-5" /> Locations / Branches
            </h3>
            <div className="space-y-3 mb-4 max-h-[200px] overflow-y-auto">
              {branches.map(b => (
                <div key={b.id} className="flex justify-between items-center bg-[var(--vivo-bg-soft)] border border-[var(--vivo-border)] p-2 rounded-sm">
                  <div>
                    <div className="text-sm font-medium">{b.name}</div>
                    <div className="text-[10px] uppercase text-[var(--vivo-muted)]">{b.code}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-[var(--vivo-muted)]">Active</Label>
                    <Checkbox checked={b.active} onCheckedChange={c => toggleBranch(b.id, !!c)} />
                  </div>
                </div>
              ))}
              {branches.length === 0 && <div className="text-xs text-[var(--vivo-muted)]">No branches loaded. Admin only.</div>}
            </div>
            {branches.length > 0 && (
              <div className="grid grid-cols-[1fr,1.5fr,auto] gap-2 pt-4 border-t border-[var(--vivo-border)]">
                <Input placeholder="code" value={newBranch.code} onChange={e => setNewBranch(f => ({ ...f, code: e.target.value.toLowerCase() }))} className="h-9 text-sm" />
                <Input placeholder="Name" value={newBranch.name} onChange={e => setNewBranch(f => ({ ...f, name: e.target.value }))} className="h-9 text-sm" />
                <Button onClick={createBranch} size="sm" variant="outline" className="h-9 rounded-sm border-[var(--vivo-navy)] text-[var(--vivo-navy)]">
                  Add
                </Button>
              </div>
            )}
          </Card>

          <Card className="vivo-card p-6 rounded-sm">
            <h3 className="font-display text-lg text-[var(--vivo-navy)] mb-4 flex items-center gap-2">
              <Scissors className="h-5 w-5" /> Alteration Types
            </h3>
            <div className="space-y-3 mb-4 max-h-[250px] overflow-y-auto">
              {types.map(t => (
                <div key={t.id} className="flex justify-between items-start bg-[var(--vivo-bg-soft)] border border-[var(--vivo-border)] p-2 rounded-sm">
                  <div>
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-[var(--vivo-muted)]">{t.description}</div>
                    <div className="text-[10px] uppercase text-[var(--vivo-muted)] mt-1">{t.code}</div>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <Label className="text-xs text-[var(--vivo-muted)]">Active</Label>
                    <Checkbox checked={t.active} onCheckedChange={c => toggleType(t.id, !!c)} />
                  </div>
                </div>
              ))}
              {types.length === 0 && <div className="text-xs text-[var(--vivo-muted)]">No types loaded. Admin only.</div>}
            </div>
            {types.length > 0 && (
              <div className="space-y-2 pt-4 border-t border-[var(--vivo-border)]">
                <div className="grid grid-cols-[1fr,1.5fr] gap-2">
                  <Input placeholder="code" value={newType.code} onChange={e => setNewType(f => ({ ...f, code: e.target.value.toLowerCase() }))} className="h-9 text-sm" />
                  <Input placeholder="Name" value={newType.name} onChange={e => setNewType(f => ({ ...f, name: e.target.value }))} className="h-9 text-sm" />
                </div>
                <div className="flex gap-2">
                  <Input placeholder="Description" value={newType.description} onChange={e => setNewType(f => ({ ...f, description: e.target.value }))} className="h-9 text-sm flex-1" />
                  <Button onClick={createType} size="sm" variant="outline" className="h-9 rounded-sm border-[var(--vivo-navy)] text-[var(--vivo-navy)]">
                    Add
                  </Button>
                </div>
              </div>
            )}
          </Card>
          
          <Card className="vivo-card p-6 rounded-sm">
            <h3 className="font-display text-lg text-[var(--vivo-navy)] mb-4 flex items-center gap-2">
              <Users className="h-5 w-5" /> Authorized Staff
            </h3>
            <p className="text-xs text-[var(--vivo-muted)] mb-3">Add existing user ID to grant Atelier access.</p>
            <div className="space-y-3 mb-4 max-h-[200px] overflow-y-auto pr-2">
              {staff.map(s => (
                <div key={s.user_id} className="flex justify-between items-center bg-[var(--vivo-bg-soft)] border border-[var(--vivo-border)] p-2 rounded-sm">
                  <div>
                    <div className="text-sm font-medium">{s.name}</div>
                    <div className="text-[10px] text-[var(--vivo-muted)]">{s.email}</div>
                    <div className="text-[10px] uppercase text-[var(--vivo-muted)] mt-0.5">{s.role}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-[var(--vivo-muted)]">Active</Label>
                    <Checkbox checked={s.atelier_enabled} onCheckedChange={c => toggleStaff(s.user_id, !!c)} />
                  </div>
                </div>
              ))}
              {staff.length === 0 && <div className="text-xs text-[var(--vivo-muted)]">No staff loaded.</div>}
            </div>
            <div className="flex gap-2 pt-4 border-t border-[var(--vivo-border)]">
              <Input placeholder="User ID (e.g. usr_123)" value={newStaffUserId} onChange={e => setNewStaffUserId(e.target.value)} className="h-9 text-sm flex-1" />
              <Button onClick={addStaff} size="sm" variant="outline" className="h-9 rounded-sm border-[var(--vivo-navy)] text-[var(--vivo-navy)]">
                Authorize
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
