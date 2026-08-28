import React, { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, formatDate } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Search, Plus, Scissors, Filter, ChevronRight, User } from "lucide-react";

export default function AtelierDashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("all");
  const [searchQ, setSearchQ] = useState("");

  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeForm, setIntakeForm] = useState({
    customer_phone: "",
    customer_name: "",
    garments: [{
      garment_type: "",
      sku: "",
      product_name: "",
      colour: "",
      size: "",
      condition_notes: "",
      alteration_notes: "",
      promised_at: "",
      alteration_type_id: "none",
      assigned_to: "unassigned"
    }]
  });
  const [intakeSaving, setIntakeSaving] = useState(false);
  const [tailors, setTailors] = useState([]);
  const [alterationTypes, setAlterationTypes] = useState([]);
  const [customerMeasurements, setCustomerMeasurements] = useState([]);
  
  const [skuSearchIndex, setSkuSearchIndex] = useState(null);
  const [skuSearchResults, setSkuSearchResults] = useState([]);

  const handleSkuSearch = async (index, query) => {
    updateGarment(index, 'sku', query);
    if (query.length > 2) {
      try {
        setSkuSearchIndex(index);
        const r = await api.get('/atelier/skus', { params: { q: query } });
        setSkuSearchResults(r.data.items || []);
      } catch {
        setSkuSearchResults([]);
      }
    } else {
      setSkuSearchResults([]);
      setSkuSearchIndex(null);
    }
  };

  const selectSku = (index, match) => {
    updateGarment(index, 'sku', match.sku);
    updateGarment(index, 'product_name', match.product_name || "");
    updateGarment(index, 'colour', match.colour || "");
    updateGarment(index, 'size', match.size || "");
    setSkuSearchResults([]);
    setSkuSearchIndex(null);
  };

  const [measurementOpen, setMeasurementOpen] = useState(false);
  const [measurementForm, setMeasurementForm] = useState({ name: "", value: "", unit: "cm", note: "" });
  const [measurementSaving, setMeasurementSaving] = useState(false);
  const [activeCustomerId, setActiveCustomerId] = useState(null);

  const lookupCustomer = async (phone) => {
    if (!phone || phone.length < 5) return;
    try {
      const lookup = await api.get('/atelier/customers/lookup', { params: { phone } });
      if (lookup.data?.customers?.length > 0) {
        const c = lookup.data.customers[0];
        setActiveCustomerId(c.customer_id);
        if (c.first_name && c.first_name !== 'Walk-in') {
          setIntakeForm(f => ({ ...f, customer_name: `${c.first_name} ${c.last_name || ''}`.trim() }));
        }
        
        // Fetch history for measurements
        try {
          const hist = await api.get(`/atelier/customers/${c.customer_id}/history`, { params: { store_id: c.store_id } });
          setCustomerMeasurements(hist.data.measurements || []);
        } catch { /* ignore */ }
      } else {
        setActiveCustomerId(null);
        setCustomerMeasurements([]);
      }
    } catch {
      setActiveCustomerId(null);
      setCustomerMeasurements([]);
    }
  };

  const handleSaveMeasurement = async () => {
    if (!activeCustomerId) return toast.error("Customer not resolved. Lookup first.");
    if (!measurementForm.name || !measurementForm.value) return toast.error("Name and value are required");
    setMeasurementSaving(true);
    try {
      await api.post(`/atelier/customers/${activeCustomerId}/measurements`, {
        ...measurementForm,
        store_id: "vivofashiongroup" 
      });
      toast.success("Measurement saved");
      setMeasurementOpen(false);
      setMeasurementForm({ name: "", value: "", unit: "cm", note: "" });
      lookupCustomer(intakeForm.customer_phone);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save measurement");
    } finally {
      setMeasurementSaving(false);
    }
  };

  useEffect(() => {
    loadJobs();
    loadTailors();
    if (searchParams.get("new_job_phone")) {
      setIntakeForm(f => ({ ...f, customer_phone: searchParams.get("new_job_phone") || "" }));
      setIntakeOpen(true);
      
      const newParams = new URLSearchParams(searchParams);
      newParams.delete("new_job_phone");
      setSearchParams(newParams);
    }
  }, [searchParams]);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const r = await api.get('/atelier/board', { params: { location_code: "junction", status: filterStatus === "all" ? undefined : filterStatus } });
      setJobs(r.data.jobs || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load board jobs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
  }, [filterStatus]);

  const loadTailors = async () => {
    try {
      const r = await api.get('/atelier/config');
      setTailors(r.data.staff || []);
      setAlterationTypes(r.data.alteration_types || []);
    } catch {
      // ignore
    }
  };

  const addGarment = () => {
    setIntakeForm(f => ({
      ...f,
      garments: [...f.garments, {
        garment_type: "", sku: "", product_name: "", colour: "", size: "", condition_notes: "",
        alteration_notes: "", promised_at: "", alteration_type_id: "none", assigned_to: "unassigned"
      }]
    }));
  };

  const updateGarment = (index, field, value) => {
    setIntakeForm(f => {
      const newGarments = [...f.garments];
      newGarments[index][field] = value;
      return { ...f, garments: newGarments };
    });
  };

  const removeGarment = (index) => {
    setIntakeForm(f => {
      if (f.garments.length === 1) return f;
      const newGarments = [...f.garments];
      newGarments.splice(index, 1);
      return { ...f, garments: newGarments };
    });
  };

  const submitIntake = async () => {
    if (!intakeForm.customer_phone) {
      toast.error("Phone is required");
      return;
    }
    const invalidGarment = intakeForm.garments.find(g => !g.garment_type);
    if (invalidGarment) {
      toast.error("Garment Type is required for all items");
      return;
    }
    
    setIntakeSaving(true);
    try {
      // 1. Lookup or create customer
      let customer_id = null;
      let store_id = "vivofashiongroup";
      try {
        const lookup = await api.get('/atelier/customers/lookup', { params: { phone: intakeForm.customer_phone } });
        if (lookup.data?.customers?.length > 0) {
          customer_id = lookup.data.customers[0].customer_id;
          store_id = lookup.data.customers[0].store_id;
        } else {
          const create = await api.post('/atelier/customers', { 
            phone: intakeForm.customer_phone, 
            first_name: intakeForm.customer_name || "Walk-in"
          });
          customer_id = create.data.customer.customer_id;
          store_id = create.data.customer.store_id;
        }
      } catch (e) {
        toast.error("Failed to lookup or create customer");
        setIntakeSaving(false);
        return;
      }

      // 2. Submit intake
      const payload = {
        customer_id,
        customer_store_id: store_id,
        location_code: "junction",
        garments: intakeForm.garments.map(g => ({
          ...g,
          assigned_to: g.assigned_to === "unassigned" ? null : g.assigned_to,
          promised_at: g.promised_at ? new Date(g.promised_at).toISOString() : null,
          service_charge: "0",
          amount_paid: "0",
          alteration_type_id: g.alteration_type_id === "none" ? null : g.alteration_type_id
        }))
      };

      const r = await api.post('/atelier/intake', payload);
      
      // Attempt condition photo uploads if they exist on garments
      for (let i = 0; i < r.data.jobs.length; i++) {
        const job = r.data.jobs[i];
        const localGarment = intakeForm.garments[i];
        if (localGarment.condition_photo) {
          try {
            const formData = new FormData();
            formData.append("file", localGarment.condition_photo);
            await api.post(`/atelier/jobs/${job.id}/photos?caption=Condition+at+intake`, formData, {
              headers: { "Content-Type": "multipart/form-data" }
            });
          } catch {
            // Photo upload failure should not fail the intake process
            toast.error(`Job ${job.claim_number} created, but failed to upload condition photo.`);
          }
        }
      }

      toast.success(`${r.data.count} job(s) created successfully`);
      setIntakeOpen(false);
      setIntakeForm({
        customer_phone: "",
        customer_name: "",
        garments: [{
          garment_type: "", sku: "", product_name: "", colour: "", size: "", condition_notes: "",
          alteration_notes: "", promised_at: "", alteration_type_id: "none", assigned_to: "unassigned"
        }]
      });
      loadJobs();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create job");
    } finally {
      setIntakeSaving(false);
    }
  };

  const filteredJobs = jobs.filter(j => {
    if (filterStatus !== "all" && j.status !== filterStatus) return false;
    if (searchQ) {
      const q = searchQ.toLowerCase();
      if (!j.claim_number?.toLowerCase().includes(q) && !j.customer_phone?.includes(q) && !j.customer_name?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto min-h-screen">
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-[var(--vivo-navy)] text-white flex items-center justify-center shadow-md">
            <Scissors className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-display text-3xl text-[var(--vivo-navy)]">Atelier</h1>
            <p className="text-sm text-[var(--vivo-muted)] tracking-wide">Junction Operations Workbench</p>
          </div>
        </div>
        <Button onClick={() => setIntakeOpen(true)} className="h-12 px-6 rounded-sm bg-[var(--vivo-gold)] hover:bg-[var(--vivo-gold-700)] text-white shadow-sm font-semibold">
          <Plus className="mr-2 h-5 w-5" /> New Intake
        </Button>
      </div>

      <Card className="vivo-card rounded-sm overflow-hidden border-t-4 border-t-[var(--vivo-navy)] shadow-sm">
        <div className="p-4 border-b border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--vivo-muted)]" />
              <Input
                placeholder="Claim #, Name, Phone..."
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                className="pl-9 h-9 w-64 rounded-sm bg-white"
              />
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="h-9 w-40 rounded-sm bg-white">
                <Filter className="h-3.5 w-3.5 mr-2 text-[var(--vivo-muted)]" />
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="intake">Intake</SelectItem>
                <SelectItem value="fitting">Fitting</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="quality_check">Quality Check</SelectItem>
                <SelectItem value="ready">Ready</SelectItem>
                <SelectItem value="collected">Collected</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="text-sm font-medium text-[var(--vivo-muted)]">
            {filteredJobs.length} Job{filteredJobs.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="overflow-x-auto min-h-[400px]">
          {loading ? (
            <div className="p-10 text-center text-[var(--vivo-muted)]">Loading jobs...</div>
          ) : filteredJobs.length === 0 ? (
            <div className="p-20 flex flex-col items-center justify-center text-[var(--vivo-muted)]">
              <Scissors className="h-10 w-10 mb-4 opacity-20" />
              <p>No jobs found.</p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b border-[var(--vivo-border)] text-xs uppercase tracking-wider text-[var(--vivo-muted)] bg-[var(--vivo-bg-soft)]">
                      <th className="px-6 py-4 font-semibold">Claim #</th>
                      <th className="px-6 py-4 font-semibold">Customer</th>
                      <th className="px-6 py-4 font-semibold">Garment & Alteration</th>
                      <th className="px-6 py-4 font-semibold">Status</th>
                      <th className="px-6 py-4 font-semibold">Promise Date</th>
                      <th className="px-6 py-4 font-semibold">Assignee</th>
                      <th className="px-6 py-4 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--vivo-border)]">
                    {filteredJobs.map(job => (
                      <tr key={job.id} className="hover:bg-[var(--vivo-bg-soft)] transition-colors group cursor-pointer" onClick={() => navigate(`/atelier/jobs/${job.id}`)}>
                        <td className="px-6 py-4 font-mono-num font-medium text-[var(--vivo-navy)] whitespace-nowrap">
                          {job.claim_number}
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-medium">{job.customer_name}</div>
                          <div className="text-xs text-[var(--vivo-muted)] whitespace-nowrap">{job.customer_phone}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-medium text-[var(--vivo-navy)] line-clamp-1">{job.sku || job.product_name || job.garment_type || '—'}</div>
                          <div className="text-xs text-[var(--vivo-muted)] line-clamp-1 mt-0.5">{job.alteration_notes}</div>
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant="outline" className={`rounded-sm text-[10px] font-bold uppercase tracking-wide
                            ${job.status === 'intake' ? 'border-[var(--vivo-gold)] text-[var(--vivo-gold-700)] bg-[var(--vivo-gold)]/10' : ''}
                            ${job.status === 'ready' ? 'border-emerald-500 text-emerald-700 bg-emerald-50' : ''}
                            ${job.status === 'in_progress' ? 'border-blue-500 text-blue-700 bg-blue-50' : ''}
                          `}>
                            {job.status.replace("_", " ")}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {job.promised_at ? formatDate(job.promised_at) : '—'}
                        </td>
                        <td className="px-6 py-4 text-[var(--vivo-muted)]">
                          {job.assigned_to_name || 'Unassigned'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 text-[var(--vivo-navy)]">
                            View <ChevronRight className="ml-1 h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden divide-y divide-[var(--vivo-border)]">
                {filteredJobs.map(job => (
                  <div key={job.id} onClick={() => navigate(`/atelier/jobs/${job.id}`)} className="p-4 bg-white active:bg-[var(--vivo-bg-soft)] transition-colors cursor-pointer space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="font-mono-num font-bold text-[var(--vivo-navy)]">{job.claim_number}</div>
                      <Badge variant="outline" className={`rounded-sm text-[10px] font-bold uppercase tracking-wide
                        ${job.status === 'intake' ? 'border-[var(--vivo-gold)] text-[var(--vivo-gold-700)] bg-[var(--vivo-gold)]/10' : ''}
                        ${job.status === 'ready' ? 'border-emerald-500 text-emerald-700 bg-emerald-50' : ''}
                        ${job.status === 'in_progress' ? 'border-blue-500 text-blue-700 bg-blue-50' : ''}
                      `}>
                        {job.status.replace("_", " ")}
                      </Badge>
                    </div>
                    
                    <div>
                      <div className="font-medium text-sm text-[var(--vivo-navy)] line-clamp-1">{job.sku || job.product_name || job.garment_type || '—'}</div>
                      <div className="text-xs text-[var(--vivo-muted)] line-clamp-2 mt-0.5">{job.alteration_notes}</div>
                    </div>
                    
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--vivo-muted)]">
                      <div className="flex items-center gap-1.5 min-w-[120px]">
                        <User className="h-3 w-3 shrink-0" />
                        <span className="truncate">{job.customer_name}</span>
                      </div>
                      {job.promised_at && (
                        <div className="flex items-center gap-1.5">
                          <Scissors className="h-3 w-3 shrink-0" />
                          <span>Due: {formatDate(job.promised_at)}</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="text-xs text-[var(--vivo-muted)] border-t border-[var(--vivo-border)] pt-2 mt-2">
                      Assignee: {job.assigned_to_name || 'Unassigned'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <Dialog open={intakeOpen} onOpenChange={setIntakeOpen}>
        <DialogContent className="max-w-full sm:max-w-3xl rounded-sm w-[95vw] sm:w-full h-[90vh] sm:h-auto overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-[var(--vivo-navy)] flex items-center gap-2">
              <Scissors className="h-5 w-5" /> New Atelier Intake
            </DialogTitle>
            <DialogDescription>
              Create alteration jobs for a customer.
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid grid-cols-2 gap-4 mt-2 mb-6 bg-[var(--vivo-bg-soft)] p-4 rounded-sm border border-[var(--vivo-border)]">
            <div className="space-y-1">
              <Label>Customer Phone *</Label>
              <Input 
                value={intakeForm.customer_phone} 
                onChange={e => setIntakeForm(f => ({ ...f, customer_phone: e.target.value }))}
                onBlur={e => lookupCustomer(e.target.value)}
                placeholder="+254..." className="rounded-sm h-10 bg-white"
              />
            </div>
            <div className="space-y-1">
              <Label>Customer Name</Label>
              <Input 
                value={intakeForm.customer_name} 
                onChange={e => setIntakeForm(f => ({ ...f, customer_name: e.target.value }))}
                placeholder="Walk-in name" className="rounded-sm h-10 bg-white"
              />
            </div>
          </div>

          {activeCustomerId && (
            <div className="bg-[var(--vivo-bg-soft)] border border-[var(--vivo-border)] p-4 mb-6 rounded-sm">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-[var(--vivo-navy)]">Customer Measurements</h4>
                <Button size="sm" variant="outline" onClick={() => setMeasurementOpen(true)} className="h-8 rounded-sm">
                  <Plus className="mr-1 h-3 w-3" /> Add Measurement
                </Button>
              </div>
              {customerMeasurements.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {customerMeasurements.map(m => (
                    <Badge key={m.id} variant="secondary" className="font-normal rounded-sm bg-white border border-[var(--vivo-border)]" title={m.note}>
                      {m.name}: <span className="font-bold ml-1">{m.value} {m.unit}</span>
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[var(--vivo-muted)]">No measurements recorded yet.</div>
              )}
            </div>
          )}

          <div className="max-h-[50vh] overflow-y-auto space-y-6 pr-2">
            {intakeForm.garments.map((g, i) => (
              <div key={i} className="border border-[var(--vivo-border)] rounded-sm p-4 relative">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="font-display text-lg text-[var(--vivo-navy)]">Garment #{i + 1}</h4>
                  {intakeForm.garments.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => removeGarment(i)} className="text-red-500 h-8 hover:bg-red-50 hover:text-red-700">
                      Remove
                    </Button>
                  )}
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label>Garment Type *</Label>
                    <Input value={g.garment_type} onChange={e => updateGarment(i, 'garment_type', e.target.value)} placeholder="Dress, Trousers..." className="rounded-sm h-10" />
                  </div>
                  <div className="space-y-1 relative">
                    <Label>SKU Lookup</Label>
                    <Input 
                      value={g.sku} 
                      onChange={e => handleSkuSearch(i, e.target.value)}
                      onFocus={() => { if (g.sku.length > 2) handleSkuSearch(i, g.sku); }}
                      onBlur={() => setTimeout(() => setSkuSearchIndex(null), 200)}
                      placeholder="e.g. V-DR-123" className="rounded-sm h-10" 
                    />
                    {skuSearchIndex === i && skuSearchResults.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[var(--vivo-border)] shadow-lg rounded-sm z-50 max-h-48 overflow-y-auto">
                        {skuSearchResults.map(match => (
                          <div key={match.sku} onMouseDown={() => selectSku(i, match)} className="p-2 text-sm hover:bg-[var(--vivo-bg-soft)] cursor-pointer border-b border-[var(--vivo-border)] last:border-0">
                            <div className="font-medium text-[var(--vivo-navy)]">{match.sku}</div>
                            <div className="text-xs text-[var(--vivo-muted)]">{match.product_name} · {match.colour} · {match.size}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label>Fallback Description</Label>
                    <Input value={g.product_name} onChange={e => updateGarment(i, 'product_name', e.target.value)} placeholder="Navy wrap dress" className="rounded-sm h-10" />
                  </div>
                  <div className="space-y-1">
                    <Label>Condition Notes</Label>
                    <Input value={g.condition_notes} onChange={e => updateGarment(i, 'condition_notes', e.target.value)} placeholder="New, worn, hem damaged..." className="rounded-sm h-10" />
                  </div>
                  <div className="space-y-1">
                    <Label>Condition Photo (optional)</Label>
                    <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => {
                      if (e.target.files && e.target.files.length > 0) {
                        updateGarment(i, 'condition_photo', e.target.files[0]);
                      }
                    }} className="rounded-sm h-10" />
                  </div>

                  <div className="col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label>Alteration Type</Label>
                      <Select value={g.alteration_type_id} onValueChange={v => updateGarment(i, 'alteration_type_id', v)}>
                        <SelectTrigger className="rounded-sm h-10 bg-white">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent className="rounded-sm">
                          <SelectItem value="none">None / Custom</SelectItem>
                          {alterationTypes.map(t => (
                            <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="col-span-2 space-y-1">
                    <Label>Alteration Details</Label>
                    <Textarea value={g.alteration_notes} onChange={e => updateGarment(i, 'alteration_notes', e.target.value)} placeholder="Take in waist by 1 inch..." rows={3} className="rounded-sm resize-none" />
                  </div>

                  <div className="space-y-1">
                    <Label>Promise Date</Label>
                    <Input type="datetime-local" value={g.promised_at} onChange={e => updateGarment(i, 'promised_at', e.target.value)} className="rounded-sm h-10" />
                  </div>
                  <div className="space-y-1">
                    <Label>Assign To Tailor</Label>
                    <Select value={g.assigned_to} onValueChange={v => updateGarment(i, 'assigned_to', v)}>
                      <SelectTrigger className="rounded-sm h-10">
                        <SelectValue placeholder="Unassigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unassigned">Unassigned</SelectItem>
                        {tailors.map(t => (
                          <SelectItem key={String(t.id)} value={String(t.user_id || t.id)}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  {/* Pricing inactive, submitting 0 */}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <Button variant="outline" onClick={addGarment} className="rounded-sm border-[var(--vivo-gold)] text-[var(--vivo-gold-700)] hover:bg-[var(--vivo-gold)]/10 border-dashed w-full">
              <Plus className="mr-2 h-4 w-4" /> Add Another Garment
            </Button>
          </div>

          <DialogFooter className="mt-6">
            <Button variant="ghost" onClick={() => setIntakeOpen(false)}>Cancel</Button>
            <Button disabled={intakeSaving} onClick={submitIntake} className="rounded-sm bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy-700)] shadow-sm">
              {intakeSaving ? "Saving..." : "Create Intake"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={measurementOpen} onOpenChange={setMeasurementOpen}>
        <DialogContent className="rounded-sm w-[95vw] max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Add Measurement</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Name (e.g. Bust, Waist, Inseam)</Label>
              <Input value={measurementForm.name} onChange={e => setMeasurementForm(f => ({ ...f, name: e.target.value }))} className="mt-1" />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label>Value</Label>
                <Input value={measurementForm.value} onChange={e => setMeasurementForm(f => ({ ...f, value: e.target.value }))} className="mt-1" />
              </div>
              <div className="w-24">
                <Label>Unit</Label>
                <Select value={measurementForm.unit} onValueChange={v => setMeasurementForm(f => ({ ...f, unit: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cm">cm</SelectItem>
                    <SelectItem value="in">inch</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Note (Optional)</Label>
              <Input value={measurementForm.note} onChange={e => setMeasurementForm(f => ({ ...f, note: e.target.value }))} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMeasurementOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveMeasurement} disabled={measurementSaving} className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy-700)]">
              {measurementSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
