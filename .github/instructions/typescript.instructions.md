---
applyTo: "**/*.ts"
---
# TypeScript Standards

- Strict mode enabled. No `any` types unless absolutely necessary.
- Import types with `import type` when only used for type-checking.
- Prefer `interface` over `type` for object shapes.
- Use `const` by default, `let` only when reassignment is needed.
- No unused variables or imports.
- Explicit return types on exported functions.
- Use nullish coalescing (`??`) and optional chaining (`?.`) over manual null checks.
- No `console.log` in production code — only in dev/debug paths.
