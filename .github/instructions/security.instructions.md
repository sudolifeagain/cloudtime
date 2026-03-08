---
applyTo: "src/**/*.ts"
excludeAgent: "coding-agent"
---
# Security Review Focus

- Flag any use of `eval()`, `new Function()`, or dynamic code execution.
- Flag SQL queries built with string concatenation or template literals containing user input.
- Flag secrets, API keys, or tokens appearing in logs, error messages, or response bodies.
- Flag missing authentication checks in route handlers.
- Flag cookies without `HttpOnly`, `Secure`, or `SameSite` attributes.
- Flag cryptographic operations not using Web Crypto API.
- Flag hardcoded secrets or credentials.
- Flag CORS configurations that allow `*` origin with credentials.
