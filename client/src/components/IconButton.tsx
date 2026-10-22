import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The accessible name. Icon-only controls need one; there is no exception. */
  label: string;
  /** A hover tooltip, distinct from the label when it helps. Defaults to label. */
  tip?: string;
  children: ReactNode;
}

/**
 * A button whose visible surface is an icon.
 *
 * Two requirements from the UI direction that this one component owns for the
 * whole header: every icon-only control carries an accessible name, and hover
 * and focus get the same visual treatment so keyboard users see their position.
 * The tooltip is title-attr - enough to identify, too weak to be the only way
 * anyone learns what the button is, which is exactly why `label` exists.
 */
export default function IconButton({ label, tip, children, className = '', ...props }: IconButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button ref={ref} type="button" className={`icon-btn ${className}`} aria-label={label} title={tip ?? label} {...props}>
      {children}
    </button>
  );
}
