---
description: Breaks down the results of a conversation (design discussion, bug investigation, review findings, etc.) or a plan or design document into deguboard tickets, and files them in one batch after approval. Fixes or splits existing tickets when that is enough. Use when asked「起票して」「チケットにして」「チケットを直して」, or when proposing to turn settled requirements into tickets.
argument-hint: "[target (plan name, document path, or ticket ID)]"
---

# Filing (import)

Turns the requirements, research results, and review findings settled in the conversation into tickets.

## Deciding the target

- Plan name or document path: targets that plan or document (a design doc or research results)
- Ticket ID: targets fixing or splitting that ticket (fix it with `ticket update`, and to split it, file a new ticket and narrow the original's scope)
- No target given: targets the results of this conversation that are not yet tickets. First show what is targeted and what is held back

## Flow

1. When the requirements are settled, **propose** turning them into tickets. Do not file on your own. Show the decomposition (title, summary, acceptance criteria, dependencies, Epic) in a table, and get approval with the choices "File after approval", "Revise", and "Cancel"
2. For one ticket: `dg --json --actor agent ticket create "<title>" --created-by human --summary "<summary>" --acceptance "<criterion>" --acceptance "<criterion>" [--epic e3] [--depends-on t9,t10] [--priority high] [--assignee agent]`
3. For several: write a YAML draft to one file and run `dg --json --actor agent ticket import <file>`. IDs are assigned together in one commit
4. Read the IDs from the result's `data` and report them to a human

## Creator and assignee

- The creator (`created_by`) is the person who instructed or approved the filing, or the AI that filed without a human's check. When filing on a human's instruction or approval, pass `--created-by human` so the user is the creator. In an automatic step that files without a human's check, do not pass it (it becomes `<user>/agent`)
- The assignee (`assignee`) is optional. If you will continue advancing it, use `--assignee agent`. If a human will advance it, use `--assignee human`. Claim overwrites it with the claiming actor

## Draft format (import)

```yaml
- key: schema # Temporary key used only inside this draft
  title: Decide the schema
  summary: …
  acceptance: [criterion 1, criterion 2] # Goes into the checklist of the body template
  epic: e3 # Existing Epic. Optional
  iteration: s3 # Existing Iteration. Optional
  priority: high # low / medium / high. Default is medium
  labels: [backend]
  created_by: human # Creator. If omitted, the acting actor (for you, <user>/agent)
  assignee: agent # Assignee. Optional
  fields: { estimate: 3 } # Optional fields defined by the Workflow's fields
- key: api
  title: Implement the API
  depends_on: [schema] # Temporary key or existing ID (t9)
  body: | # Whole body instead of summary. ## 概要 is the summary and ## 受け入れ条件 the acceptance criteria; keep these headings exact
    ## 概要

    …

    ## 受け入れ条件

    - [ ] …
```

- In an unquoted value, "a space followed by #" and everything after it become a YAML comment and are dropped. Write a value containing `#` (such as `#/config`) inside quotes, or in the body with `|`
- In the body items (title, summary, acceptance, body), a trailing comment on an unquoted value is refused (the error message says how to fix it). Trailing comments and comment-only lines are allowed in other items

## Priority criteria

Choose `priority` by these criteria (they can be changed in `priority` of `config.yaml`).

- high: {{priority.high}}
- medium (default): {{priority.medium}}
- low: {{priority.low}}

## How to write a good ticket

- The title is one line where "what is done, and how" is clear at a glance. Write it by the result, not the means of implementation
- The body has `## 概要` (summary) and `## 受け入れ条件` (acceptance criteria; a `- [ ]` checklist). Keep these headings as written; dg reads them literally. `dg lint` flags a missing section and a section with no items
- Write the references you looked up while filing in an optional `## 参考` (references) section. It is passed to the agent that works the ticket. It also helps the planner (`dg guide plan`) connect tickets whose reference files overlap with `after` instead of running them in parallel, and gives humans (and the reviewer) a filing-time estimate to compare with the PR. Write the file paths you expect to change as an estimate. You may write requirement IDs, ADR numbers, related ticket IDs, file paths, function names, and command names. Do not include line numbers or copies of docs (they go stale quickly), and do not write how to change it (the means of implementation). The section is optional, and `dg lint` does not flag its absence
- Acceptance criteria are sentences whose truth can be judged by looking at the PR or the deliverable
- Add a requirement document or ADR as an acceptance criterion only when the decision needs a migration to reverse, is a promise to users or a data shape, is a choice of structure or technology, or rejects a plausible alternative. Otherwise, make the criterion show the promise through tests and comments
- One ticket should be sized to finish in one PR. If it is large, split it and connect the parts with `depends_on`
- When a ticket reaches 7 or more acceptance criteria, recommend splitting it (in deguboard's own development, 9 of 10 tickets with 7 or more criteria needed rework). If you do not split it, show a human the reason to proceed with one ticket
- Work that needs no PR (data maintenance, checks, research) says so in the summary. Make its acceptance criteria sentences whose truth can be judged from data or a report
- To group tickets by purpose, use an Epic (see existing ones with `dg --json --actor agent epic list`. If there are none, propose creating one)
- For optional fields (the Workflow's `fields`), use `--field key=value`. For the definitions, use `dg --json --actor agent workflow show <id>`

## What not to do

- Do not create a dependency cycle (it is refused at creation)
- Do not add a ticket to a closed Epic (it is refused)
- Do not change `status` without starting work. A filed ticket stays todo
- When the result has `provisional: true`, do not tell a human the ID as final (see `dg guide overview`)

{{choices}}

## Choosing the next step

When you have reported the result (including when you stopped), ask with these choices.

- **Assign** (recommended): put the filed tickets into Iterations and Epics by the steps of `dg guide assign` (if a Skill is available, `/dgassign <ID...>`)
- **Make a plan**: if no assignment is needed, decide the order of advancing by the steps of `dg guide plan` (if a Skill is available, `/dgplan <ID...>`)
- **Stop here**
