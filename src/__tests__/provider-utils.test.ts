import fs from 'fs';
import os from 'os';
import path from 'path';

import { extractObjectPathFromUrl } from '../utils/url';
import { cleanupEmptyDirs, sanitizeAdminFolderPath, sanitizePathDir } from '../utils/path';

describe('utils', () => {
  test('sanitizePathDir strips diacritics and unsafe segments', () => {
    expect(sanitizePathDir('  Árvore/../Café  ')).toBe('Arvore/Cafe');
    expect(sanitizePathDir('////a//b///')).toBe('a/b');
    expect(sanitizePathDir('..')).toBe('');
    expect(sanitizePathDir('.hidden/ok')).toBe('hidden/ok');
  });

  test('sanitizeAdminFolderPath keeps only allowed characters and NFD', () => {
    expect(sanitizeAdminFolderPath('  Pástã Áçêntô/2026 !!! ')).toBe('Pasta Acento/2026');
    expect(sanitizeAdminFolderPath('a/./b')).toBe('a/b');
    expect(sanitizeAdminFolderPath('')).toBe('');
  });

  test('extractObjectPathFromUrl supports marker and baseUrl fallback', () => {
    expect(extractObjectPathFromUrl('/uploads/a/b.png', { marker: '/uploads/' })).toBe('a/b.png');
    expect(
      extractObjectPathFromUrl('https://cdn.example.com/uploads/a%20b.png', { marker: '/uploads/' })
    ).toBe('a b.png');
    expect(
      extractObjectPathFromUrl('https://cdn.example.com/a/b.png', {
        marker: '/uploads/',
        baseUrl: 'https://cdn.example.com',
      })
    ).toBe('a/b.png');
  });

  test('cleanupEmptyDirs removes empty parents under root', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'upload-local-path-'));
    const root = path.join(tmp, 'public', 'uploads');
    const filePath = path.join(root, 'a', 'b', 'c.txt');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, 'x');

    await fs.promises.unlink(filePath);
    await cleanupEmptyDirs(filePath, root);

    expect(fs.existsSync(path.join(root, 'a'))).toBe(false);
    expect(fs.existsSync(root)).toBe(true);

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
});

describe('provider delete', () => {
  test('deletes by url when path/ext are missing and cleans up dirs', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'upload-local-path-provider-'));
    const publicDir = path.join(tmp, 'public');
    const uploadsRoot = path.join(publicDir, 'uploads');
    await fs.promises.mkdir(uploadsRoot, { recursive: true });

    const hash = 'ff8ce647f5';
    const objectPath = `custom/${hash}.png`;
    const absPath = path.join(uploadsRoot, objectPath);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, 'png');

    // Minimal strapi global stub used by init()
    (global as any).strapi = {
      dirs: { static: { public: publicDir } },
      plugin: () => ({
        service: () => ({
          upload: async () => [],
        }),
      }),
      log: { debug: () => {} },
    };

    const { init } = await import('../index');
    const provider = init({
      baseUrl: 'https://cdn.example.com',
      cleanupEmptyDirs: true,
    });

    // path/ext intentionally missing to force url extraction fallback
    await provider.delete({
      hash,
      url: `https://cdn.example.com/${objectPath}`,
    } as any);

    expect(fs.existsSync(absPath)).toBe(false);
    expect(fs.existsSync(path.join(uploadsRoot, 'custom'))).toBe(false);
    expect(fs.existsSync(uploadsRoot)).toBe(true);

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('cleanupEmptyAdminFolders deletes empty admin folder (using folderPath)', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'upload-local-path-admin-clean-'));
    const publicDir = path.join(tmp, 'public');
    const uploadsRoot = path.join(publicDir, 'uploads');
    await fs.promises.mkdir(uploadsRoot, { recursive: true });

    // create a physical file
    const hash = 'abc123';
    const objectPath = `x/${hash}.png`;
    const absPath = path.join(uploadsRoot, objectPath);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, 'png');

    // DB stubs: folder exists, has no children, has no other files
    const folderDeleteByIds = jest.fn(async () => ({}));
    const folderService = { deleteByIds: folderDeleteByIds, create: jest.fn() };

    const folderFindOne = jest.fn(async ({ where }: any) => {
      if (where?.path === '/1') return { id: 1, path: '/1', parent: null };
      if (where?.id === 1) return { id: 1, path: '/1', parent: null };
      return null;
    });

    const folderCount = jest.fn(async () => 0);
    const fileCount = jest.fn(async () => 0);
    const fileFindOne = jest.fn(async () => null); // simulate DB row already gone

    (global as any).strapi = {
      dirs: { static: { public: publicDir } },
      plugin: () => ({
        service: (name: string) => (name === 'folder' ? folderService : { upload: async () => [] }),
      }),
      db: {
        query: (uid: string) => {
          if (uid === 'plugin::upload.folder') {
            return { findOne: folderFindOne, count: folderCount };
          }
          if (uid === 'plugin::upload.file') {
            return { count: fileCount, findOne: fileFindOne };
          }
          return {};
        },
      },
      log: { debug: () => {} },
    };

    const { init } = await import('../index');
    const provider = init({
      baseUrl: 'https://cdn.example.com',
      cleanupEmptyAdminFolders: true,
    });

    await provider.delete({
      hash,
      url: `https://cdn.example.com/${objectPath}`,
      folderPath: '/1',
    } as any);

    expect(folderDeleteByIds).toHaveBeenCalledWith([1]);

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
});

