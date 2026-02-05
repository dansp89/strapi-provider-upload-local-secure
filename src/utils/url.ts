import { getStringOrUndefined } from './strings';

export type ExtractObjectPathOptions = {
  /**
   * Marker inside pathname (e.g. "/uploads/") used to extract the objectPath.
   * Default: "/uploads/"
   */
  marker?: string;
  /**
   * If provided, and the raw url starts with baseUrl, we will strip it and treat the remainder as objectPath.
   * Useful when `file.url` is generated as `${baseUrl}/${objectPath}` without a "/uploads/" marker.
   */
  baseUrl?: string;
};

export function extractObjectPathFromUrl(url: unknown, opts: ExtractObjectPathOptions = {}): string | null {
  const raw = getStringOrUndefined(url);
  if (!raw) return null;

  const marker = opts.marker ?? '/uploads/';

  let pathname = raw;
  try {
    if (/^\w+:\/\//.test(raw)) {
      pathname = new URL(raw).pathname;
    } else {
      pathname = raw.split('?')[0];
    }
  } catch {
    pathname = raw.split('?')[0];
  }

  // 1) Preferred: marker extraction
  const idx = pathname.indexOf(marker);
  if (idx !== -1) {
    const objectPath = pathname.slice(idx + marker.length).replace(/^\/+/, '');
    if (!objectPath) return null;
    try {
      return decodeURIComponent(objectPath);
    } catch {
      return objectPath;
    }
  }

  // 2) Fallback: strip baseUrl prefix (if the full url was built as baseUrl + objectPath)
  const baseUrl = getStringOrUndefined(opts.baseUrl);
  if (baseUrl && raw.startsWith(baseUrl)) {
    const remainder = raw.slice(baseUrl.length).replace(/^\/+/, '').split('?')[0];
    if (!remainder) return null;
    try {
      return decodeURIComponent(remainder);
    } catch {
      return remainder;
    }
  }

  return null;
}

