import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

/**
 * Multi-select filter dropdown shared by the PLM ("In Development") and Full
 * Catalogue ("Odoo Mirror") toolbars. Replaces the native single <select>:
 * a button summarising the selection (value name, comma list, or "×N" count
 * badge) opens a checkbox menu with a Clear action; clicking outside closes
 * it. An empty selection means "All".
 */
export default function MultiSelectFilter({
  label,
  options,
  values,
  onChange,
  testId,
  variant = 'catalogue',
  alwaysShowCount = false,
}: {
  label: string;
  options: string[];
  values: string[];
  onChange: (next: string[]) => void;
  testId?: string;
  variant?: 'catalogue' | 'plm';
  alwaysShowCount?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('touchstart', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('touchstart', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (option: string) => {
    onChange(values.includes(option) ? values.filter((v) => v !== option) : [...values, option]);
  };

  const summary = values.length === 0
    ? 'All'
    : values.length === 1
      ? values[0]
      : values.slice(0, 2).join(', ') + (values.length > 2 ? '…' : '');

  return (
    <div className={`msf msf-${variant}`} ref={rootRef}>
      <button
        type="button"
        className={`msf-button ${values.length ? 'has-selection' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Filter by ${label.toLowerCase()}`}
        onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }}
        data-testid={testId}
      >
        <span className="msf-label">{label}</span>
        <span className="msf-summary" title={values.join(', ') || 'All'}>{summary}</span>
        {values.length > 1 || (alwaysShowCount && values.length > 0) ? <span className="msf-badge">×{values.length}</span> : null}
        <ChevronDown size={13} className="msf-caret" />
      </button>
      {open && (
        <div className="msf-menu" role="listbox" aria-multiselectable="true" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="msf-clear"
            disabled={values.length === 0}
            onClick={() => onChange([])}
            data-testid={testId ? `${testId}-clear` : undefined}
          >
            <X size={12} /> Clear{values.length ? ` (${values.length})` : ''}
          </button>
          <div className="msf-options">
            {options.map((option) => {
              const checked = values.includes(option);
              return (
                <button
                  type="button"
                  key={option}
                  role="option"
                  aria-selected={checked}
                  className={`msf-option ${checked ? 'checked' : ''}`}
                  onClick={() => toggle(option)}
                  data-testid={testId ? `${testId}-option-${option}` : undefined}
                >
                  <span className={`msf-box ${checked ? 'on' : ''}`}>{checked && <Check size={11} />}</span>
                  <span className="msf-option-label" title={option}>{option}</span>
                </button>
              );
            })}
            {options.length === 0 && <div className="msf-empty">No options</div>}
          </div>
        </div>
      )}
    </div>
  );
}
