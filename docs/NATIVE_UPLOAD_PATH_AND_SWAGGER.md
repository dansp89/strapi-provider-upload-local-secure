# Custom route with path, pathDir and private

Complete guide for a **custom upload route** using [strapi-provider-upload-local-secure](https://www.npmjs.com/package/strapi-provider-upload-local-secure) with **path**, **pathDir** and **private**. Includes controller, route with configurable Swagger fields, and permissions setup.

For **private** uploads you must use a custom route that calls the upload service with `data.private: true` and `data.pathDir` set to the user's document ID (e.g. `user.documentId`).

**Optional Swagger documentation:** Use [strapi-swagger-custom-paths](https://www.npmjs.com/package/strapi-swagger-custom-paths) to expose routes in Swagger/OpenAPI. Name your route file `01-custom.ts` and add `config.swagger` — the package discovers and merges them. No dependency between the upload provider and the Swagger package.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Controller](#2-controller)
3. [Custom route (01-custom.ts)](#3-custom-route-01-customts)
4. [strapi-swagger-custom-paths setup](#4-strapi-swagger-custom-paths-setup)
5. [Permissions](#5-permissions)
6. [Field reference](#6-field-reference)
7. [Summary](#7-summary)

---

## 1. Prerequisites

- Strapi 5.x with `strapi-provider-upload-local-secure` configured
- Content type `api::my-content-type.my-content-type` with a `file` (single media) and optional fields (`type`, `stage`, etc.)
- Users-permissions plugin enabled

---

## 2. Controller

Create or edit **`src/api/my-content-type/controllers/my-content-type.ts`**:

```ts
/**
 * my-content-type controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::my-content-type.my-content-type', ({ strapi }) => ({
  async upload(ctx) {
    try {
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized('User not authenticated');

      const { body, files } = ctx.request;

      if (!files?.file) return ctx.badRequest('No file uploaded');

      const file = Array.isArray(files.file) ? files.file[0] : files.file;

      // 1) Create entry
      const entry = await strapi.db.query('api::my-content-type.my-content-type').create({
        data: {
          user: user.id,
          type: body.type ? [body.type] : [],
          stage: body.stage ? [body.stage] : ['NOT_SENT'],
        },
      });

      // 2) Build path/pathDir from body or defaults
      const path = body.path ?? user.name ?? 'uploads';
      const pathDir = body.pathDir ?? user.documentId ?? String(user.id);
      const isPrivate = body.private !== false; // default true for this route

      // 3) Upload file (strapi-provider-upload-local-secure)
      const result = await strapi.plugin('upload').service('upload').upload({
        data: {
          path,
          pathDir,
          private: isPrivate,
          ref: 'api::my-content-type.my-content-type',
          refId: entry.documentId ?? entry.id,
          field: 'file',
          fileInfo: {
            name: file.originalFilename ?? file.name,
            caption: body.caption ?? `File ${body.type ?? 'upload'}`,
            alternativeText: body.alternativeText ?? body.caption ?? file.originalFilename ?? file.name,
          },
          user,
        },
        files: file,
      });

      const uploadedFile = Array.isArray(result) ? result[0] : result;

      // 4) Link file to entry
      const entryUpdated = await strapi.documents('api::my-content-type.my-content-type').update({
        documentId: entry.documentId ?? entry.id,
        data: { file: uploadedFile.id },
        populate: {
          file: true,
          user: { fields: ['id', 'documentId'] },
        },
      });

      return ctx.send({ data: entryUpdated }, 201);
    } catch (error) {
      strapi.log.error('Upload error:', error);
      return ctx.internalServerError('Error saving file');
    }
  },
}));
```

---

## 3. Custom route (01-custom.ts)

Create **`src/api/my-content-type/routes/01-custom.ts`** with configurable fields. Adjust the `CONFIG` object and Swagger schema to match your content type.

```ts
/**
 * Configurable options — customize for your content type and API.
 */
const CONFIG = {
  /** Route path (without /api prefix) */
  path: '/my-content-types/upload',
  /** Route tags for Swagger grouping */
  tags: ['My content type'],
  /** Default private mode (files stored under private folder) */
  defaultPrivate: true,
  /** Required form fields besides file. Add 'type' if your API requires it. */
  requiredFields: [] as const,
  /** Optional form fields exposed in Swagger */
  optionalFields: ['path', 'pathDir', 'caption', 'alternativeText', 'private', 'stage'] as const,
};

export default {
  routes: [
    {
      method: 'POST',
      path: CONFIG.path,
      handler: 'my-content-type.upload',
      config: {
        tags: CONFIG.tags,
        swagger: {
          tags: CONFIG.tags,
          summary: 'Upload file',
          description: [
            'Upload a file with optional path organization. Uses strapi-provider-upload-local-secure.',
            '- **path**: Media Library folder (Admin)',
            '- **pathDir**: Physical subdirectory under uploads',
            '- **private**: Store in private folder (HMAC/JWT access)',
            '- **caption** / **alternativeText**: File metadata',
          ].join('\n'),
          operationId: 'uploadMyContentType',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', ...CONFIG.requiredFields],
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'File to upload',
                    },
                    type: {
                      type: 'string',
                      description: 'Type or category of the file (optional)',
                      example: 'document',
                    },
                    path: {
                      type: 'string',
                      description: 'Media Library folder (Admin). Default: user name',
                      example: 'documents',
                    },
                    pathDir: {
                      type: 'string',
                      description: 'Physical subdirectory under uploads. Default: user documentId',
                      example: 'user-abc123',
                    },
                    caption: {
                      type: 'string',
                      description: 'File caption',
                      example: 'Contract document',
                    },
                    alternativeText: {
                      type: 'string',
                      description: 'Alternative text for the file',
                      example: 'Contract document',
                    },
                    private: {
                      type: 'boolean',
                      description: 'Store in private folder (requires auth or HMAC URL). Default: true',
                      default: CONFIG.defaultPrivate,
                      example: true,
                    },
                    stage: {
                      type: 'string',
                      description: 'Entry stage/category',
                      example: 'NOT_SENT',
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Entry created and file uploaded successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'object',
                        properties: {
                          documentId: { type: 'string', example: 'abc123' },
                          file: {
                            type: 'object',
                            properties: {
                              id: { type: 'integer' },
                              documentId: { type: 'string' },
                              url: { type: 'string', example: '/uploads/private/user-id/xxx.ext' },
                              name: { type: 'string' },
                              alternativeText: { type: 'string', nullable: true },
                              caption: { type: 'string', nullable: true },
                              mime: { type: 'string' },
                              size: { type: 'number' },
                            },
                          },
                          user: {
                            type: 'object',
                            properties: {
                              id: { type: 'integer' },
                              documentId: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: {
              description: 'Bad request (e.g. missing file or required fields)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'object', properties: { message: { type: 'string' } } },
                    },
                  },
                },
              },
            },
            401: {
              description: 'Not authenticated',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'object', properties: { message: { type: 'string' } } },
                    },
                  },
                },
              },
            },
            500: {
              description: 'Internal server error',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'object', properties: { message: { type: 'string' } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  ],
};
```

**Route:** `POST /api/my-content-types/upload`

To make `type` optional, change `requiredFields` to `[]` and adjust the controller validation.

---

## 4. strapi-swagger-custom-paths setup

If you use [strapi-swagger-custom-paths](https://www.npmjs.com/package/strapi-swagger-custom-paths):

**Install:**
```bash
# npm
npm install strapi-swagger-custom-paths

# yarn
yarn add strapi-swagger-custom-paths

# bun
bun add strapi-swagger-custom-paths
```

**Config** (`config/plugins.ts` or `config/plugins.js`):

```ts
import { getCustomSwaggerPaths } from 'strapi-swagger-custom-paths';

export default () => ({
  documentation: {
    enabled: true,
    config: {
      'x-strapi-config': { path: '/documentation' },
      paths: getCustomSwaggerPaths(),
    },
  },
});
```

The package scans all `01-custom.ts` / `01-custom.js` files and merges `config.swagger` into OpenAPI paths.

---

## 5. Permissions

1. **Admin** → **Settings** → **Users & Permissions** → **Roles**
2. Select the role (e.g. **Authenticated**)
3. Under **My content type**, enable the action that matches `my-content-type.upload` (e.g. **Upload** or **Custom**)
4. Save

---

## 6. Field reference

| Form field       | Required | Description |
|------------------|----------|-------------|
| `file`           | Yes      | File to upload (binary) |
| `type`           | Configurable | Category/type of the file |
| `path`           | No       | Media Library folder (Admin). Default: `user.name` |
| `pathDir`        | No       | Physical subdirectory under `uploads/`. Default: `user.documentId` |
| `caption`        | No       | File caption |
| `alternativeText`| No       | Alternative text |
| `private`        | No       | `true` = private folder (HMAC/JWT), `false` = public. Default: `true` |
| `stage`          | No       | Entry stage (e.g. `NOT_SENT`) |

---

## 7. Summary

| Topic | Detail |
|-------|--------|
| **Route** | `POST /api/my-content-types/upload` |
| **path / pathDir / private** | Set via form fields or defaults in controller |
| **Swagger** | Defined in `01-custom.ts` with configurable schema |
| **strapi-swagger-custom-paths** | Optional; use `getCustomSwaggerPaths()` in documentation config |
| **Permissions** | Enable upload action for the role in Admin → Settings → Roles |
