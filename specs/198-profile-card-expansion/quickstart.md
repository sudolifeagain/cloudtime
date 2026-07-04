# Quickstart: Profile Badge and Composite Card Expansion

This quickstart describes the expected behavior after PR2 implementation. PR1
only defines the contract.

## Enable Public Embeds

From the authenticated dashboard, enable public profile cards in the GitHub
profile cards settings section. Public image URLs must remain non-secret.

## Badge Examples

```markdown
![CloudTime today](https://your-worker.example.com/api/v1/users/YOUR_USERNAME/badges/coding_time.svg?range=today&theme=default)
![CloudTime this week](https://your-worker.example.com/api/v1/users/YOUR_USERNAME/badges/coding_time.svg?range=last_7_days&theme=default)
![CloudTime top language](https://your-worker.example.com/api/v1/users/YOUR_USERNAME/badges/top_language.svg?range=last_7_days&theme=default)
![CloudTime current streak](https://your-worker.example.com/api/v1/users/YOUR_USERNAME/badges/current_streak.svg?theme=default)
![CloudTime goal progress](https://your-worker.example.com/api/v1/users/YOUR_USERNAME/badges/goal_progress.svg?theme=default)
```

## Composite Profile Card Example

```markdown
![CloudTime profile](https://your-worker.example.com/api/v1/users/YOUR_USERNAME/cards/profile.svg?metrics=today,week,top_language,current_streak&theme=default)
```

## Force Refresh

Append or update `v` to force a cache-key change when a proxy still serves an
older image:

```markdown
![CloudTime profile](https://your-worker.example.com/api/v1/users/YOUR_USERNAME/cards/profile.svg?theme=default&v=20260705)
```

## Expected Responses

- `200 image/svg+xml`: public embeds enabled and request valid.
- `400 application/json`: invalid metric, label, UUID, enum, or query shape.
- `404 application/json`: user missing, public embeds disabled, or requested
  goal/template unavailable.
- `429 application/json`: public image rate limit exceeded.

## Validation Commands

```powershell
npm run generate
npm run lint:api
npm run typecheck
npm test -- tests/unit/cards-render.test.ts tests/unit/cards-snippets.test.ts tests/integration/embeddable-cards.test.ts
```
