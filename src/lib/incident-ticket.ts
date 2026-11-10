/**
 * ServiceNow tickets on incidents (REV-70; incident operations 15).
 *
 * Keep never calls ServiceNow. The browser checks a pasted link or number
 * against the deployment's ServiceNow address as the user types, builds the
 * address of a ticket from its bare number, and builds ServiceNow's prefilled
 * new incident form. The Product API repeats every link check on save.
 */

import type { components } from "./generated";

/** Whether ServiceNow tickets are on, and the address links must use. */
export type ServiceNowStatus = components["schemas"]["ServiceNowStatus"];

/** A ticket number: letters then digits, upper-cased before saving. */
export const TICKET_NUMBER = /^[A-Za-z]{2,8}[0-9]{4,12}$/;
/** Longest link the Product API accepts. */
export const TICKET_LINK_MAX = 2048;
/** Longest "Ticket Title" (ServiceNow short description) the dialog offers. */
export const TICKET_TITLE_MAX = 160;
/** Longest new incident form address the dialog opens. */
export const NEW_FORM_URL_MAX = 4000;

export const TICKET_NUMBER_HELP =
  "Ticket numbers are letters followed by digits, like INC0041235.";

export const servicenowStatusPath = (tenantPath: string) =>
  `${tenantPath}/servicenow/status`;

/** The configured ServiceNow address, or null when it is unusable. */
export function serviceNowBase(base: string | null | undefined): URL | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

/** The base address without a trailing slash, for appending paths. */
function root(base: URL) {
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
}

/** The ticket address Keep stores for a bare number. */
export function ticketNumberUrl(base: URL, number: string) {
  return `${root(base)}/nav_to.do?uri=task.do%3Fsysparm_query%3Dnumber%3D${number.toUpperCase()}`;
}

/** The ticket number carried by a link (`number=INC…`), if any. */
export function numberFromLink(link: string): string | null {
  let text = link;
  // ServiceNow links often nest an encoded address inside another.
  for (let pass = 0; pass < 3; pass += 1) {
    const match =
      /(?:^|[^A-Za-z0-9_])number=([A-Za-z]{2,8}[0-9]{4,12})(?![A-Za-z0-9])/.exec(
        text,
      );
    if (match) return match[1].toUpperCase();
    let decoded: string;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      return null;
    }
    if (decoded === text) return null;
    text = decoded;
  }
  return null;
}

export type TicketCheck =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | {
      kind: "ok";
      url: string;
      number: string | null;
      fromNumber: boolean;
    };

/** Checks "Ticket link or number" against the configured ServiceNow. */
export function checkTicketInput(raw: string, base: URL | null): TicketCheck {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (!base)
    return {
      kind: "error",
      message: "ServiceNow isn't set up in Keep, so tickets can't be linked.",
    };
  if (TICKET_NUMBER.test(text)) {
    const number = text.toUpperCase();
    return {
      kind: "ok",
      url: ticketNumberUrl(base, number),
      number,
      fromNumber: true,
    };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      kind: "error",
      message: `Paste a ServiceNow link that starts with ${base.protocol}//, or a ticket number like INC0041235.`,
    };
  }
  if (url.username || url.password)
    return {
      kind: "error",
      message: "Remove the user name and password from the link.",
    };
  if (url.protocol !== base.protocol)
    return {
      kind: "error",
      message: `The link must start with ${base.protocol}//.`,
    };
  if (url.host !== base.host)
    return {
      kind: "error",
      message: `${url.host} isn’t the ServiceNow Keep uses. Only links to ${base.host} can be saved.`,
    };
  if (/[\s\u0000-\u001f\u007f]/.test(text))
    return { kind: "error", message: "Remove the spaces from the link." };
  if (text.length > TICKET_LINK_MAX)
    return {
      kind: "error",
      message: "The link is longer than 2,048 characters.",
    };
  const basePath = base.pathname.replace(/\/+$/, "");
  if (
    basePath &&
    url.pathname !== basePath &&
    !url.pathname.startsWith(`${basePath}/`)
  )
    return {
      kind: "error",
      message: `The link must be under ${root(base)}.`,
    };
  return {
    kind: "ok",
    url: text,
    number: numberFromLink(text),
    fromNumber: false,
  };
}

