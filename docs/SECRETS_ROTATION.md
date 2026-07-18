# Secrets Rotation & Clean-Room Runbook

Why this exists: production credentials were kept in a Dropbox-synced working tree, some keys
were shared with a sibling product, and two credentials were pasted into chat logs during launch
night (see `LAUNCH_NIGHT.md`). This runbook rotates everything onto Sermon Clipper–dedicated
credentials and moves the local storage of secrets out of cloud-synced folders. It contains no
secret values and is safe to keep in the public repo.

Rotation order for each credential is always: **create new → update Railway → redeploy/verify →
revoke old**. Never revoke first.

## 0. Ground rules going forward

- Railway service variables are the **single source of truth** for production secrets.
- No production secret may live under `~/Dropbox/` (or any cloud-synced folder). If a local
  copy is operationally necessary, keep it at `~/.config/sermon-clipper/ops.env`, mode `0600`.
- Every provider key is **dedicated to Sermon Clipper** — no sharing with Pulpit Engine or any
  other product, in either direction.
- Secrets are never pasted into chats, issues, or prompts. If one is, it is rotated the same day.

## 1. Anthropic

1. In the Anthropic console, create a new API key named `sermon-clipper-prod` (ideally in a
   dedicated workspace so spend is tracked separately from Pulpit Engine).
2. Update `ANTHROPIC_API_KEY` on the Railway **worker** service; redeploy.
3. Verify: run an upload through ANALYZE, or check the Operations page for a successful
   `analysis` event with provider `claude`.
4. Revoke the old shared key **from Pulpit Engine's side too** if that product keeps using it —
   Pulpit Engine gets its own new key. The shared key dies.

## 2. Resend (email clean-room)

1. Add a dedicated sending domain for this product in Resend (e.g. `send.sermonclipper.com` —
   a subdomain of this product's own domain, **not** `pulpitengine.com`), add the DNS records,
   wait for verification.
2. Create a new API key scoped to that domain, named `sermon-clipper-prod`.
3. Update on Railway (web service): `RESEND_API_KEY`, `AUTH_EMAIL_FROM`,
   `NOTIFICATIONS_FROM_EMAIL` (e.g. `login@send.sermonclipper.com` / `notify@send.sermonclipper.com`).
4. Verify: request an OTP on production and confirm delivery + SPF/DKIM pass in the received
   headers.
5. Revoke the old key. Remove Sermon Clipper senders from the pulpitengine.com domain config.

## 3. Stripe

1. Dashboard → Developers → API keys → **Roll** the secret key. Update `STRIPE_SECRET_KEY` on
   Railway immediately (rolling gives a grace window — use it).
2. Dashboard → Webhooks → the production endpoint → **Roll secret**. Update
   `STRIPE_WEBHOOK_SECRET` on Railway.
3. Verify: `npm run smoke:production -- --base-url <prod-url>` (checks webhook signature
   enforcement), then send a test event from the Stripe dashboard and confirm a 2xx.

### Going live (separate step, after rotation)

1. Complete Stripe account activation for live mode.
2. Create live-mode Products/Prices for Starter ($15) and Pro ($29); put the live `price_...`
   ids in `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` on Railway.
3. Create a live-mode webhook endpoint pointing at `/api/stripe/webhook`; set its secret.
4. Swap `STRIPE_SECRET_KEY` to the live key; redeploy; run one real checkout with a real card
   and refund it; confirm the plan flip + included-minute grant on the workspace.
5. Close the final launch-evidence item: `npm run launch:phase8 -- --base-url <prod-url>` → 23/23.

## 4. Object storage (S3/R2)

1. Create a new access key for the bucket user (R2: new API token scoped to the bucket;
   AWS: new access key on the IAM user).
2. Update `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` on **both** Railway
   services (web + worker); redeploy.
3. Verify: upload a small video end-to-end; confirm thumbnail renders (signed URL → presigned
   object URL redirect).
4. Delete the old access key.

## 5. Railway

1. Revoke the account token that leaked during launch night (Account Settings → Tokens).
2. Re-authenticate the CLI with `railway login` (browser flow), or create a **project-scoped**
   token if CI/automation needs one — never an account-scoped token in an agent context.

## 6. App-internal secrets (cheap to rotate, do them while you're in there)

- `MEDIA_URL_SECRET`: generate a fresh 32+ char random string (`openssl rand -base64 48`).
  Outstanding signed media links die immediately — they're short-lived by design, so rotate any
  time except mid-demo.
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`: rotate the same way; only invalidates in-flight server
  action payloads across a deploy boundary.

## 7. Get secrets out of Dropbox

After all rotations are verified:

1. `rm .env.production.local` from this working tree (it is gitignored but Dropbox-synced —
   the file, and every synced historical version of it, holds only **dead** keys once rotation
   is done; that's why rotation comes first).
2. In Dropbox's web UI, purge the file's version history for good measure.
3. If a local ops env file is still wanted for scripts, recreate it at
   `~/.config/sermon-clipper/ops.env` (mode `0600`) and use
   `set -a; source ~/.config/sermon-clipper/ops.env; set +a` when needed — or skip the file
   entirely and use `railway run -- <cmd>`.

## 8. Final verification

- `npm run smoke:production -- --base-url <prod-url> --commit-sha <sha>` passes.
- `/api/health` returns ok (env checks, DB, migrations, worker heartbeat).
- One full production flow: OTP login → upload → transcript → clips → approval → export →
  download.
- Old keys confirmed revoked in each provider dashboard (attempting to use one fails).
