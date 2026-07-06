# Sermon Clipper

Standalone Phase 1 foundation for a church-focused long-video-to-short-clips product.

This repository is intentionally separate from Pulpit Engine. It does not import Pulpit Engine code, connect to Pulpit Engine databases, reuse Railway services, or require live provider credentials.

## Current Scope

Implemented:

- Next.js App Router, TypeScript, Tailwind
- Prisma schema and ordered migrations for the Phase 1 data model
- Local Postgres dev path via Docker Compose
- Development-only cookie auth
- Onboarding, dashboard, project detail, settings, and billing routes
- Seeded demo workspace, source video, project, stub job, usage ledger, and sample clip
- Unit tests for workspace scoping and draft project creation data
- CI workflow for lint, typecheck, tests, Prisma validation, and build

Stubbed by design:

- Video upload and URL import
- Provider calls for ASR, AI analysis, rendering, storage, billing, and publishing
- Production OTP or Google OAuth
- Pulpit Engine bridge

## Local Setup

1. Install dependencies:

```sh
npm ci
```

2. Create a local env file:

```sh
cp .env.example .env
```

3. Start Postgres.

Preferred path:

```sh
docker compose up -d
```

If Docker is not available, run any local PostgreSQL 17-compatible service and set `DATABASE_URL` to a fresh database that belongs only to this product.

4. Apply migrations and seed:

```sh
npm run db:migrate
npm run db:seed
```

5. Start the app:

```sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use `demo@sermonclipper.local` on the dev login screen.

## Verification

```sh
npm run verify
```

This runs Prisma validation, ESLint, TypeScript, Vitest, and the production Next build. It does not require external provider credentials.

## Notes

- `.env.example` contains only local development placeholders.
- Real upload, ASR, AI, storage, render, and billing providers are intentionally absent in Phase 1.
- The reserved `POST /api/integrations/pulpit-engine/webhook` endpoint returns HTTP 501.
