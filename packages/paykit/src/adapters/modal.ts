import type { ButtonTheme } from "./types";

/**
 * A dependency-free modal, in plain DOM.
 *
 * Stripe needs somewhere to mount the Payment Element, and the core of this
 * library is framework-agnostic on purpose — so this is document API only, no
 * React. The React layer never sees it.
 */

const STYLE_ID = "paykit-modal-styles";

const CSS = `
.paykit-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;
  justify-content:center;padding:16px;background:rgba(17,17,20,.55);
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);
  opacity:0;transition:opacity .16s ease}
.paykit-overlay[data-open="true"]{opacity:1}
.paykit-panel{width:100%;max-width:420px;max-height:calc(100dvh - 32px);overflow-y:auto;
  border-radius:14px;padding:20px;box-sizing:border-box;
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  box-shadow:0 20px 60px rgba(0,0,0,.28);transform:translateY(6px) scale(.99);
  transition:transform .16s ease}
.paykit-overlay[data-open="true"] .paykit-panel{transform:none}
.paykit-panel[data-theme="light"]{background:#fff;color:#1a1a1e}
.paykit-panel[data-theme="dark"]{background:#1c1c20;color:#f2f2f4}
.paykit-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}
.paykit-title{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.paykit-amount{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.paykit-slot{min-height:40px;margin-bottom:14px}
.paykit-error{margin:0 0 12px;font-size:13px;color:#c8372d}
.paykit-panel[data-theme="dark"] .paykit-error{color:#ff8b80}
.paykit-actions{display:flex;flex-direction:column;gap:8px}
.paykit-submit{width:100%;padding:11px 16px;border:0;border-radius:8px;cursor:pointer;
  font:inherit;font-weight:600;background:#4f46e5;color:#fff;transition:opacity .12s ease}
.paykit-submit:hover:not(:disabled){opacity:.9}
.paykit-submit:disabled{opacity:.5;cursor:default}
.paykit-cancel{width:100%;padding:8px;border:0;border-radius:8px;cursor:pointer;
  font:inherit;font-size:13px;background:transparent;color:inherit;opacity:.7}
.paykit-cancel:hover:not(:disabled){opacity:1}
.paykit-cancel:disabled{opacity:.35;cursor:default}
@media (prefers-reduced-motion:reduce){
  .paykit-overlay,.paykit-panel{transition:none}
}
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

export type Modal = {
  /** Where the provider mounts its own UI. */
  slot: HTMLElement;
  setError: (message: string | null) => void;
  setBusy: (busy: boolean) => void;
  setSubmitLabel: (label: string) => void;
  onSubmit: (cb: () => void) => void;
  /** Escape, backdrop click, or the cancel button. */
  onDismiss: (cb: () => void) => void;
  close: () => void;
};

export type ModalOptions = {
  title: string;
  amountLabel: string;
  submitLabel: string;
  cancelLabel?: string;
  theme: ButtonTheme;
};

export function openModal(options: ModalOptions): Modal {
  if (typeof document === "undefined") {
    throw new Error("paykit: openModal requires a browser document");
  }
  const doc = document;
  ensureStyles(doc);

  const overlay = doc.createElement("div");
  overlay.className = "paykit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", options.title);

  const panel = doc.createElement("div");
  panel.className = "paykit-panel";
  panel.dataset.theme = options.theme;

  const head = doc.createElement("div");
  head.className = "paykit-head";
  const title = doc.createElement("h2");
  title.className = "paykit-title";
  title.textContent = options.title;
  const amount = doc.createElement("span");
  amount.className = "paykit-amount";
  amount.textContent = options.amountLabel;
  head.append(title, amount);

  const slot = doc.createElement("div");
  slot.className = "paykit-slot";

  const error = doc.createElement("p");
  error.className = "paykit-error";
  error.hidden = true;
  error.setAttribute("role", "alert");

  const actions = doc.createElement("div");
  actions.className = "paykit-actions";
  const submit = doc.createElement("button");
  submit.type = "button";
  submit.className = "paykit-submit";
  submit.textContent = options.submitLabel;
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "paykit-cancel";
  cancel.textContent = options.cancelLabel ?? "Cancel";
  actions.append(submit, cancel);

  panel.append(head, slot, error, actions);
  overlay.append(panel);
  doc.body.appendChild(overlay);

  // Let the first frame paint the closed state so the transition runs.
  requestAnimationFrame(() => {
    overlay.dataset.open = "true";
  });

  const previouslyFocused = doc.activeElement as HTMLElement | null;
  const previousOverflow = doc.body.style.overflow;
  doc.body.style.overflow = "hidden";

  let busy = false;
  let closed = false;
  let submitCb: (() => void) | null = null;
  let dismissCb: (() => void) | null = null;

  const dismiss = () => {
    if (busy || closed) return;
    dismissCb?.();
  };

  submit.addEventListener("click", () => {
    if (busy || closed) return;
    submitCb?.();
  });
  cancel.addEventListener("click", dismiss);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) dismiss();
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    // Minimal focus trap: keep Tab inside the panel while it is open.
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select,textarea,iframe,[tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  doc.addEventListener("keydown", onKeyDown, true);

  return {
    slot,
    setError(message) {
      error.textContent = message ?? "";
      error.hidden = message == null;
    },
    setBusy(next) {
      busy = next;
      submit.disabled = next;
      cancel.disabled = next;
      submit.setAttribute("aria-busy", String(next));
    },
    setSubmitLabel(label) {
      submit.textContent = label;
    },
    onSubmit(cb) {
      submitCb = cb;
    },
    onDismiss(cb) {
      dismissCb = cb;
    },
    close() {
      if (closed) return;
      closed = true;
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.body.style.overflow = previousOverflow;
      overlay.dataset.open = "false";
      const remove = () => overlay.remove();
      // Match the CSS transition, but never leak the node if it never fires.
      overlay.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 250);
      previouslyFocused?.focus?.();
    },
  };
}
