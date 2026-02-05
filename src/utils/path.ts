import path from 'path';
import fs from 'fs';

/**
 * Sanitizes a "directory path" value (relative path).
 * - normalizes to NFD
 * - strips diacritics
 * - keeps only [a-zA-Z0-9._-] in segments
 * - prevents empty segments, ".", "..", and leading dots
 * - joins segments with forward slashes
 */
export function sanitizePathDir(input: string): string {
  const raw = (input ?? '').toString().normalize('NFD').trim().replace(/\\/g, '/');
  if (!raw) return '';

  const parts = raw.split('/').map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];

  for (const part of parts) {
    let s = part.normalize('NFD');
    s = s.replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/\s+/g, '-');
    s = s.replace(/[^a-zA-Z0-9._-]/g, '');
    s = s.replace(/-+/g, '-');
    s = s.replace(/^[.\-]+/, '');
    s = s.replace(/-+$/, '');

    if (!s || s === '.' || s === '..') continue;
    if (s.length > 128) s = s.slice(0, 128);
    out.push(s);
  }

  const joined = out.join('/');
  return joined.length > 512 ? joined.slice(0, 512) : joined;
}

/**
 * Sanitize an Admin (Media Library) folder name.
 * Rules:
 * - NFD normalize
 * - remove diacritics
 * - allow only: a-zA-Z0-9, space, underscore, hyphen
 * - collapse multiple spaces
 * - trim
 */
export function sanitizeAdminFolderName(input: string): string {
  let s = (input ?? '').toString().normalize('NFD');
  s = s.replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^a-zA-Z0-9 _-]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 128) s = s.slice(0, 128).trim();
  return s;
}

/**
 * Sanitize an Admin (Media Library) folder path like "a/b/c".
 */
export function sanitizeAdminFolderPath(input: string): string {
  const raw = (input ?? '').toString().trim().replace(/\\/g, '/');
  if (!raw) return '';

  const parts = raw.split('/').map((p) => sanitizeAdminFolderName(p)).filter(Boolean);
  return parts.join('/');
}

export function normalizeRelativeSlashPath(v: unknown): string {
  return (typeof v === 'string' ? v : '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function safeResolveUnderRoot(root: string, rel: string): string | null {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs === rootAbs) return null;
  if (!abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

/**
 * Best-effort cleanup of empty directories under `root`.
 * Attempts to remove parents of `absFilePath` until it reaches `root` or finds a non-empty dir.
 */
export async function cleanupEmptyDirs(absFilePath: string, root: string): Promise<void> {
  const rootAbs = path.resolve(root);
  let current = path.dirname(absFilePath);

  while (current.startsWith(rootAbs + path.sep) && current !== rootAbs) {
    try {
      const entries = await fs.promises.readdir(current);
      if (entries.length > 0) return;
      await fs.promises.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

