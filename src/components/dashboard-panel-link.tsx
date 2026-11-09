"use client";
import { Icon } from "./icons";
import {
  DEFAULT_LINK_LABEL,
  linkDestination,
  type PanelLink,
} from "@/lib/panel-link";

/**
 * A panel's link button (REV-66). It opens the address in a new tab with no referrer;
 * while its panel is being moved or resized it shows but does not open.
 */
export function PanelLinkButton({
  link,
  floating,
  inactive,
}: {
  link?: PanelLink | null;
  /** Over an untitled image instead of in a title row. */
  floating?: boolean;
  inactive?: boolean;
}) {
  if (!link) return null;
  const label = link.label?.trim() || DEFAULT_LINK_LABEL;
  return (
    <a
      className={`pn-go ${floating ? "pn-go-float" : ""}`}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} · ${linkDestination(link.url)}`}
      aria-label={`${label} (opens in a new tab)`}
      aria-disabled={inactive || undefined}
      tabIndex={inactive ? -1 : undefined}
      onClick={inactive ? (event) => event.preventDefault() : undefined}
    >
      <Icon name="external" size={13} />
      <span className="pn-go-text">{label}</span>
    </a>
  );
}
