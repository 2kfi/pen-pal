import type { ChangeEvent } from 'react';

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password' | 'date';
  hint?: string;
  error?: string;
  autoComplete?: string;
  maxLength?: number;
  required?: boolean;
  placeholder?: string;
}

/**
 * Label + input + hint + error, wired together for assistive tech.
 *
 * The label is a real <label for>, the hint is referenced by aria-describedby,
 * and the error is announced via role="alert". WCAG 2.2 §3.3.2 / §4.1.3.
 *
 * This exists because v0.0.2 shipped bare <input placeholder="username"> with no
 * label at all — the placeholder was the only accessible name.
 */
export default function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error,
  autoComplete,
  maxLength,
  required,
  placeholder,
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-required={required}
        autoComplete={autoComplete}
        maxLength={maxLength}
        required={required}
        placeholder={placeholder}
      />
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}