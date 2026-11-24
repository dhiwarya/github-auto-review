import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from '../../../src/settings-schema.ts';

export type Edit = (fn: (d: Settings) => void) => void;
// The messages for a field and anything under it.
export type ErrorFor = (path: string) => string | undefined;

export const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div>
        <h2>{title}</h2>
        {description && <p className="small muted section-desc">{description}</p>}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <div className="small muted">{hint}</div>}
      {error && <div className="small error">{error}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="small muted block">{hint}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; suffix?: string }) {
  return (
    <div className="row number-row">
      <input type="number" value={Number.isNaN(value) ? '' : value} min={min} max={max} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
      {suffix && <span className="muted small">{suffix}</span>}
    </div>
  );
}

// One entry per line. Keeps its own text so blank lines survive while you type.
export function ListInput({ value, onChange, placeholder, rows = 4 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => {
    if (lines(text).join('\n') !== value.join('\n')) setText(value.join('\n'));
  }, [value]);
  return (
    <textarea
      rows={rows}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        onChange(lines(e.target.value));
      }}
    />
  );
}
