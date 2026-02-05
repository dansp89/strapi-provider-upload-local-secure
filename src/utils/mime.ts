import { getStringOrUndefined } from './strings';

export function normalizeExt(ext: unknown): string | null {
  const raw = getStringOrUndefined(ext);
  if (!raw) return null;
  return raw.startsWith('.') ? raw : `.${raw}`;
}

export function extFromMime(mime: unknown): string | null {
  const m = getStringOrUndefined(mime)?.toLowerCase();
  if (!m) return null;
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/svg+xml') return '.svg';
  if (m === 'application/pdf') return '.pdf';
  return null;
}

