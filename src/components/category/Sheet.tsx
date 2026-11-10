"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Modal shell for the category screens. A native <dialog> gives focus
 * trapping, Escape-to-close, focus restoration and the top layer (so a
 * table's overflow can never clip it) — same approach as the More drawer.
 * Centred card on desktop, bottom sheet on phones (see .cat-sheet CSS).
 *
 * Controlled: `open` is the truth. `onClose` fires only for a close the
 * USER started (Escape, backdrop click) — never echoes a close the parent
 * asked for, so a parent's "closed with this message" isn't overwritten.
 */
export default function Sheet({ open, onClose, labelledBy, wide, children }: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const wantOpen = useRef(open);

  useEffect(() => {
    wantOpen.current = open;
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`cat-sheet${wide ? " cat-sheet-wide" : ""}`}
      aria-labelledby={labelledBy}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      // Some browsers force-close on a repeated Escape despite preventDefault.
      onClose={() => { if (wantOpen.current) onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      {open && <div className="cat-sheet-body">{children}</div>}
    </dialog>
  );
}
