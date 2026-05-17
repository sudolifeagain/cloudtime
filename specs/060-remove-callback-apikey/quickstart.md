# Quickstart: Remove API Key from OAuth Callback Response

## Prerequisites

- Node.js, npm installed
- Wrangler CLI configured
- CloudTime project cloned, on `060-remove-callback-apikey` branch

## SDD Workflow

### Step 1: Update OpenAPI Spec

Edit `schemas/paths/auth/provider-callback.yaml`:

1. Remove `api_key` property from the `200` response schema
2. Update the `description` to remove the paragraph about returning the API key on first-time creation

Commit: `spec: remove api_key from OAuth callback response schema`

### Step 2: Regenerate Types

```bash
npm run generate
```

Commit: `chore: regenerate types`

### Step 3: Update Route Handler

Edit `src/routes/auth/login.ts`:

1. Remove `api_key: apiKeyPlaintext` from the new-user response object
2. Remove the `apiKeyPlaintext` variable (or leave generation for hash storage, just don't return it)

Commit: `fix: remove API key from OAuth callback response (Closes #60)`

### Step 4: Validate

```bash
npx tsc --noEmit
```

### Step 5: Create PR

```bash
git push -u origin 060-remove-callback-apikey
gh pr create --base develop
```

## Verification

After completing the OAuth login flow as a new user, the response should:

1. Contain `user` and `is_new_user: true`
2. NOT contain `api_key`
3. Have a valid session cookie set

The user can then call `POST /auth/api-key` with the session cookie to obtain their API key.
