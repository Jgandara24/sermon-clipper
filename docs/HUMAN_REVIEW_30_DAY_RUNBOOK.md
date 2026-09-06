# The 30-day human-only review phase

This is the phase the whole agentic-editor plan is measured against. Everything P4 through P7
later claim about a machine reviewer is judged against decisions a person made in this window, so
the window has to be a fact rather than a recollection: an explicit start, a recorded authority,
and a length nothing shortens.

Three rules hold for the whole phase.

1. **The clock cannot be backdated.** `startedAt` is the moment `npm run program:start` ran. There
   is no parameter for it.
2. **A pause extends the phase; it never shortens it.** Paused time is subtracted from elapsed
   time, so a week's pause moves the thirtieth day out by a week.
3. **Thirty full days is fixed.** Product-owner Decision 2 supersedes Addendum S17's permission to
   compress the phase on strong early evidence. A good first fortnight does not end it early.

---

## Before you start: the sandbox proof

The clock starts only after the system has been proved end to end, and the last step of that proof
is publishing one known clip to one known Page. That publish is the only time before the phase
that `AUTOMATIC_PUBLISHING_ENABLED` is true, and it must release exactly one row.

Run the steps in order. **If any step refuses, stop — do not enable the switch.**

### 1. Keep the global switch off

```sh
# Confirm. This is the state every step below assumes.
echo $AUTOMATIC_PUBLISHING_ENABLED   # must be false or unset
```

Nothing in P2.4's coordinator records export work while the switch is false, so a slot cannot
acquire a render behind your back during this sequence.

### 2. Create one manual pinned render, for one scheduled slot

Use the normal editor export path against a clip that is bound to a scheduled slot. The render must
finish `SUCCEEDED`, pass render QC, and write a `qcChecksum` equal to its output file's checksum.

### 3. Record an exact human `ACCEPT`

Open `/app/operator/review`, play the file, and accept it. The decision is recorded against four
identity facts — clip, edit version, the slot's bound export, and the QC-time checksum — and
delivery will later require all four to still match. Do not edit the clip or re-render after this;
either would invalidate the acceptance, correctly.

### 4. Prove that exactly one row would publish

```sh
npm run program:sandbox-proof -- --post <scheduled-post-uuid>
```

This is a read-only dry run. It scans exactly the rows the publisher would scan, judges each one
twice — as it stands, and with the global switch simulated on and **nothing else changed** — and
reports which rows the switch alone is holding back.

It passes only when that set is exactly your intended row. It refuses when:

| Refusal | What it means |
|---|---|
| `global_switch_already_enabled` | Publishing is already on. The dry run is a claim about what turning it on *would* do, so it is meaningless now — and rows may already have gone out. |
| `intended_row_not_switch_only` | Your row would still fail for some further reason, which the message names, or it is not due at all. |
| `other_rows_would_publish` | Another due row would go out alongside yours. The message lists them. |

Every run is recorded as an operational event (`sandbox_proof_passed` / `sandbox_proof_refused`),
so the decision to enable is auditable afterwards.

**If the census is not exactly the intended row, do not enable.** Deal with the other rows first —
block them, or let them fail for a reason you understand — and run the proof again.

### 5. Enable the switch, publish, and verify

Set `AUTOMATIC_PUBLISHING_ENABLED=true` and let the publisher run. Then check:

- the slot is `SUCCEEDED` and carries a `facebookPostId`;
- the post on the Page is the file you accepted;
- no other slot published.

Leave publishing enabled **only if every part of the eligibility path passed**. If anything
surprised you, set it back to false before doing anything else.

---

## Starting the clock

```sh
npm run program:evidence          # what the database can prove, and what it cannot
npm run program:start -- --email you@example.com
```

The start is refused unless the database itself can prove all three preconditions. It does not read
a checklist; it goes and finds the rows.

| Precondition | The row that proves it |
|---|---|
| Exact playback, review writes, QC, and delivery gating | One slot whose bound export is `SUCCEEDED`, passed QC against exactly its own file, and carries a human `ACCEPT` of all four identity facts. That single row is all four at once. |
| One atomic P2.7 replacement | One `REPLACE` decision. Only `replaceScheduledClip` can write one, so its existence is the proof. |
| The sandbox publication | That same accepted slot, `SUCCEEDED` with a `facebookPostId`. Checked on the one row so that "published" and "published the accepted export" cannot come from two different slots. |

The starter must hold the platform-operator marker. The phase records who is answerable for it, and
across churches that is the only person who reviews at all.

The evidence found at start time is written into the program row's `startEvidence`, so the record
stays self-describing long after the rows it names have been retained away.

---

## During the phase

```sh
npm run program:status
```

Two numbers decide whether the phase is still valid, and they are printed first:

- **Elapsed days.** Whole days the clock has actually run, with every pause already subtracted.
  Day 29 is held; the minimum is served at day 30.
- **Agent rows.** Must be zero. A reference phase with machine decisions inside its window is not a
  reference for judging machine decisions, and the status report exits non-zero if any appear.

The same day count is shown at the top of `/app/operator/review`, because a clock that has quietly
stopped is the failure worth noticing while you work.

Also reported: the decision mix (accept / revise / replace) and how long renders waited for a
person, measured from the bound export finishing. Latency carries its own denominator — retention
deletes exports, and a decision whose render is gone still counts as a decision even though it can
no longer be timed.

---

## Rollback

```sh
npm run program:pause -- --reason "a caption defect reached a church"
npm run program:resume
```

Pausing the program pauses delivery with it: `PAUSED` refuses every slot in the delivery
eligibility module, ahead of everything except the global switch. It is one act that stops
publishing everywhere without touching a workspace's settings one at a time.

**Elapsed history is never erased or shortened.** A pause holds the count exactly where it stands
and banks the interval, so resuming moves the thirtieth day out by exactly as long as the pause
lasted. The program cannot be started twice, and cannot be restarted after a pause — a restart
would be a way to erase elapsed days, which is the one thing this record exists to prevent.

`NOT_STARTED` deliberately does **not** refuse delivery. The sandbox proof publishes one row before
the clock starts, and a rule that demanded an `ACTIVE` program would make the evidence the start
requires impossible to collect. The global switch is what holds that window shut, and it is off for
all of it.

---

## At day 30

Nothing happens automatically, and that is the design. The minimum being served means the next
phase may be *considered* — not that a person has stopped being the authority. Delivery still
requires a human `ACCEPT` of the exact render, and only P7, deployed and explicitly changed, moves
that. The status report keeps saying so after day 30 for exactly that reason.
