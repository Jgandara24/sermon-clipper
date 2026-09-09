# Operator transcription alerts

When the app selects the backup transcription provider, it opens the existing
`transcription_provider_fallback` hold. The master account now shows these open holds
across churches. The operator review queue links each alert to its service.

## Behavior

- Only users with `isPlatformOperator` can read the alert count and service list.
- The banner checks when it opens, once per minute, and when the window gets focus.
- Each request has a 15-second timeout. A failed check keeps the last count, shows a
  failure notice, and permits the next check.
- A 401 or 403 response clears the old count.
- Retries use the existing hold. The alert does not create another hold or resolve one.
- Resolved holds and deleted services do not appear in the open alert list.
- The API returns only a count and uses `Cache-Control: private, no-store`.
- The list reads church names, service names, IDs, and dates. It does not read provider
  error metadata.

## Limits

This is an in-app notification. It sends no email. The app must be open, and browser
timer limits can delay checks in a background tab. Open the review queue to refresh
its service list.

The alert reports that the backup was selected. It does not prove that the backup
finished, identify the exact primary-provider error, or check the account credit
balance before a job. Existing publishing holds remain in force.

The local browser tests cover cross-church alerts, duplicate retries, a stalled
request, failed-refresh recovery, hold resolution, and unauthorized access. They use
local fixtures and do not submit audio or run production processing jobs.
