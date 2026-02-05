import { pipeline } from 'stream';
import crypto from 'crypto';
import fs, { ReadStream } from 'fs';
import path from 'path';
import fse from 'fs-extra';
import * as utils from '@strapi/utils';
import {
  cleanupEmptyDirs,
  sanitizeAdminFolderPath,
  normalizeRelativeSlashPath,
  safeResolveUnderRoot,
  sanitizePathDir,
} from './utils/path';
import { escapeRegexLiteral, getStringOrUndefined } from './utils/strings';
import { extFromMime, normalizeExt } from './utils/mime';
import { extractObjectPathFromUrl } from './utils/url';

// Needed to load global.strapi without having to put @strapi/types in the regular dependencies
import type {} from '@strapi/types';

interface Config {
  sizeLimit?: number;
  baseUrl?: string;
  prefix?: string;
  debug?: boolean;
  /**
   * If true, providing `pathDir` that sanitizes to an empty string will throw instead of falling back.
   */
  strictPathDir?: boolean;
  /**
   * If true, after deleting a file, try to remove empty parent directories under uploads root.
   */
  cleanupEmptyDirs?: boolean;
  /**
   * If true, after deleting a file, try to delete empty Media Library folders (Admin) as well.
   * Safety rules:
   * - only deletes a folder if it has no child folders
   * - only deletes a folder if it has no other files (excluding the file currently being deleted)
   * - then repeats the same check for the parent folder (recursive upwards)
   */
  cleanupEmptyAdminFolders?: boolean;
  /**
   * If true (default), when `pathDir` is not provided, filesystem path will use `path` (admin path) for compatibility.
   */
  usePathAsPathDir?: boolean;
  /**
   * Marker used to extract objectPath from url during delete. Default: "/uploads/".
   */
  uploadsUrlMarker?: string;
  /**
   * If true, saved file name becomes `<uuidv4>_<hash><ext>` (e.g. `a1b2c3d4-..._abc123hash.ext`).
   * Strapi's hash is still used; the UUID is added for a unique, non-guessable filename.
   */
  renameToUuid?: boolean;
  /**
   * If true, enables private folder: files under this path are only accessible when authenticated
   * (Admin: full access; API: only if JWT user's documentId matches path, or valid HMAC URL).
   */
  privateEnable?: boolean;
  /**
   * Name of the private folder in filesystem and Admin (no leading/trailing slashes). Default: "private".
   * URL pattern: /uploads/<privateFolder>/<documentId>/file.ext
   */
  privateFolder?: string;
  /**
   * TTL in seconds for HMAC-signed URLs. Default: 60.
   */
  privateTTL?: number;
  /**
   * Secret for HMAC-signed URLs (required if you want ?token=...&expires=... access).
   */
  privateSecret?: string;
  /**
   * Field on the users-permissions user entity used as documentId for path matching. Default: "id".
   */
  privateUserDocumentIdField?: string;
}

export interface File {
  stream?: ReadStream;
  buffer?: Buffer;
  name?: string;
  alternativeText?: string;
  caption?: string;
  width?: number;
  height?: number;
  formats?: Record<string, unknown>;
  hash: string;
  ext?: string;
  mime?: string;
  size?: number;
  sizeInBytes?: number;
  url?: string;
  previewUrl?: string;
  path?: string;
  folder?: number | null;
  folderPath?: string | null;
  provider?: string;
}

const { PayloadTooLargeError } = utils.errors;
const { kbytesToBytes, bytesToHumanReadable } = utils.file;

const UPLOADS_FOLDER_NAME = 'uploads';