/** Checks the optional "Ticket number" field; null means it is invalid. */
export function checkTicketNumber(
  raw: string,
): { ok: true; number: string | null } | { ok: false } {
  const text = raw.trim();
  if (!text) return { ok: true, number: null };
  return TICKET_NUMBER.test(text)
    ? { ok: true, number: text.toUpperCase() }
    : { ok: false };
}

/** Escapes a `sysparm_query` value: ServiceNow joins terms with `^`. */
export function escapeQueryValue(value: string) {
  return value.replaceAll("^", "^^");
}

/** The lines that follow the incident description in a new ticket. */
export function ticketDescriptionSuffix(severity: string, incidentUrl: string) {
  return `\n\nSeverity: ${severity}\nKeep incident: ${incidentUrl}`;
}

function formUrl(base: URL, title: string, description: string) {
  return `${root(base)}/incident.do?sys_id=-1&sysparm_query=${encodeURIComponent(
    `short_description=${escapeQueryValue(title)}^description=${escapeQueryValue(description)}`,
  )}`;
}

/** Drops unpaired surrogates so encodeURIComponent never throws. */
function wellFormed(value: string) {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

/**
 * ServiceNow's new incident form with Ticket Title and Description filled in.
 * When the address would pass NEW_FORM_URL_MAX characters, the description is
 * shortened (ending with "…") before `keep`, the severity and link lines, when
 * the description still ends with them.
 */
export function newIncidentFormUrl(
  base: URL,
  title: string,
  description: string,
  keep = "",
): string {
  const safeTitle = wellFormed(title);
  const safeDescription = wellFormed(description);
  const full = formUrl(base, safeTitle, safeDescription);
  if (full.length <= NEW_FORM_URL_MAX) return full;
  const kept = keep && safeDescription.endsWith(keep) ? keep : "";
  const head = Array.from(
    kept ? safeDescription.slice(0, -kept.length) : safeDescription,
  );
  const shortened = (count: number) =>
    formUrl(
      base,
      safeTitle,
      `${head.slice(0, count).join("").trimEnd()}…${kept}`,
    );
  // Longest head (in code points) whose address still fits.
  let low = 0,
    high = head.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (shortened(middle).length <= NEW_FORM_URL_MAX) low = middle;
    else high = middle - 1;
  }
  const result = shortened(low);
  if (result.length <= NEW_FORM_URL_MAX || !kept) return result;
  // Even the kept lines do not fit: shorten the whole description instead.
  return newIncidentFormUrl(base, safeTitle, safeDescription);
}

/** A ticket's label: its number, or "ServiceNow ticket" when none is known. */
export function ticketLabel(number: unknown) {
  return typeof number === "string" && number ? number : "ServiceNow ticket";
}

/** True for addresses that can be opened as a link (http or https). */
export function openableUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Activity wording for a `ticket` record: linked (no previous link), unlinked
 * (no link) or changed. A side without a number reads "ServiceNow ticket".
 */
export function describeTicketActivity(
  evidence: Record<string, unknown> | undefined,
): { what: string; from?: string; to?: string } {
  const number = typeof evidence?.number === "string" ? evidence.number : "";
  const previous =
    typeof evidence?.previous_number === "string"
      ? evidence.previous_number
      : "";
  if (!evidence?.previous_url)
    return { what: "ServiceNow ticket linked", to: number || undefined };
  if (!evidence?.url)
    return { what: "ServiceNow ticket unlinked", from: previous || undefined };
  return {
    what: "ServiceNow ticket changed",
    from: ticketLabel(previous),
    to: ticketLabel(number),
  };
}
