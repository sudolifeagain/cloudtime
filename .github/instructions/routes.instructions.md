---
applyTo: "src/routes/**/*.ts"
---
# Route Handler Standards

- Every route must authenticate via `getUserId()` before accessing user data.
- Request body validation must happen before any DB operations.
- Response shape must match the OpenAPI schema for that endpoint.
- Use HTTP status codes correctly: 200 OK, 201 Created, 202 Accepted, 204 No Content, 400 Bad Request, 401 Unauthorized, 404 Not Found, 409 Conflict.
- Never return raw DB rows — map to API response types.
- Wrap D1 queries in try/catch and return 500 with generic error message on failure.
- Never leak internal error details to the client.
