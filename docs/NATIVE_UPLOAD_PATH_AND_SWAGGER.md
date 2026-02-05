# Custom route with path, pathDir and private

This guide shows a **custom route** that uses the upload service with **path**, **pathDir** and **private**. The example is a real controller + route + Swagger setup that has been tested.

For **private** uploads you must use a custom route that calls the upload service with `data.private: true` and `data.pathDir` set to the user's document ID (e.g. `user.documentId`).

---

## 1. Custom route with controller (supports private)

This example uses a **custom API** (`api::my-content-type.my-content-type`) with a controller action and a custom route. It supports **path**, **pathDir** and **private**, and documents the endpoint in Swagger via the route config.

### 1.1 Controller

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
      const { type } = body;

      if (!files?.file) return ctx.badRequest('No file uploaded');
      if (!type) return ctx.badRequest('Type is required');

      const file = Array.isArray(files.file) ? files.file[0] : files.file;

      // 1) Create entry (or your own entity)
      const entry = await strapi.db.query('api::my-content-type.my-content-type').create({
        data: {
          user: user.id,
          type: [type],
          stage: ['NOT_SENT'],
        },
      });

      // 2) Upload file with path, pathDir and private (strapi-provider-upload-local-secure)
      const result = await strapi.plugin('upload').service('upload').upload({
        data: {
          path: user.name,
          pathDir: user.documentId,
          private: true,
          ref: 'api::my-content-type.my-content-type',
          refId: entry.id,
          field: 'file',
          fileInfo: {
            name: file.originalFilename,
            caption: `File ${type}`,
            alternativeText: `File ${type}`,
          },
          user,
        },
        files: file,
      });

      const uploadedFile = Array.isArray(result) ? result[0] : result;

      // 3) Link file to entry
      const entryUpdated = await strapi.documents('api::my-content-type.my-content-type').update({
        documentId: entry.documentId,
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

### 1.2 Custom route with Swagger

Create or edit **`src/api/my-content-type/routes/custom-upload.ts`**:

```ts
export default {
  routes: [
    {
      method: 'POST',
      path: '/my-content-types/upload',
      handler: 'my-content-type.upload',
      config: {
        tags: ['My content type'],
        swagger: {
          tags: ['My content type'],
          summary: 'Upload file',
          description: 'Upload a file for an entry. Uses path, pathDir and private (strapi-provider-upload-local-secure).',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'type'],
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'File to upload',
                    },
                    type: {
                      type: 'string',
                      description: 'Type or category of the file',
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
                          documentId: { type: 'string' },
                          file: {
                            type: 'object',
                            properties: {
                              id: { type: 'integer' },
                              url: { type: 'string' },
                              name: { type: 'string' },
                              mime: { type: 'string' },
                              size: { type: 'number' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'Bad request' },
            401: { description: 'Not authenticated' },
            500: { description: 'Internal server error' },
          },
        },
      },
    },
  ],
};
```

The route is **`POST /api/my-content-types/upload`**. Swagger is defined in the route `config.swagger` (or via your documentation plugin if it reads it).

---

## 2. Configure permissions (users-permissions)

After adding the custom route, allow access in the Admin:

1. Open **Admin** → **Settings** (gear icon) → **Users & Permissions** → **Roles**.
2. Choose the role that should call the upload (e.g. **Authenticated**).
3. Under **My content type** (or the API that owns the custom route), enable:
   - **Upload** (or the action that matches `my-content-type.upload`).
4. Save.

If the action appears under a different name (e.g. **Custom** or the route path), enable that. The exact label depends on how your Strapi and documentation plugin expose permissions.

---

## 3. Summary

| Topic | Detail |
|--------|--------|
| **Route** | e.g. `POST /api/my-content-types/upload` (custom) |
| **path / pathDir / private** | Set in the controller when calling `strapi.plugin('upload').service('upload').upload({ data: { path, pathDir, private, ... }, files })`. |
| **Swagger** | Define in the route `config.swagger` (or via your documentation plugin). |
| **Permissions** | Enable the custom action in **Admin → Settings → Users & Permissions → Roles** for the role that should call the endpoint. |