/** Build HMAC signature for private URL (token = base64url(hmac(secret, path + expires))) */
function signPrivateUrl(secret: string, requestPath: string, expiresAt: number): string {
  const payload = `${requestPath}\n${expiresAt}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest();
  return hmac.toString('base64url');
}

/** Verify HMAC token for private URL */
function verifyPrivateUrlToken(secret: string, requestPath: string, expiresAt: number, token: string): boolean {
  if (!secret || !token) return false;
  const expected = signPrivateUrl(secret, requestPath, expiresAt);
  return crypto.timingSafeEqual(Buffer.from(expected, 'base64url'), Buffer.from(token, 'base64url'));
}

/**
 * Removes leading and trailing slashes from a path prefix
 * @param prefix path prefix to normalize
 * @returns normalized prefix string
 */
function normalizePrefix(prefix: string): string {
  prefix = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!prefix) {
    return '';
  }
  return prefix + '/';
}

/**
 * Safely joins path segments with forward slashes
 * @param segments path segments
 * @returns joined path string
 */
function join(...segments: string[]): string {
  let s = '';
  for (let i = 0; i < segments.length - 1; i++) {
    const l = segments[i];
    s += l.endsWith('/') || l === '' ? l : l + '/';
  }
  s += segments[segments.length - 1];
  return s;
}

/**
 * Ensure a media-library (admin) folder exists for a given "path" (e.g. "a/b/c"),
 * and return the id of the leaf folder.
 */
async function ensureUploadFolderFromPath(
  folderPath: string,
  opts?: { user?: { id: string | number } }
): Promise<number> {
  const sanitizedFolderPath = sanitizeAdminFolderPath(folderPath);
  const parts = sanitizedFolderPath.split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Invalid folder path');

  const folderService: any = strapi?.plugin?.('upload')?.service?.('folder');
  if (!folderService?.create) throw new Error('Upload folder service is not available');

  let parent: number | null = null;
  for (const name of parts) {
    const existing = await strapi.db.query('plugin::upload.folder').findOne({
      where: { name, parent },
    });

    if (existing?.id) {
      parent = existing.id;
      continue;
    }

    const created = await folderService.create(
      { name, parent },
      opts?.user ? { user: opts.user } : undefined
    );
    parent = created.id;
  }

  if (!parent) throw new Error('Could not create or resolve folder path');
  return parent;
}

/**
 * Monkey-patch Strapi's upload service to support:
 * - `data.path`: creates/targets a Media Library folder (admin)
 * - `data.pathDir`: filesystem directory path (sanitized NFD) mapped to provider `file.path`
 * - `data.private`: when true and privateEnable, path becomes privateFolder/documentId (pathDir = documentId)
 *
 * Backward compatible: if `pathDir` is not provided, the filesystem path will use `path`.
 */
function patchUploadServiceForPathDirSupport(patchOpts: {
  strictPathDir: boolean;
  usePathAsPathDir: boolean;
  debugLog: (...args: unknown[]) => void;
  privateEnable?: boolean;
  privateFolder?: string;
}) {
  const uploadService: any = strapi?.plugin?.('upload')?.service?.('upload');
  if (!uploadService?.upload || typeof uploadService.upload !== 'function') return;

  if (uploadService.__strapiProviderUploadLocalPathPatched) return;
  uploadService.__strapiProviderUploadLocalPathPatched = true;

  const applyPathMapping = async (data: Record<string, unknown>, uploadOpts?: any) => {
    const isPrivate = patchOpts.privateEnable && (data as any).private === true;
    const pathDirRaw = getStringOrUndefined((data as any).pathDir);
    let adminPath = getStringOrUndefined(data.path);

    if (isPrivate) {
      if (!pathDirRaw || !patchOpts.privateFolder) {
        throw new Error('When data.private is true, pathDir (documentId) is required and privateFolder must be set');
      }
      const privateFolderNorm = patchOpts.privateFolder!.replace(/^\/+|\/+$/g, '').trim() || 'private';
      const documentId = sanitizePathDir(pathDirRaw);
      if (!documentId) {
        throw new Error('When data.private is true, pathDir (documentId) must not sanitize to empty');
      }
      adminPath = `${privateFolderNorm}/${documentId}`;
      (data as any).path = adminPath;
      delete (data as any).pathDir;
      patchOpts.debugLog('[upload-local-path] private path mapped', { adminPath, documentId });
    }

    // If nothing special requested (and not private), keep original behavior
    if (!adminPath && !pathDirRaw && !isPrivate) {
      return { changed: false };
    }

    // 1) Media Library folder (Admin)
    if (adminPath) {
      const folderId = await ensureUploadFolderFromPath(adminPath, { user: uploadOpts?.user });

      // Multi-upload support: fileInfo can be object or array (one per file).
      const fileInfoAny = (data as any).fileInfo;
      if (Array.isArray(fileInfoAny)) {
        (data as any).fileInfo = fileInfoAny.map((fi) => ({ ...(fi ?? {}), folder: folderId }));
      } else {
        const fileInfo = ((data as any).fileInfo ?? {}) as Record<string, unknown>;
        (data as any).fileInfo = { ...fileInfo, folder: folderId };
      }
    }

    // 2) Filesystem path -> metas.path (provider file.path)
    if (!isPrivate) {
      const fsPathSource = pathDirRaw ?? (patchOpts.usePathAsPathDir ? adminPath ?? '' : '');
      const fsPath = fsPathSource ? sanitizePathDir(fsPathSource) : '';

      if (pathDirRaw && patchOpts.strictPathDir && !fsPath) {
        throw new Error('Invalid pathDir (sanitizes to empty)');
      }

      if (fsPath) {
        data.path = fsPath;
      } else {
        delete data.path;
      }

      if ('pathDir' in data) delete (data as any).pathDir;
    }

    patchOpts.debugLog('[upload-local-path] metas mapped', {
      adminPath,
      pathDirRaw,
      fsPath: (data as any).path,
      hasFolder: !!((data as any).fileInfo as any)?.folder,
      fileInfoIsArray: Array.isArray((data as any).fileInfo),
    });

    return { changed: true };
  };

  const originalUpload = uploadService.upload.bind(uploadService);
  uploadService.upload = async (payload: any, uploadOpts?: any) => {
    const data = (payload?.data ?? {}) as Record<string, unknown>;
    const res = await applyPathMapping(data, uploadOpts);
    if (!res.changed) return originalUpload(payload, uploadOpts);
    return originalUpload({ ...payload, data }, uploadOpts);
  };

  // Replace compatibility (Strapi upload service has `replace` in core upload plugin)
  if (typeof uploadService.replace === 'function') {
    const originalReplace = uploadService.replace.bind(uploadService);
    uploadService.replace = async (id: any, payload: any, uploadOpts?: any) => {
      const data = (payload?.data ?? {}) as Record<string, unknown>;
      const res = await applyPathMapping(data, uploadOpts);
      if (!res.changed) return originalReplace(id, payload, uploadOpts);
      return originalReplace(id, { ...payload, data }, uploadOpts);
    };
  }
}

/**
 * Initialize the plugin with configuration
 * @param config Provider configuration
 * @returns Provider object with upload, uploadStream, and delete handlers
 */
export function init(config: Config = {}) {
  // TODO V5: remove providerOptions sizeLimit
  if (config.sizeLimit) {
    process.emitWarning(
      '[deprecated] In future versions, "sizeLimit" argument will be ignored from upload.config.providerOptions. Move it to upload.config'
    );
  }

  // Use default Strapi uploads folder
  const uploadPath = path.resolve(strapi.dirs.static.public, UPLOADS_FOLDER_NAME);
  const prefix = config.prefix ? normalizePrefix(config.prefix) : '';
  const baseUrl = config.baseUrl;
  const strictPathDir = config.strictPathDir === true;
  const cleanupDirs = config.cleanupEmptyDirs === true;
  const cleanupAdminFolders = config.cleanupEmptyAdminFolders === true;
  const usePathAsPathDir = config.usePathAsPathDir !== false;
  const uploadsUrlMarker = config.uploadsUrlMarker ?? `/${UPLOADS_FOLDER_NAME}/`;
  const renameToUuid = config.renameToUuid === true;
  const privateEnable = config.privateEnable === true;
  const privateFolderNorm = privateEnable
    ? (config.privateFolder ?? 'private').replace(/^\/+|\/+$/g, '').trim() || 'private'
    : '';
  const privateTTL = Math.max(1, Math.floor((config.privateTTL ?? 60) as number));
  const privateSecret = config.privateSecret ?? '';
  const privateUserDocumentIdField = config.privateUserDocumentIdField ?? 'id';

  const debugEnabled =
    config.debug === true ||
    process.env.STRAPI_PROVIDER_UPLOAD_LOCAL_PATH_DEBUG === '1' ||
    process.env.STRAPI_PROVIDER_UPLOAD_LOCAL_PATH_DEBUG === 'true';

  const debugLog = (...args: unknown[]) => {
    if (!debugEnabled) return;
    const msg = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
      .join(' ');

    // Prefer Strapi logger when available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logger: any = (global as any).strapi?.log;
    if (logger?.debug) {
      logger.debug(msg);
      return;
    }

    // Fallback for environments without strapi logger
    // eslint-disable-next-line no-console
    console.debug(msg);
  };

  // Enable `data.pathDir` + Admin `data.path` + `data.private` support (once)
  try {
    patchUploadServiceForPathDirSupport({
      strictPathDir,
      usePathAsPathDir,
      debugLog,
      privateEnable,
      privateFolder: privateFolderNorm || undefined,
    });
    debugLog('[upload-local-path] upload service patched (path + pathDir + private)');
  } catch {
    // provider should keep working even if patch fails
    debugLog('[upload-local-path] could not patch upload service');
  }

  // Ensure uploads folder exists
  if (!fse.pathExistsSync(uploadPath)) {
    try {
      fse.ensureDirSync(uploadPath);
    } catch (error) {
      throw new Error(
        `The upload folder (${uploadPath}) doesn't exist or could not be created. Please check permissions.`
      );
    }
  }

  const privateUrlPrefix = `/${UPLOADS_FOLDER_NAME}/${privateFolderNorm}/`;
  if (privateEnable && privateFolderNorm) {
    try {
      const server = (strapi as any).server;
      if (server?.use) {
        server.use(async (ctx: any, next: () => Promise<void>) => {
          if (ctx.method !== 'GET' || !ctx.path.startsWith(privateUrlPrefix)) {
            return next();
          }
          const pathAfterUploads = ctx.path.slice(`/${UPLOADS_FOLDER_NAME}/`.length);
          const objectPath = pathAfterUploads.replace(/^\/+/, '').replace(/\\/g, '/');
          const absPath = safeResolveUnderRoot(uploadPath, objectPath);
          if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            ctx.status = 404;
            return;
          }
          const pathSegments = pathAfterUploads.split('/').filter(Boolean);
          const documentIdInPath = pathSegments[1] ?? '';
          let allowed = false;

          const authHeader = ctx.request.headers?.authorization;
          const bearerToken = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
            ? authHeader.slice(7).trim()
            : '';

          if (bearerToken) {
            try {
              const adminTokenService = (strapi as any).admin?.services?.token;
              if (adminTokenService?.decode) {
                const decoded = adminTokenService.decode(bearerToken);
                if (decoded) {
                  allowed = true;
                  debugLog('[upload-local-path] private access allowed (admin)');
                }
              }
            } catch {
              // not admin token
            }
            if (!allowed) {
              try {
                const jwtService = (strapi as any).plugin?.('users-permissions')?.service?.('jwt');
                if (jwtService?.verify) {
                  const decoded = await jwtService.verify(bearerToken);
                  const userId = decoded?.id ?? decoded?.sub;
                  if (userId != null) {
                    const user = await (strapi as any).db?.query?.('plugin::users-permissions.user')?.findOne({
                      where: { id: userId },
                    });
                    const userDocumentId = user != null ? String((user as any)[privateUserDocumentIdField] ?? user.id) : '';
                    if (userDocumentId && documentIdInPath === userDocumentId) {
                      allowed = true;
                      debugLog('[upload-local-path] private access allowed (user documentId match)');
                    }
                  }
                }
              } catch {
                // invalid user token
              }
            }
          }
          if (!allowed && privateSecret) {
            const token = ctx.request.query?.token;
            const expires = ctx.request.query?.expires;
            const expiresNum = typeof expires === 'string' ? parseInt(expires, 10) : NaN;
            if (token && !Number.isNaN(expiresNum) && expiresNum * 1000 > Date.now() && verifyPrivateUrlToken(privateSecret, ctx.path, expiresNum, token)) {
              allowed = true;
              debugLog('[upload-local-path] private access allowed (HMAC)');
            }
          }
          if (!allowed) {
            ctx.status = 403;
            return;
          }
          ctx.type = path.extname(absPath);
          ctx.body = fs.createReadStream(absPath);
        });
        debugLog('[upload-local-path] private route registered', privateUrlPrefix);
      }
    } catch (err) {
      debugLog('[upload-local-path] could not register private route', err);
    }
  }

  /**
   * Unified upload function for both buffer and stream
   * @param file File object from strapi controller
   * @param customParams action parameters, overridable from config
   */
  const upload = async (
    file: File,
    customParams: Record<string, unknown> = {}
  ) => {
    const rawPath = file.path ?? '';
    const dynamicPath = rawPath ? sanitizePathDir(rawPath) : '';
    if (strictPathDir && file.path && !dynamicPath) {
      throw new Error('Invalid file.path (sanitizes to empty)');
    }
    const filename = renameToUuid
      ? `${crypto.randomUUID()}_${file.hash}${file.ext ?? ''}`
      : `${file.hash}${file.ext ?? ''}`;
    const objectPath = join(prefix, dynamicPath, filename);
    const finalUploadPath = path.join(uploadPath, objectPath);

    try {
      debugLog('[upload-local-path] upload', {
        hash: file.hash,
        ext: file.ext,
        dynamicPath,
        objectPath,
        finalUploadPath,
      });

      // Ensure directory exists
      await fse.ensureDir(path.dirname(finalUploadPath));

      // Handle stream or buffer
      if (file.stream) {
        const writeStream = fs.createWriteStream(finalUploadPath);
        await new Promise<void>((resolve, reject) => {
          pipeline(file.stream!, writeStream, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } else if (file.buffer) {
        await fs.promises.writeFile(finalUploadPath, file.buffer);
      } else {
        throw new Error('File must have either stream or buffer');
      }

      // Generate URL
      if (baseUrl) {
        file.url = join(baseUrl, objectPath);
      } else {
        file.url = `/${UPLOADS_FOLDER_NAME}/${objectPath}`;
      }
      debugLog('[upload-local-path] url', file.url);

    } catch (err) {
      console.error('Error uploading file to %s', finalUploadPath, err);
      throw err;
    }
  };

  const maybeCleanupEmptyAdminFolders = async (file: File) => {
    if (!cleanupAdminFolders) return;
    // Strapi may call provider.delete before removing the DB row.
    // We predict the "post-delete" state by excluding the current file hash.

    let folderId: number | null = typeof file.folder === 'number' ? file.folder : null;
    const folderPathFromPayload =
      typeof file.folderPath === 'string' && file.folderPath.trim().length > 0
        ? file.folderPath.trim()
        : null;

    if (!folderId) {
      // Try resolving from folderPath (works even if DB file row is already deleted)
      if (folderPathFromPayload) {
        try {
          const folderByPath = await strapi.db.query('plugin::upload.folder').findOne({
            where: { path: folderPathFromPayload },
          });
          folderId = typeof folderByPath?.id === 'number' ? folderByPath.id : null;
        } catch {
          folderId = null;
        }
      }
    }

    if (!folderId) {
      try {
        const dbFile = await strapi.db.query('plugin::upload.file').findOne({
          where: { hash: file.hash },
        });
        folderId = typeof dbFile?.folder === 'number' ? dbFile.folder : dbFile?.folder?.id ?? null;
        if (!folderId && typeof dbFile?.folderPath === 'string' && dbFile.folderPath) {
          const folderByPath = await strapi.db.query('plugin::upload.folder').findOne({
            where: { path: dbFile.folderPath },
          });
          folderId = typeof folderByPath?.id === 'number' ? folderByPath.id : null;
        }
      } catch {
        folderId = null;
      }
    }

    if (!folderId) return;

    const folderService: any = strapi?.plugin?.('upload')?.service?.('folder');
    const deleteFolderById = async (id: number) => {
      if (folderService?.deleteByIds) {
        await folderService.deleteByIds([id]);
        return;
      }
      await strapi.db.query('plugin::upload.folder').delete({ where: { id } });
    };

    // Walk up and delete empty folders
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let currentFolder: any = null;
      try {
        currentFolder = await strapi.db.query('plugin::upload.folder').findOne({
          where: { id: folderId },
          populate: { parent: { select: ['id'] } },
        });
      } catch {
        return;
      }

      if (!currentFolder) return;

      // Has child folders?
      let childCount = 0;
      try {
        childCount = await strapi.db.query('plugin::upload.folder').count({
          where: { parent: folderId },
        });
      } catch {
        return;
      }

      if (childCount > 0) return;

      // Has other files?
      let fileCount = 0;
      try {
        // Prefer checking by folderPath (Strapi stores file.folderPath = folder.path)
        fileCount = await strapi.db.query('plugin::upload.file').count({
          where: {
            folderPath: currentFolder.path,
            hash: { $ne: file.hash },
          },
        });
      } catch {
        return;
      }

      if (fileCount > 0) return;

      const parentId: number | null =
        typeof currentFolder?.parent === 'number'
          ? currentFolder.parent
          : currentFolder?.parent?.id ?? null;

      try {
        await deleteFolderById(folderId);
        debugLog('[upload-local-path] admin folder deleted (empty)', { id: folderId });
      } catch {
        return;
      }

      if (!parentId) return;
      folderId = parentId;
    }
  };

  const provider = {
    isPrivate(file?: File) {
      if (!privateEnable || !privateFolderNorm) return false;
      if (!file) return true;
      const u = file?.url ?? '';
      return u.includes(`/${UPLOADS_FOLDER_NAME}/${privateFolderNorm}/`);
    },

    async getSignedUrl(file: File, customParams: Record<string, unknown> = {}): Promise<{ url: string }> {
      const raw = file?.url ?? '';
      if (!privateEnable || !privateSecret || !raw) return { url: raw };
      const canonicalUrl = raw.split('?')[0];
      const requestPath = canonicalUrl.startsWith('http') ? new URL(canonicalUrl).pathname : canonicalUrl;
      const expiresAt = Math.floor(Date.now() / 1000) + privateTTL;
      const token = signPrivateUrl(privateSecret, requestPath, expiresAt);
      return { url: `${canonicalUrl}?token=${encodeURIComponent(token)}&expires=${expiresAt}` };
    },

    checkFileSize(file: File, options: { sizeLimit?: number } = {}) {
      const { sizeLimit } = options;

      // TODO V5: remove providerOptions sizeLimit
      if (config.sizeLimit) {
        if (kbytesToBytes(file.size || 0) > config.sizeLimit)
          throw new PayloadTooLargeError(
            `${file.name} exceeds size limit of ${bytesToHumanReadable(
              config.sizeLimit
            )}.`
          );
      } else if (sizeLimit) {
        if (kbytesToBytes(file.size || 0) > sizeLimit)
          throw new PayloadTooLargeError(
            `${file.name} exceeds size limit of ${bytesToHumanReadable(sizeLimit)}.`
          );
      }
    },

    uploadStream(file: File, customParams: Record<string, unknown> = {}) {
      return upload(file, customParams);
    },

    upload(file: File, customParams: Record<string, unknown> = {}) {
      return upload(file, customParams);
    },

    async delete(file: File, customParams: Record<string, unknown> = {}) {
      // Some delete payloads can miss `ext` or `path`.
      // Build a set of filename candidates from multiple sources.
      const extCandidates = new Set<string>();

      const extDirect = normalizeExt(file.ext);
      if (extDirect) extCandidates.add(extDirect);

      const objectFromUrl = extractObjectPathFromUrl(file.url, {
        marker: uploadsUrlMarker,
        baseUrl,
      });
      if (objectFromUrl) {
        const extFromUrl = path.posix.extname(objectFromUrl);
        if (extFromUrl) extCandidates.add(extFromUrl);
      }

      const objectFromPreviewUrl = extractObjectPathFromUrl(file.previewUrl, {
        marker: uploadsUrlMarker,
        baseUrl,
      });
      if (objectFromPreviewUrl) {
        const extFromPUrl = path.posix.extname(objectFromPreviewUrl);
        if (extFromPUrl) extCandidates.add(extFromPUrl);
      }

      const nameExt = file.name ? path.extname(file.name) : '';
      if (nameExt) extCandidates.add(nameExt);

      const mimeExt = extFromMime(file.mime);
      if (mimeExt) extCandidates.add(mimeExt);

      // If still unknown, allow empty ext (best-effort)
      if (extCandidates.size === 0) extCandidates.add('');

      const rawPath = file.path ?? '';
      const dynamicPathSanitized = rawPath ? sanitizePathDir(rawPath) : '';
      const dynamicPathRaw = normalizeRelativeSlashPath(rawPath);

      try {
        const objectPaths = new Set<string>();
        const dirCandidates = new Set<string>();

        for (const ext of extCandidates) {
          const filename = `${file.hash}${ext}`;

          // 1) Most common: use file.path (sanitized)
          objectPaths.add(join(prefix, dynamicPathSanitized, filename));

          // 2) In case legacy uploads stored raw path (or sanitization differs)
          if (dynamicPathRaw) {
            objectPaths.add(join(prefix, dynamicPathRaw, filename));
          }

          // 3) Absolute fallback: root of uploads (no dynamic path)
          objectPaths.add(join(prefix, filename));
          objectPaths.add(filename);
        }

        // 4) Fallback: try to infer the full objectPath from URL(s) (already includes filename)
        if (objectFromUrl) objectPaths.add(objectFromUrl);
        if (objectFromPreviewUrl) objectPaths.add(objectFromPreviewUrl);

        for (const objectPath of objectPaths) {
          const rel = normalizeRelativeSlashPath(objectPath);
          if (!rel) continue;

          const abs = safeResolveUnderRoot(uploadPath, rel);
          if (!abs) continue;

          if (!fs.existsSync(abs)) continue;

          await fs.promises.unlink(abs);
          debugLog('[upload-local-path] delete removed (direct)', abs);
          if (cleanupDirs) {
            await cleanupEmptyDirs(abs, uploadPath);
          }
          await maybeCleanupEmptyAdminFolders(file);
          return;
        }

        // Last resort: scan likely directories and delete by filename match.
        // This covers cases where Strapi doesn't pass `path` or `ext` correctly for the main file.
        for (const objectPath of objectPaths) {
          const rel = normalizeRelativeSlashPath(objectPath);
          if (!rel) continue;
          const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          const absDir = safeResolveUnderRoot(uploadPath, relDir || '.');
          if (absDir) dirCandidates.add(absDir);
        }

        dirCandidates.add(path.resolve(uploadPath));

        const hash = file.hash;
        const hashEscaped = escapeRegexLiteral(hash);
        const knownExts = Array.from(extCandidates).filter((e) => e);
        const filenameRegex =
          knownExts.length > 0
            ? new RegExp(`^${hashEscaped}(${knownExts.map(escapeRegexLiteral).join('|')})$`, 'i')
            : new RegExp(`^${hashEscaped}\\.[a-z0-9]{1,6}$`, 'i');

        for (const dir of dirCandidates) {
          let entries: string[] = [];
          try {
            entries = await fs.promises.readdir(dir);
          } catch {
            continue;
          }

          for (const name of entries) {
            if (!filenameRegex.test(name)) continue;
            const abs = safeResolveUnderRoot(uploadPath, path.relative(uploadPath, path.join(dir, name)));
            if (!abs) continue;
            if (!fs.existsSync(abs)) continue;
            await fs.promises.unlink(abs);
            debugLog('[upload-local-path] delete removed (scan)', abs);
            if (cleanupDirs) {
              await cleanupEmptyDirs(abs, uploadPath);
            }
            await maybeCleanupEmptyAdminFolders(file);
            return;
          }
        }

        debugLog('[upload-local-path]   not found', {
          hash: file.hash,
          url: file.url,
          previewUrl: file.previewUrl,
          path: file.path,
          ext: file.ext,
        });
        return "File doesn't exist";
      } catch (err) {
        console.error('Error deleting file (hash=%s)', file.hash, err);
        throw err;
      }
    },
  };

  if (privateEnable && privateSecret) {
    try {
      const uploadService = (strapi as any).plugin?.('upload')?.service?.('upload');
      if (uploadService && !(uploadService as any).__uploadLocalPathSignedUrlEnrichPatched) {
        (uploadService as any).__uploadLocalPathSignedUrlEnrichPatched = true;
        const enrichFile = async (file: any) => {
          if (!file || !provider.isPrivate(file)) return;
          try {
            file.url = (await provider.getSignedUrl(file)).url;
          } catch {
            // keep original url
          }
          if (file.formats && typeof file.formats === 'object') {
            for (const key of Object.keys(file.formats)) {
              const fmt = file.formats[key];
              if (fmt?.url && provider.isPrivate(fmt)) {
                try {
                  fmt.url = (await provider.getSignedUrl(fmt)).url;
                } catch {
                  //
                }
              }
            }
          }
        };
        const originalFind = uploadService.find?.bind(uploadService);
        if (typeof originalFind === 'function') {
          uploadService.find = async (params: any) => {
            const result = await originalFind(params);
            if (result?.results && Array.isArray(result.results)) {
              for (const file of result.results) await enrichFile(file);
            }
            return result;
          };
        }
        const originalFindOne = uploadService.findOne?.bind(uploadService);
        if (typeof originalFindOne === 'function') {
          uploadService.findOne = async (id: any, params?: any) => {
            const file = await originalFindOne(id, params);
            await enrichFile(file);
            return file;
          };
        }
        debugLog('[upload-local-path] upload service patched (signed URL enrich for find/findOne)');
      }
    } catch (err) {
      debugLog('[upload-local-path] could not patch upload service for signed URLs', err);
    }
  }

  return provider;
}

// Default export for backward compatibility
export default init;
