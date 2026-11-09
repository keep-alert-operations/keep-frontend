/** Panel links: a button on any panel that opens an address in a new tab (REV-66). */
export interface PanelLink {
  url: string;
  label?: string | null;
}

export const MAX_LINK_ADDRESS = 2048;
export const MAX_LINK_LABEL = 40;
export const DEFAULT_LINK_LABEL = "Open link";

/** Why an address can't be a panel link, or "" when it can; mirrors the API. */
export function linkProblem(value: string) {
  const address = value.trim();
  if (!address) return "";
  if (address.length > MAX_LINK_ADDRESS)
    return `Keep the link under ${MAX_LINK_ADDRESS.toLocaleString()} characters.`;
  if (/[\s\u0000-\u001f\u007f]/.test(address) || /[^\x20-\x7e]/.test(address))
    return "Remove spaces and special characters from the link.";
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return "Enter a full address that starts with https:// or http://.";
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !/^https?:\/\/[^/?#]/i.test(address)
  )
    return "Enter a full address that starts with https:// or http://.";
  if (parsed.username || parsed.password)
    return "Remove the user name and password from the link.";
  return "";
}

/** Why button text can't be used, or "" when it can. */
export function labelProblem(value: string) {
  const label = value.trim().normalize("NFC");
  if (
    [...label].length > MAX_LINK_LABEL ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(label)
  )
    return `Use single-line button text of up to ${MAX_LINK_LABEL} characters.`;
  return "";
}

/** The stored link for typed fields: none without an address, blank text as null. */
export function panelLink(url: string, label: string): PanelLink | null {
  const address = url.trim();
  if (!address) return null;
  return { url: address, label: label.trim().normalize("NFC") || null };
}

/** The host and path shown on hover, without the scheme. */
export function linkDestination(url: string) {
  return url.replace(/^https?:\/\//i, "");
}
