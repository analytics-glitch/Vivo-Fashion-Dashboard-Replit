import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, AlertCircle, Ruler, Scissors } from 'lucide-react';
import { btnPrimary, inputCls, cardCls } from './ui';
import { api, postNativeMessage } from '@/lib/api';

const SIZE_OPTIONS = [
  { size: 'XS', UK: '4-6', US: '0-2' },
  { size: 'S', UK: '8-10', US: '4-6' },
  { size: 'M', UK: '12-14', US: '8-10' },
  { size: 'L', UK: '16-18', US: '12-14' },
  { size: '1X', UK: '20', US: '16' },
  { size: '2X', UK: '22', US: '18' },
  { size: '3X', UK: '24', US: '20' },
];

export default function MySizeView({ member, onBack, onMemberUpdate }) {
  const profile = member?.size_profile || {};
  const [mode, setMode] = useState(profile.method || 'measurements'); // 'measurements' or 'known'
  
  const [bust, setBust] = useState(profile.bust_in ?? '');
  const [waist, setWaist] = useState(profile.waist_in ?? '');
  const [hips, setHips] = useState(profile.hips_in ?? '');
  
  const [system, setSystem] = useState(profile.known_size_system || 'UK');
  const [knownSize, setKnownSize] = useState(profile.known_size || '');
  const [savedProfile, setSavedProfile] = useState(member?.size_profile || null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [pointsAwarded, setPointsAwarded] = useState(0);

  const handleSave = async () => {
    setError(null);
    setSuccess(false);

    if (mode === 'measurements') {
      if (!bust || !waist || !hips) {
        setError('Please enter your bust, waist, and hips measurements.');
        return;
      }
      const measurements = [Number(bust), Number(waist), Number(hips)];
      if (measurements.some((value) => !Number.isFinite(value) || value < 20 || value > 80)) {
        setError('Measurements must be valid numbers between 20 and 80 inches.');
        return;
      }
    } else {
      if (!knownSize) {
        setError('Please choose your known size.');
        return;
      }
    }

    setLoading(true);
    try {
      const payload = {
        method: mode,
        bust_in: mode === 'measurements' ? Number(bust) : null,
        waist_in: mode === 'measurements' ? Number(waist) : null,
        hips_in: mode === 'measurements' ? Number(hips) : null,
        known_size_system: mode === 'known' ? system : null,
        known_size: mode === 'known' ? knownSize : null,
      };

      const res = await api.sizeProfileSave(payload);
      
      if (res.member && onMemberUpdate) {
        onMemberUpdate(res.member);
      }
      
      if (res.points_awarded) {
        setPointsAwarded(res.points_awarded_value || 15);
        postNativeMessage('notification-moment', { moment: 'points-awarded' });
      }
      setSavedProfile(res.profile || null);
      setSuccess(true);
    } catch (err) {
      setError(err.message || 'Failed to save size profile. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto pb-20 animate-in fade-in duration-300" data-testid="my-size-view">
      <div className="flex items-center gap-4 mb-8">
        <button 
          onClick={onBack} 
          className="p-2 -ml-2 rounded-full hover:bg-secondary text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="Go back"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-serif text-foreground">My Size</h1>
      </div>

      <div className="mb-8 p-5 bg-secondary/50 border border-border rounded-lg">
        <p className="text-[14px] text-foreground leading-relaxed">
          Completing your size profile helps us recommend the perfect fit. It counts as your first Fit Notes contribution and awards <strong className="font-semibold text-primary-ink">15 points</strong>.
        </p>
      </div>

      {savedProfile?.recommended_size && (
        <div className={`${cardCls} p-5 mb-8 border-primary/40 bg-primary/5`} data-testid="my-size-current-recommendation">
          <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1">Your saved recommendation</div>
          <div className="font-serif text-2xl text-foreground">{savedProfile.recommended_size}</div>
          {savedProfile.size_up && (
            <p className="text-[13px] font-medium text-primary-ink mt-2">
              true to size may vary — consider sizing up
            </p>
          )}
        </div>
      )}

      <div className="flex bg-secondary p-1 rounded-lg mb-8">
        <button 
          data-testid="my-size-mode-measurements"
          onClick={() => { setMode('measurements'); setSuccess(false); setError(null); }}
          className={`flex-1 py-2.5 text-[14px] font-medium rounded-md transition-all ${mode === 'measurements' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <div className="flex items-center justify-center gap-2">
            <Ruler size={16} />
            Measurements
          </div>
        </button>
        <button 
          data-testid="my-size-mode-known"
          onClick={() => { setMode('known'); setSuccess(false); setError(null); }}
          className={`flex-1 py-2.5 text-[14px] font-medium rounded-md transition-all ${mode === 'known' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <div className="flex items-center justify-center gap-2">
            <Scissors size={16} />
            Known Size
          </div>
        </button>
      </div>

      <div className={`${cardCls} p-6 sm:p-8`}>
        {mode === 'measurements' && (
          <div className="space-y-6 animate-in slide-in-from-left-2 duration-300">
            <div className="space-y-2">
              <label htmlFor="my-size-bust" className="text-[13px] font-semibold text-foreground">Bust (inches)</label>
              <input 
                id="my-size-bust"
                data-testid="my-size-bust"
                type="number"
                step="0.5"
                value={bust}
                onChange={e => setBust(e.target.value)}
                className={`${inputCls} w-full`}
                placeholder="e.g. 36"
              />
              <p className="text-[13px] text-muted-foreground">Bust: measure around the fullest part of your bust/chest.</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="my-size-waist" className="text-[13px] font-semibold text-foreground">Waist (inches)</label>
              <input 
                id="my-size-waist"
                data-testid="my-size-waist"
                type="number"
                step="0.5"
                value={waist}
                onChange={e => setWaist(e.target.value)}
                className={`${inputCls} w-full`}
                placeholder="e.g. 29"
              />
              <p className="text-[13px] text-muted-foreground">Waist: measure around the smallest part of your waist, above your bellybutton.</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="my-size-hips" className="text-[13px] font-semibold text-foreground">Hips (inches)</label>
              <input 
                id="my-size-hips"
                data-testid="my-size-hips"
                type="number"
                step="0.5"
                value={hips}
                onChange={e => setHips(e.target.value)}
                className={`${inputCls} w-full`}
                placeholder="e.g. 40"
              />
              <p className="text-[13px] text-muted-foreground">Hips: measure around the widest part of your hip, around your bottom.</p>
            </div>
          </div>
        )}

        {mode === 'known' && (
          <div className="space-y-6 animate-in slide-in-from-right-2 duration-300">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label htmlFor="my-size-system" className="text-[13px] font-semibold text-foreground">System</label>
                <select 
                  id="my-size-system"
                  data-testid="my-size-system"
                  value={system}
                  onChange={e => { setSystem(e.target.value); setKnownSize(''); }}
                  className={`${inputCls} w-full appearance-none bg-no-repeat`}
                  style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundPosition: 'right 1rem center' }}
                >
                  <option value="UK">UK Size</option>
                  <option value="US">US Size</option>
                </select>
              </div>
              <div className="space-y-2">
                <label htmlFor="my-size-known-size" className="text-[13px] font-semibold text-foreground">Size</label>
                <select 
                  id="my-size-known-size"
                  data-testid="my-size-known-size"
                  value={knownSize}
                  onChange={e => setKnownSize(e.target.value)}
                  className={`${inputCls} w-full`}
                >
                  <option value="">Choose size</option>
                  {SIZE_OPTIONS.map((row) => (
                    <option key={row.size} value={row[system]}>
                      {system} {row[system]} — Vivo {row.size}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-[13px] text-muted-foreground">Select the sizing system you are most comfortable with and enter your typical dress or top size.</p>
          </div>
        )}

        {error && (
          <div className="mt-6 p-4 bg-destructive/10 text-destructive text-[14px] rounded-lg flex items-start gap-3 animate-in fade-in">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {success && (
          <div className="mt-6 p-4 bg-primary/10 text-primary-ink text-[14px] rounded-lg flex items-start gap-3 animate-in fade-in">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
            <div>
              <p className="font-medium">Size profile saved successfully.</p>
              {pointsAwarded > 0 && <p className="mt-1">You earned {pointsAwarded} points for this Fit Notes contribution.</p>}
            </div>
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-border">
          <button 
            data-testid="my-size-save"
            onClick={handleSave}
            disabled={loading}
            className={btnPrimary}
          >
            {loading ? 'Saving...' : 'Save My Size'}
          </button>
        </div>
      </div>
    </div>
  );
}
