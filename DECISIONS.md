# Decisions

## 2026-07-06 - Phase 1 Uses Dev Cookie Auth

Decision: Phase 1 uses a clearly labeled development-only cookie session instead of wiring OTP or Google OAuth.

Why: The first goal is repository, schema, app shell, seeded workspace, and dashboard flow. Real auth would introduce provider setup and secrets before the foundation is proven.

Tradeoff: The UI can exercise login and workspace routing locally, but production auth remains unimplemented until a later phase.

Status: Active.

## 2026-07-06 - No External Provider Calls In Foundation

Decision: Upload, URL import, transcription, AI analysis, rendering, storage, billing, and publishing are visible as stubs only.

Why: The goal explicitly forbids paid providers, Pulpit Engine infrastructure, and live credentials. The foundation must be runnable from a clean clone without external services beyond local Postgres.

Tradeoff: The dashboard is useful for project records and seeded data, but it does not process video yet.

Status: Active.

## 2026-07-06 - Postgres Is The Only Database Target

Decision: Prisma is configured for PostgreSQL only, with Docker Compose for the standard local path.

Why: The product spec requires a fresh Postgres instance and one canonical ordered migration path. Avoiding SQLite keeps the local schema close to the intended deployment target.

Tradeoff: Local setup requires Docker or a local Postgres service.

Status: Active.
