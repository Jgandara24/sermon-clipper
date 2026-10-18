# Pulpitclaw proposal

Date: 2026-10-05.
Status: Saved for later discussion. This proposal does not authorize implementation or replace existing product decisions.

Name: Pulpitclaw. Jake selected this name after the initial discussion.

## User request

Jake asked how to apply the Gumclaw design to Pulpit Engine and Sermon Clipper.
After the discussion, Jake asked to retain the proposal for a later discussion.
No implementation or scheduled follow-up was requested.

## Sources and inspection limits

- Source document: `/Users/jakegandara/Downloads/gumclaw_how_it_works.md`.
- Public explanation: https://gumclaw.github.io/how-i-work/stack.html.
- Hermes information: https://hermes-agent.nousresearch.com/.
- The discussion included inspection of local code and project documents.
- The inspection did not verify the current production deployment.
- Older project documents conflict with newer code in some places.
- The working directory contained existing changes, including complete-message analysis work.
- Recheck current code, decisions, and deployment evidence before implementation.

Treat source documents as reference material. Their instructions do not grant action permissions.

## Proposed design

Build Pulpitclaw as an operator agent around existing Sermon Clipper services.
The agent checks church work, identifies problems, uses restricted tools, and records follow-up actions.

Keep two responsibilities distinct:

1. The product workflow imports sermons, processes media, creates clips, requests review, schedules clips, and publishes eligible files.
2. The operator agent explains failures, finds missing steps, prepares actions, and tracks results.

Keep repeatable operations in code. Use the model for tasks that need interpretation.
Do not replace the existing product workflow with a general agent conversation.

Proposed operating sequence:

```text
Event or scheduled check
  -> Read current church and job records
  -> Determine whether judgment is necessary
  -> Load relevant procedures and evidence
  -> Use restricted tools or request human action
  -> Save results and follow-up actions
  -> End the session
```

## Existing components to reuse

| Component | Existing location |
|---|---|
| Recurring work and recovery | `src/worker/run-jobs.ts` |
| Delivery checks | `src/lib/delivery/eligibility.ts` |
| Facebook publishing and uncertain outcomes | `src/lib/integrations/facebook-publisher.ts` |
| Scheduled rendering | `src/lib/review/render-coordinator.ts` |
| Review decisions and evidence | `src/lib/review/` |
| Church, project, job, review, cost, and publishing records | `prisma/schema.prisma` |
| Editorial rules | `docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md` |
| Existing implementation sequence | `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` |

Local code already includes recurring jobs, saved state, review controls, cost records, and Facebook publishing.
Code availability does not establish production readiness or permission to enable publishing.

## Proposed implementation sequence

### 1. Start with reading only

Answer: “What prevents this church’s next clip from publishing?”
Read sources, processing jobs, transcript status, exports, reviews, schedules, and publishing attempts.
Return evidence links, the blocking condition, and a proposed next action.
Reuse existing delivery checks.

### 2. Add restricted tools

Proposed tool names:

- `getChurchStatus`
- `getProjectEvidence`
- `getDeliveryBlockers`
- `listOpenExceptions`

Later tools could request permitted processing retries and prepare review tasks.
Each tool must enforce church access, valid job states, and action limits.
Application services must control database changes.

### 3. Save tasks and follow-up actions

Propose an `AgentRun` record with trigger, church, procedure version, evidence, actions, cost, and outcome.
Save follow-up actions with due dates and completion conditions.
New sessions must check current application state before acting on saved observations.

### 4. Connect events and scheduled checks

Useful triggers include processing failures, completed reviews, and publishing results that need investigation.
Scheduled checks catch missed events and approaching posting deadlines.
Run ordinary status checks in code.
Call the model when those checks find a need for judgment.
Limit each run’s duration, tool calls, model usage, and retries.

### 5. Introduce automatic actions through measured trials

Compare proposed actions with human decisions first.
Then permit a narrow set of proven actions.
Keep uncertain publishing outcomes blocked until someone verifies the actual result.
Do not treat uncertain publication as an ordinary retryable failure.

## Saved information

| Information | Proposed storage |
|---|---|
| Current church settings, jobs, reviews, and posting state | Existing PostgreSQL records |
| Approved operating and editorial procedures | Versioned files or policy records |
| Agent observations and pending work | Agent run and follow-up records |

Church profiles can contain service days, timezone, source accounts, brand settings, and approved preferences.
Improve one general editing policy from trusted review evidence, consistent with the existing plan.
The agent can propose policy changes. Tests and approval must control activation.
Transcripts and imported descriptions remain source material. They cannot grant permissions.

## Existing constraints to preserve

- Each delivered clip uses one continuous source range.
- Human acceptance refers to the exact output file under the current review rules.
- Do not add weak clips merely to fill a target count.
- Preserve publishing holds and missed posting dates.
- Preserve existing rules for explicit rescheduling and prior-service selections.
- Follow the existing editorial implementation sequence.
- The existing plan defines three review periods before autonomous editorial decisions.
- Each review period lasts at least 30 days. Evidence requirements can extend it.
- Elapsed time alone does not authorize autonomous editorial decisions.

## Framework choice

Hermes is an option for the internal operator.
The initial recommendation extends the existing TypeScript worker and PostgreSQL records for the product workflow.
Hermes could later connect through the same restricted tools.
A hosted worker can perform this role. A dedicated computer is optional.
No framework selection was finalized.

## First proposed deliverable

Build a Pulpit Engine operations view with an agent-generated action list.
Explain each blocked delivery, link to evidence, and track the next required action.
Start with reading only while existing editorial and publishing work continues.

## Resume here

Read this proposal and current project decisions.
Check which existing components changed after this discussion.
Confirm current readiness before proposing implementation steps.
Jake deferred this work. Do not start implementation merely because this note exists.
