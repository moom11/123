import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Small shared UI primitives, kept deliberately plain and touch-friendly. */

export function Modal({
  title, onClose, children, footer, wide = false,
}: {
  title: ReactNode; onClose: () => void; children: ReactNode;
  footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className={`modal${wide ? ' wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true"
      >
        <div className="modal-header">
          <span>{title}</span>
          <button className="btn ghost sm spacer" onClick={onClose} aria-label="إغلاق">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon = '📭', text }: { icon?: string; text: string }) {
  return <div className="empty"><span className="icon">{icon}</span>{text}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row center" style={{ justifyContent: 'center', padding: 24 }}>
      <span className="spinner" />
      {label && <span className="muted" style={{ marginInlineStart: 10 }}>{label}</span>}
    </div>
  );
}

export function Stat({
  label, value, sub, tone,
}: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'alert' | 'warn' }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

// --- Toasts ------------------------------------------------------------------

type ToastKind = 'ok' | 'error' | 'warn' | 'info';
interface Toast { id: number; kind: ToastKind; text: string }

const ToastContext = createContext<{
  push: (text: string, kind?: ToastKind) => void;
}>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    // Errors linger a little longer; a busy cashier may not be looking.
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === 'error' ? 6000 : 3500,
    );
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() { return useContext(ToastContext); }

/** Confirm dialog that also collects a mandatory reason where one is required. */
export function ConfirmReason({
  title, message, confirmLabel = 'تأكيد', requireReason = true,
  onConfirm, onCancel, danger = false,
}: {
  title: string; message?: string; confirmLabel?: string; requireReason?: boolean;
  onConfirm: (reason: string) => void | Promise<void>; onCancel: () => void;
  danger?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (requireReason && !reason.trim()) return;
    setBusy(true);
    try { await onConfirm(reason.trim()); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={title} onClose={onCancel}
      footer={
        <>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            disabled={busy || (requireReason && !reason.trim())}
            onClick={submit}
          >
            {busy ? '...' : confirmLabel}
          </button>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>إلغاء</button>
        </>
      }
    >
      {message && <p className="muted">{message}</p>}
      {requireReason && (
        <div className="field">
          <label className="label">السبب (إلزامي)</label>
          <textarea
            className="textarea" value={reason} autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="اكتب سبب هذه العملية..."
          />
          <div className="small faint">يُسجَّل السبب في سجل العمليات مع اسمك ووقت التنفيذ.</div>
        </div>
      )}
    </Modal>
  );
}
