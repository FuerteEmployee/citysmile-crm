---
name: lead-followup-playbook
description: Company-specific guidance on qualifying leads and deciding what follow-up action to take next, based on this CRM's actual lead statuses. Use when the user asks how to handle, qualify, prioritize, or follow up on a lead, or asks "what should I do with this lead."
---

# Lead Follow-up Playbook

> **TODO for the team:** the statuses and pipeline flow below are read
> directly from this CRM's actual Lead Status list, but the follow-up
> *timing/cadence* section is a placeholder — fill in your team's real
> process before relying on this Skill for real decisions.

## This CRM's actual lead statuses

- **hot** — a lead that's actively engaged and close to converting.
- **FOLLOWUP** — needs another touch from sales; not yet hot, not stalled.
- **PENDING** — needs attention. Note: this status is also set
  *automatically* by the system the moment a lead's reminder fires and
  hasn't been acted on — treat a lead sitting in PENDING as "something was
  supposed to happen and may have been missed," not just "medium priority."
- **COMPLETE** — the lead's cycle is finished (converted or closed out).
  Never suggest re-engaging a COMPLETE lead without the user explicitly
  asking to reopen it.

## Priority order when the user asks "what should I focus on"

1. **PENDING** leads first — especially ones where a reminder fired
   recently (check the lead's Activity Log tab for "Reminder notification
   sent" entries) and nothing happened after.
2. **hot** leads next — these are closest to closing; don't let them go
   cold waiting on a lower-priority task.
3. **FOLLOWUP** leads — steady cadence, not urgent, but shouldn't be
   ignored for weeks.
4. **COMPLETE** — no action needed.

## Follow-up cadence — PLACEHOLDER, replace with your team's real process

<!-- Fill in: how many days after first contact before a follow-up?
     How many missed follow-ups before a lead is marked lost/junk?
     Different cadence for different lead sources (Meta ads vs website
     form vs referral)? -->

- Suggested default until specified otherwise: follow up within 2 business
  days of a lead entering PENDING, and no more than 5 business days between
  touches on a FOLLOWUP lead.

## What a good follow-up action looks like

When the user asks the assistant to help follow up on a specific lead:
1. `search_records`/`verify_record` (module: `lead`) to pull the lead's current details, status, and source.
2. Check its Notes and Activity Log (via `search_records` on `note`, filtered by `rel_id`) for what's already been tried.
3. Suggest a concrete next action (a call, a specific message — see the `customer-messages-gujarati` Skill for drafting the actual message text) rather than a vague "reach out."
4. If asked to actually log the outcome, use `create_record` (module: `note`) or `update_record` (module: `lead`, to change status) — never silently decide the lead's status without the user confirming the outcome.
