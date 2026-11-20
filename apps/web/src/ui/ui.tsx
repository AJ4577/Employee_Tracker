import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { STATUS_LABEL, type VisitStatus, type Freshness } from "@kisanroute/shared";

export function Button({ variant = "primary", busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant} ${rest.className ?? ""}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

interface FieldProps {
  label: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
}

export function Field({ label, error, hint, required, children }: FieldProps & { children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const descId = error || hint ? `${id}-desc` : undefined;
  return (
    <div className={`field ${error ? "field-error" : ""}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden> *</span> : null}
      </label>
      {children(id, descId)}
      {error ? (
        <p id={descId} className="field-msg" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ label, error, hint, required, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} error={error} hint={hint} required={required}>
      {(id, d) => <input id={id} aria-describedby={d} aria-invalid={!!error || undefined} required={required} {...rest} />}
    </Field>
  );
}

export function TextArea({ label, error, hint, required, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} error={error} hint={hint} required={required}>
      {(id, d) => <textarea id={id} aria-describedby={d} aria-invalid={!!error || undefined} required={required} rows={3} {...rest} />}
    </Field>
  );
}

export function Select({ label, error, hint, required, children, ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} error={error} hint={hint} required={required}>
      {(id, d) => (
        <select id={id} aria-describedby={d} aria-invalid={!!error || undefined} required={required} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function StatusBadge({ status }: { status: VisitStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

const FRESH_TEXT: Record<Freshness, string> = { live: "Live", stale: "Stale", last_known: "Last known", unavailable: "Location unavailable" };
export function FreshnessBadge({ f }: { f: Freshness }) {
  return (
    <span className={`badge fresh-${f}`}>
      <span aria-hidden className="dot" />
      {FRESH_TEXT[f]}
    </span>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = (error as Error)?.message ?? "Something went wrong.";
  return (
    <div className="state state-error" role="alert">
      <p>{msg}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children}
    </div>
  );
}

export function Modal({ title, open, onClose, children, footer, wide }: { title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} onClose={onClose} onCancel={onClose} aria-labelledby="modal-title">
      {open ? (
        <>
          <header className="modal-head">
            <h2 id="modal-title">{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer ? <footer className="modal-foot">{footer}</footer> : null}
        </>
      ) : null}
    </dialog>
  );
}

export function Banner({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="muted">{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" | "ok" | "danger" }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Pager({ page, hasMore, onPage }: { page: number; hasMore: boolean; onPage: (p: number) => void }) {
  if (page === 0 && !hasMore) return null;
  return (
    <nav className="pager" aria-label="Pagination">
      <Button variant="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>
        ← Previous
      </Button>
      <span className="muted">Page {page + 1}</span>
      <Button variant="secondary" disabled={!hasMore} onClick={() => onPage(page + 1)}>
        Next →
      </Button>
    </nav>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
