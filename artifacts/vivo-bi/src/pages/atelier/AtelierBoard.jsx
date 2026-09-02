import React, { useEffect, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, fmtDate } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Search, Plus, Scissors, Filter, ChevronRight, User, AlertCircle, X, Loader2 } from "lucide-react";

const STATUS_LABELS = {
  intake: "Received",
  fitting: "Fitting",
  in_progress: "In Progress",
  quality_check: "Quality Check",
  ready: "Ready for Pickup",
  collected: "Collected",
  cancelled: "Cancelled",
};

const statusLabel = (status) => STATUS_LABELS[status] || String(status || "").replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());

const statusClass = (status) => {
  if (status === "ready" || status === "collected") return "border-[#3F6B4A] text-[#31563b] bg-[#e7f0e8]";
  if (status === "cancelled") return "border-[#A5392F] text-[#8b2e27] bg-[#f7e7e3]";
  if (status === "intake" || status === "fitting") return "border-[#A97A24] text-[#7d5918] bg-[#f6ecd4]";
  return "border-[#A04F2E] text-[#834026] bg-[#f4e7df]";
};

const blankGarment = () => ({
  product_query: "",
  garment_category: "",
  garment_subcategory: "",
  system_description: "",
  garment_type: "",
  sku: "",
  product_name: "",
  colour: "",
  size: "",
  condition_notes: "",
  alteration_notes: "",
  promised_at: "",
  alteration_type_id: "none",
  assigned_to: "unassigned",
  condition_photo: null
});

