---
description: Decides the order in which to advance deguboard tickets, records it in a Plan, and gets human approval. Use when asked「t12 を進めて」「s3 を全部進めて」「次の 3 件を進めて」「計画だけ立てて」, or to approve a Plan that is awaiting approval. Also use when asked only for the order, such as「次にやるチケットは？」 (shows the order and stops). Advance an approved Plan with dgwork.
argument-hint: "<ticket ID...|Iteration|Epic|next [N]> | <Plan ID>"
---

# Plan (plan)

Decides the order in which to advance several tickets. The plan is recorded in a Plan (`p3`). A Plan holds the order (`after`) and, for each ticket, the scope, approach, and tier (`details`'s `scope`, `approach`, and `tier`). It is created awaiting approval, and it becomes approved with `plan approve` after a human's approval.

## Deciding the target

- Ticket ID (one or more): creates a Plan for those tickets
- Iteration (`s3`) and Epic (`e3`): targets the todos in them (`ticket list --iteration s3 --status todo`)
- `next [N]`: the top N of `ticket list --ready` (one if omitted)
- Plan ID (`p3`): if awaiting approval, get approval with steps 6 and 7 below. If already approved, ask with the "Choosing the next step" section
- If asked only for the order, such as "What is next?", show the proposal from steps 1 to 4 and stop. Do not create a Plan
- No target given: suggests the todos of the active Iteration and confirms them

## Flow

1. Collect the targets: `dg --json --actor agent ticket list --project {{default_project}}` (narrow by Epic with `--epic e3`, or by Iteration with `--iteration s3`)
2. Check dependencies: each ticket's `depends_on`, and the `dependents` (tickets that depend on it) from `dg --json --actor agent ticket show <id>`
3. Find tickets that can start: `dg --json --actor agent ticket list --ready`. These are todos whose dependencies are all done or abandoned (`deps_done`). This does not check the assignee, so avoid tickets whose `assignee` is another user (if only your own, use `--assignee agent`)
4. Make an order proposal. Dependencies come first, and higher priority comes first. Show the tickets that can run in parallel (those that do not depend on each other) together. If a ticket's body has a `## References` section (or the Japanese `## 参考`) and the files written there overlap with another ticket's references, do not run them in parallel. Connect them with `after` (put the one that can advance first in front). Tickets without a references section are not judged for this overlap, and their order is decided by dependencies and priority as before. References are an estimate at filing time, so state the overlapping files in the proposal, and let a human fix it at approval
5. Record it in a Plan awaiting approval (see the "Creating a Plan" section). The result's `data.id` is the Plan's ID
6. Show it to a human and get approval. Show `items` (the Plan's order), `after`, and `details` from `dg --json --actor agent plan show <p>` in a table (include a tier column), and ask with the choices "Approve", "Revise", and "Keep it awaiting approval". If asked to revise, close it with `plan close <p>` and create it again (a Plan cannot be changed after it is created)
7. When a human approves, record the approval with `dg --json --actor agent plan approve <p>` (`approved_by` is the acting actor). Do not approve without a human's approval. Do not start tickets in a Plan that is awaiting approval
8. Advance an approved Plan following `dg guide work`. If you lose track of the Plan's ID, list open Plans with `dg --json --actor agent plan list --status open`, or find it from the `plan` of `ticket show` (the open Plan the ticket is in)

## Creating a Plan

```sh
dg --json --actor agent plan create t12 t13 t14 t15 \
  --after t13=t12 --after t14=t12 --after t15=t13,t14 \
  --scope t13="API for listing and detail. Authentication is not included" \
  --approach t13="Add core command definitions, and HTTP only passes them through" \
  --tier t12=light --tier t13=standard --tier t15=heavy
```

- The order you list them is a guide to the execution order. `--after t15=t13,t14` means "advance t15 after t13 and t14". It is a wait within the Plan only (separate from the ticket's `depends_on`). Tickets that can run in parallel do not write after for each other
- Write `--scope` and `--approach` in one sentence per ticket. Read them back with `details` from `plan show` when starting the ticket
- `--tier` is the ticket's difficulty level, and decides which model implements it (`models.*` in `config.yaml`. It appears as `model` in `dg next`). light: only documents, settings, and wording. heavy: design decisions, data shapes, spanning several packages, or a bug whose cause is unknown. standard: everything else. When in doubt, choose the heavier one. If omitted, it is treated the same as standard
- Tickets that are done or abandoned, and tickets in another open Plan (those whose `plan` in `ticket show` is not empty), cannot be added (`REJECTED`). If one is in another Plan, ask a human whether that Plan may be closed
- If dependencies are missing, fix them with `dg --json --actor agent ticket update <id> --depends-on t12,t13`. `--depends-on` **replaces** the whole list, so specify every dependency you keep (`--label` works the same way). Cycles are refused
- If new work is found while planning, do not advance it on your own. Propose filing it by the steps of `dg guide import`

## About approval

By default, agents can also run `plan approve`. To limit it to humans, add `plan.approve` to `actor.human_only` in `config.yaml` (see `dg guide overview`). If it is refused (`TRANSITION_REJECTED`), ask a human to run `dg plan approve <p>`.

## Principles of progress

- Claim only the one ticket you can advance right now. Do not claim everything first (others, or other agents, could not start)
- Do not start a ticket whose dependency is neither done nor abandoned. If the Workflow writes `requires: [deps_done]` for todo → in_progress, claim is refused (`TRANSITION_REJECTED`). If it does not, wait until the ticket appears in `--ready`, or advance the dependency first
- A Plan's `after` is not checked at claim. Wait until `items[].waiting` in `plan show` (the waits on `after` and `depends_on` that are not finished) is empty

{{choices}}

## Choosing the next step

After approving a Plan (including when an approved Plan was specified), ask with these choices. When you stop while the Plan is still awaiting approval, do not ask.

- **Advance the Plan** (recommended): advance it by the steps of `dg guide work`, specifying the Plan's ID (if a Skill is available, `/dgwork p3`). The one advancing starts from the Plan's record (`plan show`)
- **Stop here**: another session advances it by specifying the Plan's ID

When you only show the order, ask with "Make a plan" (the steps of `dg guide plan`; if a Skill is available, `/dgplan next <N>`), "Assign" (if there are unassigned tickets, the steps of `dg guide assign`; if a Skill is available, `/dgassign`), and "Stop here".