describe('upload service patch', () => {
  test('sets folder for fileInfo array (multi-upload) and maps pathDir', async () => {
    const uploadFn = jest.fn(async (payload: any) => payload);
    const folderCreate = jest
      .fn()
      .mockImplementationOnce(async () => ({ id: 10 }))
      .mockImplementationOnce(async () => ({ id: 11 }));
    const folderFindOne = jest.fn(async () => null);

    const uploadService = { upload: uploadFn } as any;
    const folderService = { create: folderCreate } as any;

    (global as any).strapi = {
      dirs: { static: { public: '/tmp' } },
      plugin: () => ({
        service: (name: string) => (name === 'upload' ? uploadService : name === 'folder' ? folderService : undefined),
      }),
      db: {
        query: () => ({ findOne: folderFindOne }),
      },
      log: { debug: () => {} },
    };

    const { init } = await import('../index');
    init({ usePathAsPathDir: true });

    const payload = await uploadService.upload(
      {
        data: {
          path: 'Pástã Áçêntô/Sub!@#',
          pathDir: 'dir-çöm-áçêntô',
          fileInfo: [{ name: 'a' }, { name: 'b' }],
        },
        files: [],
      },
      { user: { id: 1 } }
    );

    // fileInfo should remain an array and contain folder
    expect(Array.isArray(payload.data.fileInfo)).toBe(true);
    expect(payload.data.fileInfo[0].folder).toBe(11); // leaf folder id
    expect(payload.data.fileInfo[1].folder).toBe(11);

    // pathDir is removed and mapped into `data.path` (filesystem)
    expect(payload.data.pathDir).toBeUndefined();
    expect(payload.data.path).toBe('dir-com-acento');

    // admin folder path should be sanitized before creation
    expect(folderCreate).toHaveBeenCalledWith({ name: 'Pasta Acento', parent: null }, { user: { id: 1 } });
    expect(folderCreate).toHaveBeenCalledWith({ name: 'Sub', parent: 10 }, { user: { id: 1 } });
  });

  test('also patches replace() (compatibility)', async () => {
    const uploadFn = jest.fn(async (payload: any) => payload);
    const replaceFn = jest.fn(async (_id: any, payload: any) => payload);
    const folderCreate = jest.fn(async () => ({ id: 22 }));
    const folderFindOne = jest.fn(async () => null);

    const uploadService = { upload: uploadFn, replace: replaceFn } as any;
    const folderService = { create: folderCreate } as any;

    (global as any).strapi = {
      dirs: { static: { public: '/tmp' } },
      plugin: () => ({
        service: (name: string) => (name === 'upload' ? uploadService : name === 'folder' ? folderService : undefined),
      }),
      db: {
        query: () => ({ findOne: folderFindOne }),
      },
      log: { debug: () => {} },
    };

    const { init } = await import('../index');
    init({ usePathAsPathDir: true });

    const payload = await uploadService.replace(
      123,
      {
        data: {
          path: 'Admin Folder',
          pathDir: 'FS Dir',
          fileInfo: { name: 'x' },
        },
        file: {},
      },
      { user: { id: 1 } }
    );

    expect(payload.data.fileInfo.folder).toBe(22);
    expect(payload.data.pathDir).toBeUndefined();
    expect(payload.data.path).toBe('FS-Dir'); // sanitizePathDir does whitespace->dash
  });
});

