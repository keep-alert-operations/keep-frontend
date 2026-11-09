import { ApiError, tenantPath } from "./api";

/**
 * Image panels (REV-62). The server is the authority on uploads: it reads each file's
 * own header and rejects anything else. These checks only answer early in the dialog.
 */
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_ADDRESS = 2048;
export const MAX_IMAGE_DESCRIPTION = 300;

export interface UploadedImage {
  id: string;
  media_type: string;
  width: string;
  height: string;
  byte_size: string;
}

/** Why a chosen file cannot be uploaded, before sending it; empty when it may be. */
export function fileProblem(file: File) {
  if (!IMAGE_TYPES.includes(file.type))
    return `${file.name} can't be used. Choose a PNG, JPEG, GIF or WebP file up to 5 MB.`;
  if (file.size > MAX_IMAGE_BYTES)
    return `${file.name} is larger than 5 MB. Choose a smaller file.`;
  return "";
}

/** Why an image address cannot be saved; empty when it may be. */
export function addressProblem(value: string) {
  const address = value.trim();
  if (!address) return "Enter the image's address.";
  if (address.length > MAX_IMAGE_ADDRESS)
    return `Keep the address under ${MAX_IMAGE_ADDRESS.toLocaleString()} characters.`;
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return "Enter an address that starts with https://.";
  }
  if (parsed.protocol !== "https:" || !/^https:\/\/[^/]/i.test(address))
    return "Enter an address that starts with https://.";
  if (parsed.username || parsed.password)
    return "Remove the user name and password from the address.";
  if (/[\s\u0000-\u001f\u007f]/.test(address) || /[^\x20-\x7e]/.test(address))
    return "Remove spaces and special characters from the address.";
  return "";
}

/** Upload one file for image panels; the same bytes return the existing image. */
export async function uploadPanelImage(
  tenantId: string,
  csrf: string,
  file: Blob,
  signal?: AbortSignal,
): Promise<UploadedImage> {
  const response = await fetch(`${tenantPath(tenantId)}/dashboard-images`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": file.type,
      "Idempotency-Key": crypto.randomUUID(),
      "X-CSRF-Token": csrf,
    },
    body: file,
  });
  let payload: {
    data?: UploadedImage;
    error?: { code?: string; message?: string; request_id?: string };
  } | null = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "invalid_response",
      "The service returned an unreadable response. Check the API connection.",
    );
  }
  if (!response.ok || !payload?.data?.id)
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "request_failed",
      payload?.error?.message ?? "The image could not be uploaded.",
      payload?.error?.request_id,
    );
  return payload.data;
}

/** A readable file size, such as "412 KB". */
export function fileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
