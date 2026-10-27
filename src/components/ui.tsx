"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { message } from "@/lib/api";

/**
 * Small popover menu (⋯ actions, preset switcher). With `flip`, it opens
 * upward when the nearest scrolling container has no room below.
 */
export function Menu({
  label,
  className = "btn",
  content,
  children,
  align = "right",
  style,
  flip,
}: {
  label: string;
  className?: string;
  content: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  style?: CSSProperties;
  flip?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const pop = root.current?.querySelector<HTMLElement>(".menu-pop");
    if (!open || !flip || !pop) return;
    let limit = { top: 0, bottom: window.innerHeight };
    for (let node = root.current?.parentElement; node;) {
      if (getComputedStyle(node).overflowY !== "visible") {
        const box = node.getBoundingClientRect();
        limit = {
          top: Math.max(0, box.top),
          bottom: Math.min(window.innerHeight, box.bottom),
        };
        break;
      }
      node = node.parentElement;
    }
    const menu = pop.getBoundingClientRect();
    const anchor = root.current!.getBoundingClientRect();
    if (menu.bottom > limit.bottom && anchor.top - menu.height - 6 >= limit.top)
      setUp(true);
  }, [open, flip]);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    root.current
      ?.querySelector<HTMLElement>(
        ".menu-pop input, .menu-pop [role=menuitem], .menu-pop [role=menuitemradio]",
      )
      ?.focus();
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="menu-root" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={className}
        style={style}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          setUp(false);
          setOpen((value) => !value);
        }}
      >
        {content}
      </button>
      {open && (
        <div
          className={`menu-pop menu-${align} ${up ? "menu-up" : ""}`}
          role="menu"
          aria-label={label}
        >
          {children(() => {
            trigger.current?.focus();
            setOpen(false);
          })}
        </div>
      )}
    </div>
  );
}

export function ErrorNotice({ error, id }: { error?: unknown; id?: string }) {
  return error ? (
    <div id={id} role="alert" className="notice error">
      {message(error)}
    </div>
  ) : null;
}
export function CommandFeedback({
  command,
}: {
  command: { error?: unknown; uncertain: boolean; busy: boolean };
}) {
  return (
    <>
      <ErrorNotice error={command.error} />
      {command.uncertain && (
        <p className="notice" role="status">
          The outcome is uncertain. Retry repeats the original command and
          values. Your draft remains in this tab.
        </p>
      )}
      {command.busy && <p role="status">Saving…</p>}
    </>
  );
}
