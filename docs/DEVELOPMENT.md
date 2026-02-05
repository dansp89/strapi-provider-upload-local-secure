# Development, local testing & publishing

Guide for contributors: local setup, testing the provider in a Strapi project, and publishing to npm.

## Prerequisites

- Node.js 20.x or higher
- npm, yarn, or bun
- Strapi 5.x project for testing

## Local Development Setup

### Clone and Setup

```bash
git clone https://github.com/dansp89/strapi-provider-upload-local-secure.git
cd strapi-providers-upload-local-path

# Install dependencies
bun install
# or
npm install
# or
yarn install

# Build the package
bun run build
# or
npm run build
# or
yarn build
```

## Testing Locally with npm link

### Step 1: Link the package locally

```bash
# In the provider directory
npm link
```

### Step 2: Link in your Strapi project

```bash
# In your Strapi project directory
npm link strapi-provider-upload-local-secure
```

### Step 3: Configure your Strapi project

**TypeScript** (`config/plugins.ts`):

```ts
export default () => ({
  upload: {
    config: {
      provider: 'strapi-provider-upload-local-secure',
      providerOptions: {
        debug: false,
        strictPathDir: false,
        cleanupEmptyDirs: false,
        cleanupEmptyAdminFolders: false,
        usePathAsPathDir: true,
        uploadsUrlMarker: '/uploads/',
        renameToUuid: false,
        privateEnable: false,
        privateFolder: 'private',
        privateTTL: 60,
        privateSecret: '',
        privateUserDocumentIdField: 'id',
      },
    },
  },
});
```

**JavaScript** (`config/plugins.js`):

```js
module.exports = ({ env }) => ({
  upload: {
    config: {
      provider: 'strapi-provider-upload-local-secure',
      providerOptions: {
        debug: false,
        strictPathDir: false,
        cleanupEmptyDirs: false,
        cleanupEmptyAdminFolders: false,
        usePathAsPathDir: true,
        uploadsUrlMarker: '/uploads/',
        renameToUuid: false,
        privateEnable: false,
        privateFolder: 'private',
        privateTTL: 60,
        privateSecret: '',
        privateUserDocumentIdField: 'id',
      },
    },
  },
});
```

### Step 4: Test the provider

```bash
# Start your Strapi project
bun run develop
# or
npm run develop
# or
yarn develop
```

## Testing Locally with bun link

### Step 1: Link the package locally

```bash
# In the provider directory
bun link
```

### Step 2: Link in your Strapi project

```bash
# In your Strapi project directory
bun link strapi-provider-upload-local-secure
```

### Step 3: Configure and test

Use the same configuration as in **Step 3** of the npm link section above, then start your Strapi project.

## Development with Watch Mode

For continuous development with automatic rebuilds:

**Terminal 1 – watch mode**

```bash
cd /path/to/strapi-providers-upload-local-path
bun run watch
# or
npm run watch
# or
yarn watch
```

**Terminal 2 – Strapi**

```bash
cd /path/to/your-strapi-project
bun run develop
# or
npm run develop
# or
yarn develop
```

The package will rebuild automatically when you change the source.

## Testing with File System

After uploading files, check the directory structure:

```bash
ls -la uploads/
ls -la uploads/user-123/
ls -la uploads/contracts/
```

## Running Tests

```bash
# Unit tests
bun run test:unit
# or
npm run test

# Watch mode
bun run test:unit:watch
# or
npm run test:watch
```

## Publishing to npm

### Preparation

1. **Bump version** (in package directory):

   ```bash
   npm version patch   # 1.0.0 → 1.0.1
   npm version minor   # 1.0.0 → 1.1.0
   npm version major   # 1.0.0 → 2.0.0
   ```

2. **Build**:

   ```bash
   bun run build
   # or
   npm run build
   ```

3. **Dry run** (optional):

   ```bash
   npm pack --dry-run
   ```

### Publish with npm

```bash
npm login
npm publish
npm view strapi-provider-upload-local-secure
```

### Publish with bun

```bash
bun login
bun publish
```

### Publish with yarn

```bash
yarn login
yarn publish
```

### After publishing

1. Install in a test project:

   ```bash
   cd /tmp/test-project
   npm init -y
   npm install strapi-provider-upload-local-secure
   ```

2. Check package contents:

   ```bash
   ls node_modules/strapi-provider-upload-local-secure/
   cat node_modules/strapi-provider-upload-local-secure/package.json
   ```

## Common Development Issues

1. **Link not working**
   - Run `npm link` (or `bun link`) in both the provider directory and the Strapi project.
   - Confirm `node_modules/strapi-provider-upload-local-secure` exists in the Strapi project.
   - Use the exact provider name `strapi-provider-upload-local-secure`.

2. **Changes not reflected**
   - Restart the Strapi server after rebuilding the provider.
   - Ensure watch mode is running and the build completes successfully.