export default function AtelierBoard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [initError, setInitError] = useState(null);

  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeForm, setIntakeForm] = useState({
    customer_phone: "",
    customer_name: "",
    garments: [blankGarment()]
  });
  const [intakeSaving, setIntakeSaving] = useState(false);
  const [tailors, setTailors] = useState([]);
  const [alterationTypes, setAlterationTypes] = useState([]);
  const [customerMeasurements, setCustomerMeasurements] = useState([]);
  
  const [skuSearchIndex, setSkuSearchIndex] = useState(null);
  const [skuSearchResults, setSkuSearchResults] = useState([]);
  const [skuSearching, setSkuSearching] = useState(false);
  const [skuSearchError, setSkuSearchError] = useState("");
  const [skuActiveIndex, setSkuActiveIndex] = useState(0);
  const [skuResultContext, setSkuResultContext] = useState(null);
  const skuTimerRef = useRef(null);
  const skuRequestRef = useRef(0);

  const handleSkuSearch = (index, query) => {
    setIntakeForm(f => {
      const garments = [...f.garments];
      garments[index] = {
        ...garments[index],
        product_query: query,
        sku: "",
        product_name: "",
        garment_category: "",
        garment_subcategory: "",
        system_description: "",
        garment_type: "",
        colour: "",
        size: ""
      };
      return { ...f, garments };
    });
    if (skuTimerRef.current) clearTimeout(skuTimerRef.current);
    const requestId = ++skuRequestRef.current;
    const normalizedQuery = query.trim();
    setSkuResultContext({ index, query: normalizedQuery });
    setSkuSearchIndex(index);
    setSkuSearchError("");
    setSkuActiveIndex(0);
    if (normalizedQuery.length < 2) {
      setSkuSearchResults([]);
      setSkuSearching(false);
      return;
    }
    setSkuSearching(true);
    skuTimerRef.current = setTimeout(async () => {
      try {
        const r = await api.get('/atelier/skus', { params: { q: normalizedQuery }, forceFresh: true });
        if (requestId !== skuRequestRef.current) return;
        setSkuSearchResults(r.data.items || []);
      } catch (e) {
        if (requestId !== skuRequestRef.current) return;
        setSkuSearchResults([]);
        setSkuSearchError(e?.response?.data?.detail || "Product search failed. Try again.");
      } finally {
        if (requestId === skuRequestRef.current) setSkuSearching(false);
      }
    }, 300);
  };

  const selectSku = (index, match) => {
    if (skuResultContext?.index !== index) return;
    updateGarment(index, 'product_query', `${match.sku}${match.style_name ? ` · ${match.style_name}` : ""}`);
    updateGarment(index, 'sku', match.sku);
    updateGarment(index, 'product_name', match.system_description || match.product_name || "");
    updateGarment(index, 'system_description', match.system_description || match.product_name || "");
    updateGarment(index, 'garment_category', match.garment_category || "");
    updateGarment(index, 'garment_type', match.garment_category || "");
    updateGarment(index, 'garment_subcategory', match.garment_subcategory || "");
    updateGarment(index, 'colour', match.colour || "");
    updateGarment(index, 'size', match.size || "");
    setSkuSearchResults([]);
    setSkuSearchIndex(null);
  };

  const [measurementOpen, setMeasurementOpen] = useState(false);
  const [measurementForm, setMeasurementForm] = useState({ name: "", value: "", unit: "cm", note: "" });
  const [measurementSaving, setMeasurementSaving] = useState(false);
  const [activeCustomerId, setActiveCustomerId] = useState(null);
  const [activeCustomerStoreId, setActiveCustomerStoreId] = useState(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [customerSearchError, setCustomerSearchError] = useState("");
  const [customerListOpen, setCustomerListOpen] = useState(false);
  const [customerActiveIndex, setCustomerActiveIndex] = useState(0);
  const customerRequestRef = useRef(0);
  const customerHistoryRequestRef = useRef(0);

  useEffect(() => {
    const query = customerQuery.trim();
    const requestId = ++customerRequestRef.current;
    if (!intakeOpen || query.length < 2 || activeCustomerId) {
      setCustomerResults([]);
      setCustomerSearching(false);
      return undefined;
    }
    setCustomerSearching(true);
    setCustomerSearchError("");
    setCustomerListOpen(true);
    const timer = setTimeout(async () => {
      try {
        const lookup = await api.get('/atelier/customers/lookup', {
          params: { q: query }, forceFresh: true
        });
        if (requestId !== customerRequestRef.current) return;
        setCustomerResults(lookup.data?.customers || []);
        setCustomerActiveIndex(0);
      } catch (e) {
        if (requestId !== customerRequestRef.current) return;
        setCustomerResults([]);
        setCustomerSearchError(e?.response?.data?.detail || "Customer search failed. Try again.");
      } finally {
        if (requestId === customerRequestRef.current) setCustomerSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [customerQuery, intakeOpen, activeCustomerId]);

  const selectCustomer = async (c) => {
    customerRequestRef.current += 1;
    const historyRequestId = ++customerHistoryRequestRef.current;
    setActiveCustomerId(c.customer_id);
    setActiveCustomerStoreId(c.store_id);
    setCustomerListOpen(false);
    setCustomerResults([]);
    setCustomerQuery("");
    setIntakeForm(f => ({
      ...f,
      customer_phone: c.phone || "",
      customer_name: `${c.first_name || ""} ${c.last_name || ""}`.trim()
    }));
    setCustomerMeasurements([]);
    try {
      const hist = await api.get(`/atelier/customers/${c.customer_id}/history`, {
        params: { store_id: c.store_id }, forceFresh: true
      });
      if (historyRequestId === customerHistoryRequestRef.current) {
        setCustomerMeasurements(hist.data.measurements || []);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Customer selected, but measurements could not be loaded.");
    }
  };

  const clearCustomer = () => {
    customerRequestRef.current += 1;
    customerHistoryRequestRef.current += 1;
    setActiveCustomerId(null);
    setActiveCustomerStoreId(null);
    setCustomerMeasurements([]);
    setIntakeForm(f => ({ ...f, customer_phone: "", customer_name: "" }));
    setCustomerQuery("");
  };

  const handleSaveMeasurement = async () => {
    if (!activeCustomerId) return toast.error("Customer not resolved. Lookup first.");
    if (!measurementForm.name || !measurementForm.value) return toast.error("Name and value are required");
    setMeasurementSaving(true);
    try {
      await api.post(`/atelier/customers/${activeCustomerId}/measurements`, {
        ...measurementForm,
        store_id: activeCustomerStoreId
      });
      toast.success("Measurement saved");
      setMeasurementOpen(false);
      setMeasurementForm({ name: "", value: "", unit: "cm", note: "" });
      const hist = await api.get(`/atelier/customers/${activeCustomerId}/history`, {
        params: { store_id: activeCustomerStoreId }, forceFresh: true
      });
      setCustomerMeasurements(hist.data.measurements || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save measurement");
    } finally {
      setMeasurementSaving(false);
    }
  };

  const init = async () => {
    setLoading(true);
    setInitError(null);
    try {
      const cr = await api.get('/atelier/config');
      setTailors(cr.data.staff || []);
      setAlterationTypes(cr.data.alteration_types || []);
      const locs = cr.data.locations || [];
      setLocations(locs);
      
      let initialLoc = selectedLocation;
      if (!initialLoc && locs.length > 0) {
        initialLoc = locs[0].code;
        setSelectedLocation(initialLoc);
      }
      setConfigLoaded(true);
    } catch (e) {
      setInitError(e?.response?.data?.detail || e?.message || "Failed to load configuration");
      setLoading(false);
    }
  };

  useEffect(() => {
    init();
    if (searchParams.get("new_job_phone")) {
      setCustomerQuery(searchParams.get("new_job_phone") || "");
      setIntakeOpen(true);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete("new_job_phone");
      setSearchParams(newParams);
    }
  }, []);

  const loadJobs = async (forceFresh = false) => {
    setLoading(true);
    setInitError(null);
    try {
      const params = {};
      if (selectedLocation) params.location_code = selectedLocation;
      if (filterStatus !== "all") params.status = filterStatus;
      const r = await api.get('/atelier/board', { params, forceFresh });
      setJobs(r.data.jobs || []);
    } catch (e) {
      setInitError(e?.response?.data?.detail || e?.message || "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (configLoaded) {
      loadJobs();
    }
  }, [configLoaded, filterStatus, selectedLocation]);

  const addGarment = () => {
    setIntakeForm(f => ({
      ...f,
      garments: [...f.garments, blankGarment()]
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
    if (!activeCustomerId || !activeCustomerStoreId) {
      return toast.error("Search for and select the correct customer before creating the intake.");
    }
    const invalidGarment = intakeForm.garments.find(g => !g.garment_category);
    if (invalidGarment) return toast.error("Garment Category is required for all items");
    
    setIntakeSaving(true);
    try {
      const payload = {
        customer_id: activeCustomerId,
        customer_store_id: activeCustomerStoreId,
        location_code: selectedLocation,
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
            toast.error(`Job ${job.claim_number} created, but failed to upload condition photo.`);
          }
        }
      }

      toast.success(`${r.data.count} job(s) created successfully`);
      setIntakeOpen(false);
      setIntakeForm({
        customer_phone: "",
        customer_name: "",
        garments: [blankGarment()]
      });
      clearCustomer();
      loadJobs(true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create job");
    } finally {
      setIntakeSaving(false);
    }
  };

  const filteredJobs = jobs.filter(j => {
    if (searchQ) {
      const q = searchQ.toLowerCase();
      if (!j.claim_number?.toLowerCase().includes(q) && !j.customer_phone?.includes(q) && !j.customer_name?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap gap-4 items-center justify-between">
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
          <div className="relative col-span-2 min-w-0 sm:col-span-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--muted)]" />
            <Input
              data-testid="input-search-board"
              placeholder="Claim #, Name, Phone..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              className="pl-9 h-10 w-full input-pill sm:w-64"
            />
          </div>
          <Select value={selectedLocation} onValueChange={setSelectedLocation} disabled={locations.length === 0}>
            <SelectTrigger className="h-10 w-full min-w-0 input-pill sm:w-40" data-testid="select-branch">
              <SelectValue placeholder="Branch" />
            </SelectTrigger>
            <SelectContent>
              {locations.map(l => (
                <SelectItem key={l.code} value={l.code}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="h-10 w-full min-w-0 input-pill sm:w-40" data-testid="select-status">
              <Filter className="h-3.5 w-3.5 mr-2 text-[var(--muted)]" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="intake">Received</SelectItem>
              <SelectItem value="fitting">Fitting</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="quality_check">Quality Check</SelectItem>
              <SelectItem value="ready">Ready for Pickup</SelectItem>
              <SelectItem value="collected">Collected</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        
        <Button onClick={() => setIntakeOpen(true)} className="btn-primary h-10 w-full px-5 shadow-sm sm:w-auto" data-testid="button-new-intake">
          <Plus className="mr-2 h-4 w-4" /> New Intake
        </Button>
      </div>

      <Card className="card overflow-hidden">
        {initError ? (
          <div className="p-12 flex flex-col items-center justify-center min-h-[400px] text-center" data-testid="error-board-load">
            <AlertCircle className="h-10 w-10 text-[var(--danger)] mb-4" />
            <p className="text-[var(--text)] font-semibold mb-2">Error loading board</p>
            <p className="text-[var(--muted)] text-sm mb-6">{initError}</p>
            <Button onClick={configLoaded ? loadJobs : init} className="btn-primary" data-testid="button-retry-board">
              Retry
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto min-h-[400px]">
            {loading ? (
              <div className="p-10 text-center text-[var(--muted)]">Loading board...</div>
            ) : filteredJobs.length === 0 ? (
              <div className="p-20 flex flex-col items-center justify-center text-[var(--muted)]">
                <Scissors className="h-10 w-10 mb-4 opacity-20" />
                <p>No jobs found.</p>
              </div>
            ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block">
                <table className="w-full text-sm text-left data" data-testid="table-jobs">
                  <thead>
                    <tr>
                      <th>Claim #</th>
                      <th>Customer</th>
                      <th>Garment & Alteration</th>
                      <th>Status</th>
                      <th>Promise Date</th>
                      <th>Assignee</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredJobs.map(job => (
                      <tr key={job.id} className="cursor-pointer group" onClick={() => navigate(`/atelier/jobs/${job.id}`)}>
                        <td className="tabular-nums font-medium text-[var(--text)] whitespace-nowrap">
                          {job.claim_number}
                        </td>
                        <td>
                          <div className="font-medium text-[var(--text)]">{job.customer_name}</div>
                          <div className="text-xs text-[var(--muted)] whitespace-nowrap">{job.customer_phone}</div>
                        </td>
                        <td>
                          <div className="font-medium text-[var(--accent)] line-clamp-1">{job.sku || job.product_name || job.garment_type || '—'}</div>
                          <div className="text-xs text-[var(--muted)] line-clamp-1 mt-0.5">{job.alteration_notes}</div>
                        </td>
                        <td>
                          <Badge variant="outline" className={`rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide ${statusClass(job.status)}`}>
                            {statusLabel(job.status)}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap">
                          {job.promised_at ? fmtDate(job.promised_at) : '—'}
                        </td>
                        <td className="text-[var(--muted)]">
                          {job.assigned_to_name || 'Unassigned'}
                        </td>
                        <td className="text-right">
                          <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 text-[var(--accent)] h-8 px-2">
                            View <ChevronRight className="ml-1 h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden divide-y divide-[var(--border)]">
                {filteredJobs.map(job => (
                  <div key={job.id} onClick={() => navigate(`/atelier/jobs/${job.id}`)} className="p-4 active:bg-[var(--panel)] transition-colors cursor-pointer space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="tabular-nums font-bold text-[var(--text)]">{job.claim_number}</div>
                      <Badge variant="outline" className={`rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide ${statusClass(job.status)}`}>
                        {statusLabel(job.status)}
                      </Badge>
                    </div>
                    
                    <div>
                      <div className="font-medium text-sm text-[var(--text)] line-clamp-1">{job.sku || job.product_name || job.garment_type || '—'}</div>
                      <div className="text-xs text-[var(--muted)] line-clamp-2 mt-0.5">{job.alteration_notes}</div>
                    </div>
                    
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--muted)]">
                      <div className="flex items-center gap-1.5 min-w-[120px]">
                        <User className="h-3 w-3 shrink-0" />
                        <span className="truncate">{job.customer_name}</span>
                      </div>
                      {job.promised_at && (
                        <div className="flex items-center gap-1.5">
                          <Scissors className="h-3 w-3 shrink-0" />
                          <span>Due: {fmtDate(job.promised_at)}</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="text-xs text-[var(--muted)] border-t border-[var(--border)] pt-2 mt-2">
                      Assignee: {job.assigned_to_name || 'Unassigned'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        )}
      </Card>

      <Dialog open={intakeOpen} onOpenChange={setIntakeOpen}>
        <DialogContent className="h-[90vh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto card-white p-4 sm:h-auto sm:max-w-3xl sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-xl text-[var(--text)] flex items-center gap-2">
              <Scissors className="h-5 w-5 text-[var(--accent)]" /> New Atelier Intake
            </DialogTitle>
            <DialogDescription>
              Create alteration jobs for a customer.
            </DialogDescription>
          </DialogHeader>
          
          <div className="relative mt-2 mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <Label htmlFor="atelier-customer-search">Find existing customer *</Label>
            {activeCustomerId ? (
              <div className="mt-2 flex min-w-0 items-start justify-between gap-3 rounded-xl border border-[var(--accent)]/40 bg-white p-3">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--text)]">{intakeForm.customer_name || "Unnamed customer"}</div>
                  <div className="mt-1 break-words text-xs text-[var(--muted)]">
                    {intakeForm.customer_phone || "No phone"} · Customer ID {activeCustomerId}
                  </div>
                </div>
                <button type="button" onClick={clearCustomer} aria-label="Clear selected customer"
                  className="shrink-0 rounded-full p-1.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <div className="relative mt-2">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
                  <Input id="atelier-customer-search" value={customerQuery}
                    onChange={e => setCustomerQuery(e.target.value)}
                    onFocus={() => customerQuery.trim().length >= 2 && setCustomerListOpen(true)}
                    onKeyDown={e => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setCustomerListOpen(true);
                        setCustomerActiveIndex(v => Math.min(v + 1, customerResults.length - 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setCustomerActiveIndex(v => Math.max(v - 1, 0));
                      } else if (e.key === "Enter" && customerResults[customerActiveIndex]) {
                        e.preventDefault();
                        selectCustomer(customerResults[customerActiveIndex]);
                      } else if (e.key === "Escape") {
                        setCustomerListOpen(false);
                      }
                    }}
                    role="combobox" aria-autocomplete="list" aria-expanded={customerListOpen}
                    aria-controls="atelier-customer-results"
                    placeholder="Search name, phone, email, or customer ID"
                    className="input-pill pl-9" autoComplete="off" />
                </div>
                {customerListOpen && customerQuery.trim().length >= 2 && (
                  <div id="atelier-customer-results" role="listbox"
                    className="absolute left-4 right-4 z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-white shadow-xl">
                    {customerSearching && (
                      <div className="flex items-center gap-2 p-3 text-sm text-[var(--muted)]">
                        <Loader2 className="h-4 w-4 animate-spin" /> Searching customers…
                      </div>
                    )}
                    {!customerSearching && customerSearchError && (
                      <div className="p-3 text-sm text-[var(--danger)]">{customerSearchError}</div>
                    )}
                    {!customerSearching && !customerSearchError && customerResults.length === 0 && (
                      <div className="p-3 text-sm text-[var(--muted)]">
                        No matching customers. Try another identifier; no customer will be created automatically.
                      </div>
                    )}
                    {!customerSearching && customerResults.map((c, index) => (
                      <button key={`${c.store_id}:${c.customer_id}`} type="button" role="option"
                        aria-selected={index === customerActiveIndex}
                        onMouseDown={e => { e.preventDefault(); selectCustomer(c); }}
                        onMouseEnter={() => setCustomerActiveIndex(index)}
                        className={`block w-full border-b border-[var(--border)] p-3 text-left last:border-0 ${
                          index === customerActiveIndex ? "bg-[var(--panel)]" : "hover:bg-[var(--panel)]"
                        }`}>
                        <div className="font-medium text-[var(--text)]">
                          {`${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unnamed customer"}
                        </div>
                        <div className="mt-1 break-words text-xs text-[var(--muted)]">
                          {[c.phone, c.email, `ID ${c.customer_id}`].filter(Boolean).join(" · ")}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {activeCustomerId && (
            <div className="bg-[var(--panel)] border border-[var(--border)] p-4 mb-6 rounded-xl">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-[var(--text)]">Customer Measurements</h4>
                <Button size="sm" variant="outline" onClick={() => setMeasurementOpen(true)} className="btn-ghost h-8">
                  <Plus className="mr-1 h-3 w-3" /> Add Measurement
                </Button>
              </div>
              {customerMeasurements.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {customerMeasurements.map(m => (
                    <Badge key={m.id} variant="secondary" className="font-normal bg-white border border-[var(--border)]" title={m.note}>
                      {m.name}: <span className="font-bold ml-1 text-[var(--accent)]">{m.value} {m.unit}</span>
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[var(--muted)]">No measurements recorded yet.</div>
              )}
            </div>
          )}

          <div className="max-h-[50vh] space-y-6 overflow-y-auto overflow-x-hidden sm:pr-2">
            {intakeForm.garments.map((g, i) => (
              <div key={i} className="relative min-w-0 rounded-xl border border-[var(--border)] bg-white p-3 sm:p-4">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="font-bold text-base text-[var(--text)]">Garment #{i + 1}</h4>
                  {intakeForm.garments.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => removeGarment(i)} className="text-[var(--danger)] h-8 hover:bg-red-50 hover:text-red-700">
                      Remove
                    </Button>
                  )}
                </div>
                
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="relative min-w-0 space-y-1 sm:col-span-2">
                    <Label htmlFor={`atelier-product-${i}`}>Find product</Label>
                    <Input 
                      id={`atelier-product-${i}`}
                      value={g.product_query}
                      onChange={e => handleSkuSearch(i, e.target.value)}
                      onFocus={() => {
                        if (!g.sku && g.product_query.trim().length >= 2) {
                          if (skuResultContext?.index === i && skuResultContext.query === g.product_query.trim()) {
                            setSkuSearchIndex(i);
                          } else {
                            handleSkuSearch(i, g.product_query);
                          }
                        }
                      }}
                      onKeyDown={e => {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setSkuActiveIndex(v => Math.min(v + 1, skuSearchResults.length - 1));
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setSkuActiveIndex(v => Math.max(v - 1, 0));
                        } else if (e.key === "Enter" && skuSearchResults[skuActiveIndex]) {
                          e.preventDefault();
                          selectSku(i, skuSearchResults[skuActiveIndex]);
                        } else if (e.key === "Escape") {
                          setSkuSearchIndex(null);
                        }
                      }}
                      onBlur={() => setTimeout(() => setSkuSearchIndex(null), 200)}
                      role="combobox" aria-autocomplete="list" aria-expanded={skuSearchIndex === i}
                      aria-controls={`atelier-product-results-${i}`}
                      placeholder="Search SKU, barcode, style, description, category…" className="input-pill"
                    />
                    {g.sku && (
                      <button type="button" onClick={() => handleSkuSearch(i, "")}
                        className="absolute right-2 top-7 rounded-full p-1 text-[var(--muted)] hover:text-[var(--text)]"
                        aria-label={`Clear product for garment ${i + 1}`}><X className="h-4 w-4" /></button>
                    )}
                    {skuSearchIndex === i && !g.sku && g.product_query.trim().length >= 2 &&
                      skuResultContext?.index === i &&
                      skuResultContext.query === g.product_query.trim() && (
                      <div id={`atelier-product-results-${i}`} role="listbox"
                        className="absolute top-full left-0 right-0 mt-1 bg-white border border-[var(--border)] shadow-lg rounded-xl z-50 max-h-64 overflow-y-auto">
                        {skuSearching && <div className="flex items-center gap-2 p-3 text-sm text-[var(--muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Searching products…</div>}
                        {!skuSearching && skuSearchError && <div className="p-3 text-sm text-[var(--danger)]">{skuSearchError}</div>}
                        {!skuSearching && !skuSearchError && skuSearchResults.length === 0 && (
                          <div className="p-3 text-sm text-[var(--muted)]">No matching catalogue variants.</div>
                        )}
                        {!skuSearching && skuSearchResults.map((match, index) => (
                          <button key={match.sku} type="button" role="option"
                            aria-selected={index === skuActiveIndex}
                            onMouseDown={e => { e.preventDefault(); selectSku(i, match); }}
                            onMouseEnter={() => setSkuActiveIndex(index)}
                            className={`block w-full p-3 text-left text-sm border-b border-[var(--border)] last:border-0 ${
                              index === skuActiveIndex ? "bg-[var(--panel)]" : "hover:bg-[var(--panel)]"
                            }`}>
                            <div className="font-medium text-[var(--text)]">{match.sku} {match.size ? `· ${match.size}` : ""} {match.colour ? `· ${match.colour}` : ""}</div>
                            <div className="mt-1 text-xs text-[var(--muted)]">{match.style_number || "No style"} · {match.style_name || match.system_description || "No description"}</div>
                            <div className="mt-1 text-[11px] text-[var(--muted)]">{[match.garment_category, match.garment_subcategory].filter(Boolean).join(" / ")}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label>Garment Category *</Label>
                    <Input value={g.garment_category}
                      onChange={e => {
                        updateGarment(i, 'garment_category', e.target.value);
                        updateGarment(i, 'garment_type', e.target.value);
                      }}
                      readOnly={Boolean(g.sku)} placeholder="Dresses" className="input-pill" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label>Garment Sub-category</Label>
                    <Input value={g.garment_subcategory}
                      onChange={e => updateGarment(i, 'garment_subcategory', e.target.value)}
                      readOnly={Boolean(g.sku)} placeholder="Maxi Dresses" className="input-pill" />
                  </div>
                  <div className="min-w-0 space-y-1 sm:col-span-2">
                    <Label>System Description</Label>
                    <Input value={g.system_description}
                      onChange={e => {
                        updateGarment(i, 'system_description', e.target.value);
                        updateGarment(i, 'product_name', e.target.value);
                      }}
                      readOnly={Boolean(g.sku)} placeholder="Catalogue description" className="input-pill" />
                    {g.sku && <div className="text-xs text-[var(--muted)]">SKU {g.sku} · {g.colour || "No colour"} · {g.size || "No size"}</div>}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label>Condition Notes</Label>
                    <Input value={g.condition_notes} onChange={e => updateGarment(i, 'condition_notes', e.target.value)} placeholder="New, worn, hem damaged..." className="input-pill" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label>Condition Photo (optional)</Label>
                    <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => {
                      if (e.target.files && e.target.files.length > 0) {
                        updateGarment(i, 'condition_photo', e.target.files[0]);
                      }
                    }} className="input-pill" />
                  </div>

                  <div className="grid min-w-0 grid-cols-1 gap-4 sm:col-span-2 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Alteration Type</Label>
                      <Select value={g.alteration_type_id} onValueChange={v => updateGarment(i, 'alteration_type_id', v)}>
                        <SelectTrigger className="input-pill">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None / Custom</SelectItem>
                          {alterationTypes.map(t => (
                            <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="min-w-0 space-y-1 sm:col-span-2">
                    <Label>Alteration Details</Label>
                    <Textarea value={g.alteration_notes} onChange={e => updateGarment(i, 'alteration_notes', e.target.value)} placeholder="Take in waist by 1 inch..." rows={3} className="input-pill resize-none" />
                  </div>

                  <div className="min-w-0 space-y-1">
                    <Label>Promise Date</Label>
                    <Input type="datetime-local" value={g.promised_at} onChange={e => updateGarment(i, 'promised_at', e.target.value)} className="input-pill" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label>Assign To Tailor</Label>
                    <Select value={g.assigned_to} onValueChange={v => updateGarment(i, 'assigned_to', v)}>
                      <SelectTrigger className="input-pill">
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
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <Button variant="outline" onClick={addGarment} className="btn-ghost border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/10 border-dashed w-full">
              <Plus className="mr-2 h-4 w-4" /> Add Another Garment
            </Button>
          </div>

          <DialogFooter className="mt-6">
            <Button variant="ghost" className="btn-ghost" onClick={() => setIntakeOpen(false)}>Cancel</Button>
            <Button disabled={intakeSaving} onClick={submitIntake} className="btn-primary">
              {intakeSaving ? "Saving..." : "Create Intake"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={measurementOpen} onOpenChange={setMeasurementOpen}>
        <DialogContent className="card-white w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Measurement</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Name (e.g. Bust, Waist, Inseam)</Label>
              <Input value={measurementForm.name} onChange={e => setMeasurementForm(f => ({ ...f, name: e.target.value }))} className="mt-1 input-pill" />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>Value</Label>
                <Input type="number" value={measurementForm.value} onChange={e => setMeasurementForm(f => ({ ...f, value: e.target.value }))} className="mt-1 input-pill" />
              </div>
              <div>
                <Label>Unit</Label>
                <Select value={measurementForm.unit} onValueChange={v => setMeasurementForm(f => ({ ...f, unit: v }))}>
                  <SelectTrigger className="mt-1 input-pill"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cm">cm</SelectItem>
                    <SelectItem value="in">inches</SelectItem>
                    <SelectItem value="mm">mm</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Note (Optional)</Label>
              <Input value={measurementForm.note} onChange={e => setMeasurementForm(f => ({ ...f, note: e.target.value }))} className="mt-1 input-pill" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className="btn-ghost" onClick={() => setMeasurementOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveMeasurement} disabled={measurementSaving} className="btn-primary">
              {measurementSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}