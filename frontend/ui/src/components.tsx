import { ReactNode, useId } from 'react';
import { Label } from './labels';
import { ApiError } from './api';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Pill({ label }: { label: Label | undefined }) {
  if (!label) return null;
  return <span className={`pill${label.tone ? ` pill-${label.tone}` : ''}`}>{label.text}</span>;
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card stack" aria-label={title}>
      {(title || actions) && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-label">{hint}</div>}
    </div>
  );
}

/** Champ de formulaire accessible : libellé, aide et erreur reliés au contrôle. */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': describedBy })}
      {hint && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="error" id={`${id}-error`} role="alert">{error}</span>}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError || error instanceof Error ? error.message : 'Une erreur est survenue.';
  return <div className="banner banner-error" role="alert">{message}</div>;
}

export function Loading() {
  return <div aria-busy="true" className="empty">Chargement…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export interface Column<T> { header: string; cell: (row: T) => ReactNode }

export function Table<T>({ caption, columns, rows, rowKey, empty }: { caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty: string }) {
  if (rows.length === 0) return <div className="card"><Empty>{empty}</Empty></div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{columns.map((c) => <th key={c.header} scope="col">{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>{columns.map((c) => <td key={c.header}>{c.cell(r)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Étapes d'un processus : faites, en cours, à venir. */
export function Steps({ steps, current, labels }: { steps: string[]; current: string; labels: Record<string, string> }) {
  const index = steps.indexOf(current);
  return (
    <ol className="steps" aria-label="Avancement">
      {steps.map((s, i) => (
        <li key={s} data-state={i < index ? 'done' : i === index ? 'current' : 'todo'} aria-current={i === index ? 'step' : undefined}>
          {labels[s] ?? s}
        </li>
      ))}
    </ol>
  );
}
