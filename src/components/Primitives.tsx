import { ShoppingBag, X } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={close}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon" aria-label="Close dialog" onClick={close}>
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label: caption,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="field">
      {caption}
      <input {...props} />
    </label>
  );
}
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <ShoppingBag size={38} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
