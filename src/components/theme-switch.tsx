"use client";
import { useEffect, useState } from "react";
import { Icon } from "./icons";

/** The remembered light/dark appearance (`keep-theme`, `data-theme` on <html>). */
export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    );
  }, []);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem("keep-theme", next);
    } catch {
      // The theme still changes for this page when browser storage is blocked.
    }
  }
  return [theme, toggleTheme] as const;
}

export function ThemeSwitch({
  theme,
  onToggle,
}: {
  theme: "light" | "dark";
  onToggle: () => void;
}) {
  const dark = theme === "dark";
  return (
    <div className="theme-switcher">
      <span className="theme-switcher-label">Appearance</span>
      <button
        type="button"
        className="theme-switch"
        role="switch"
        aria-label="Dark mode"
        aria-checked={dark}
        onClick={onToggle}
      >
        <span className="theme-switch-track" aria-hidden="true">
          <span className="theme-switch-light">
            <Icon name="sun" size={14} />
          </span>
          <span className="theme-switch-dark">
            <Icon name="moon" size={14} />
          </span>
          <span className={`theme-switch-thumb${dark ? " is-dark" : ""}`}>
            <Icon name={dark ? "moon" : "sun"} size={13} />
          </span>
        </span>
      </button>
    </div>
  );
}
