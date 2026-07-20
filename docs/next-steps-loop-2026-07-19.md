# Next-Steps Loop — 2026-07-19

Follow-up to `docs/bugfix-loop-2026-07-19.md`. This file is the single source of truth
for the loop: work items, protocol, and progress checkboxes.

**Authorization scope (differs from the bugfix loop):** by running this loop, remote
actions are explicitly authorized where an item says so — merging PR #17 (which
deploys to production and runs `prisma migrate deploy`), pushing a new branch, and
opening (never merging) one new PR. Nothing else outward-facing: no other merges, no
Railway config changes, no deleting remote branches, no Facebook/Meta API calls.

## Protocol (every iteration)

1. Read this file. Pick the **first unchecked item**. Items are ordered; do not skip
   unless blocked — if blocked, write a note under the item explaining why and move on.
2. Judgment rule: where an item says "default", implement the default and note any open
   question under the item. Where an item says "STOP", do not act — write findings under
   the item, check it as done-with-notes, and continue to the next item.
3. Local work protocol matches the bugfix loop: read the relevant guide in
   `node_modules/next/dist/docs/` before writing Next.js-facing code; add tests for
   behavioral changes; `npm run verify` must pass before any commit; never touch `.env`.
4. Update this file's checkbox (and notes) in the same commit as the item's work when
   the item produces commits; for items that produce no commits (verification-only),
   commit the checkbox/notes update on its own.
5. When all items are checked: append a `## Completion report` section summarizing what
   happened per item (including anything left for Jake), commit it, and stop the loop.

## Work items (in order)

### - [x] 1. Merge PR #17 and verify the production deploy

- **Done 2026-07-20 ~04:54–04:59 UTC.**
  a. PR #17 MERGED (mergedAt 2026-07-20T04:54:26Z), merge commit `aa17451`.
  b. Railway deploys: worker `ce5fb056` SUCCESS, web `02323919` SUCCESS (both from `aa17451`).
  c. Web pre-deploy applied both migrations at 04:56:23 UTC: `20260719083000_add_scheduled_post_retry` and `20260719090000_scheduled_post_clip_set_null` — "All migrations have been successfully applied."
  d. `npm run smoke:production -- --base-url https://web-production-2a243.up.railway.app --commit-sha aa17451…` → **status: ok**, all 10 checks OK.
- **Finding worth knowing (no action taken):** only the web service has `preDeployCommand: npm run db:migrate:deploy` (railway.json). The worker deployed ~90s *before* web's migrations ran and spammed `The column scheduled_posts.attempt_count does not exist` (P2022) every ~2s from 04:55:48 until 04:56:22; it self-healed the instant migrations applied — no restart needed, no crash. Transient by design, but any future migration+worker-code deploy will repeat this window. Consider a pre-deploy migrate (or a migrations-ready gate) on the worker service.
- Local `main` checked out and fast-forwarded to `aa17451`.

- Merge with `gh pr merge 17 --merge` (regular merge, keep the 15 commits). This is
  explicitly authorized and WILL deploy to production and run the two new migrations.
- Then verify, in order:
  a. `gh pr view 17 --json state,mergedAt` shows MERGED.
  b. Watch the Railway deploy: use the railway MCP tools (list_deployments /
     get_logs) for both the web and worker services until the new deploy is live.
     If a deploy fails, STOP inside this item: capture the failing log excerpt into the
     notes here, do NOT attempt rollbacks or config changes, and skip to item 2 —
     leave the failure prominently in the completion report.
  c. Confirm migrations applied: deploy logs should show `prisma migrate deploy`
     applying `20260719083000_add_scheduled_post_retry` and
     `20260719090000_scheduled_post_clip_set_null` (or "No pending migrations" on a
     later restart).
  d. Run `npm run smoke:production` and record the result in the notes.
- Afterwards: `git checkout main && git pull` so local main matches.

### - [ ] 2. Reconcile the migration drift on `20260718165517_channel_import_sources`

- Investigate: `git log -p --follow prisma/migrations/20260718165517_channel_import_sources/migration.sql`
  to find what changed after the migration was first committed/applied.
- Default fix, ONLY if the history shows a clear original version: restore the file to
  the content that matches what production/local databases actually ran (the version at
  the commit where it first landed), commit, then verify
  `npx prisma migrate dev --create-only --name drift_probe` no longer demands a reset
  (delete the empty probe migration afterwards if one is created; never run a reset).
- If the history is ambiguous (e.g. the schema change itself differs between versions,
  or the DBs may have run different variants): STOP — write exactly what changed, when,
  and both variants' diffs into the notes here for Jake to decide.

### - [ ] 3. Verify Tier 3 worker environment (verification only — no changes)

- Using the railway MCP tools (list_variables for the worker service), confirm
  `NEXT_PUBLIC_APP_URL` (set, non-localhost) and `META_SYSTEM_USER_TOKEN` (present)
  exist in the WORKER service's environment. Record present/absent per variable in the
  notes — never record values, only presence and (for the URL) whether it's localhost.
- Do NOT set or change any Railway variables; if something is missing, note it as a
  manual action for Jake.
- Check recent production worker logs (get_logs) for `facebook_publish_misconfigured`
  events after the deploy from item 1; note what's found.
- The live Facebook sandbox test (real test Page: one future post, one past-due post,
  one forced failure) is Jake's manual step — list it in the completion report as
  pending, referencing `docs/TIER3_SANDBOX_TEST_CHECKLIST.md`.

### - [ ] 4. Tidy the untracked files

- Default: commit `docs/TIER3_SANDBOX_TEST_CHECKLIST.md` to main (docs commit, then
  push main — authorized as part of this item only, and only after item 1 has merged
  PR #17 so main is already deployed at this commit's content-level; a docs-only push
  is safe). Add `OUTPUTS/` and `CTO.md` to `.gitignore` in the same commit (they look
  like local working artifacts).
- Read `CTO.md` and the checklist fully before acting (never commit or ignore blind):
  if `CTO.md` looks like it was meant to be tracked project documentation rather than
  personal notes, leave it untracked instead of ignoring it and flag the question in
  the notes.

### - [ ] 5. Cleanup PR: graceful denials for forged/stale entity IDs

- The review's remaining low-severity finding: `src/app/actions/schedule.ts` (39-42)
  uses `findUniqueOrThrow` + `assertWorkspaceScope`, so a forged or stale
  `scheduledPostId` (valid UUID, nonexistent or cross-workspace) surfaces as an
  uncaught 500 instead of a clean denial; same pattern in
  `src/app/actions/channel-imports.ts` where `assertWorkspaceScope` throws uncaught.
- Fix on a new branch `fix/graceful-forged-id-denials` (branched from updated main):
  catch the not-found/scope failures and redirect to the page's normal error state
  (mirror how sibling actions handle invalid input — check their redirect patterns).
  Access must stay denied; only the failure mode changes. Add unit tests following
  the mocking pattern in `tests/templates-default-transaction.test.ts`.
- `npm run verify` green, commit, push the branch, open a PR to main titled
  "fix: graceful denials for forged/stale entity ids in schedule and channel-import
  actions". Do NOT merge it — leave it for review.

## Completion report

(append here when done)
