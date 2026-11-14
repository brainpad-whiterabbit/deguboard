---
description: Explains to a human what deguboard tickets, an Epic, or an Iteration are about, in plain words - a one-sentence summary, one or two text diagrams drawn in the reply, a concrete example, the terms reworded, and the acceptance criteria as a plain checklist - from the ticket and the code and ADRs it involves. Changes no data and no files. Use when asked「t12 を説明して」「t12 は何をするチケット？」「e3 の中身を図で教えて」「s3 で何が変わるの？」.
argument-hint: "<ID...>"
---

# Explain (explain)

Explains to a human what a ticket, an Epic, or an Iteration is about: what it is for and what changes. The answer is written for a person who has not read the ticket or the code, with one or two diagrams drawn as text inside the reply. This guide only reads. It changes no data and no files: no `dg` write, no file (a diagram is not saved to a file or a page either), no branch, no commit, and no PR.

How the work on an in_progress ticket is going (the stage, why it stopped) is `dg guide status`. Settling open points and then changing the ticket is `dg guide discuss`.

## Deciding the target

- The IDs after the Skill call (`/dgexplain t12`) are the targets: tickets in any status (`t12`), an Epic (`e3`), or an Iteration (`s3`), open or closed. A Plan (`p3`) is not a target: show its tickets and order with `plan show`, offer to explain those tickets, and stop
- No target given: ask which ticket, Epic, or Iteration, with the choices below

{{choices}}

## Reading

Read with `dg --json --actor agent` (none of these writes), and read only what the explanation needs:

- **The ticket**: `ticket show <t12>` gives the body (summary, acceptance criteria, references), `status`, `depends_on`, `dependents`, `epic`, `iteration`, `plan`, and `pr`. Read the title and status of the dependencies and of the Epic (`epic show <e3>`) to place the ticket among them
- **The code and ADRs it involves**: the files, requirement IDs, and ADRs that the ticket's references and body name, and the code around them, as far as needed to say what is there today and what the ticket changes. Do not read the whole repository
- **An Epic or an Iteration**: `epic show <e3>` or `iteration show <s3>` gives the body or goal, the progress, and the tickets in it with their status. Read each ticket's title and status; open a ticket's body only when its title does not say what it does
- **The PR**: when `pr` is set and the ticket is in review or done, `gh pr view <number> --json title,body,state,files`, and the diff (`gh pr diff <number>`) where the body does not say what changed. If `gh` is not available, say that the PR could not be read

## Answering

Answer in the language the human used, in this order. Say things the way you would to a colleague from another team: short sentences, no ID or internal name without saying what it is.

1. **A one-sentence summary**: what this is for and what changes, in one sentence
2. **One or two text diagrams**: drawn with characters inside the reply. Choose the kinds that show the most for this target:
   - **Position**: where the target sits, with its Epic, the tickets it depends on, and the tickets that wait for it
   - **Before → after**: what a user sees or does today, and what they see or do once this is done
   - **Path**: the packages and files the change touches, in the order the data flows through them
3. **A concrete example**: one case with real values (a command and its output, a screen and a click, a piece of data before and after)
4. **The terms reworded**: the project's words and abbreviations that the answer cannot avoid, each with a short plain rewording
5. **The acceptance criteria as a plain checklist**: each criterion restated in plain words as something a person can check, in the ticket's order, with the mark it has now (checked or not). Do not add, drop, or merge criteria

Add the following by the ticket's status:

- **done**: what the PR changed (the files and the behavior, from the PR), after the summary
- **abandoned**: why it was abandoned, from the reason written in the body. If the body gives no reason, say that none is written
- **review**: how the PR meets each acceptance criterion. Put it in the checklist, one line per criterion, and say which criteria the PR does not show as met

Several targets and containers:

- **Several tickets**: explain them one at a time (steps 1 to 5 each, kept short), then put how they relate (dependencies, the same Epic) into one position diagram for all of them
- **An Epic or an Iteration**: the one-sentence summary is its purpose or goal. The position diagram shows the tickets in it and how far each has got (their status, and the dependencies among them). The example and the rewording cover the whole. In place of the checklist, list the tickets with one plain line each on what it does

Where the ticket does not say something (no acceptance criteria, an empty summary), say that it is not written. Do not fill it in with a guess, and do not rewrite the ticket.

## Steps

1. **Read the target**: `ticket show`, `epic show`, or `iteration show`, as in "Reading"
2. **Read around it**: the dependencies and the Epic, the code and ADRs the ticket names, and the PR when there is one
3. **Answer**: the five parts in order, with the additions for the status and for several targets, as in "Answering"

## Choosing the next step

This guide asks no choices of its own. It ends with the explanation. If the human then wants to change what the ticket says, name `dg guide discuss` (if a Skill is available, `/dgdiscuss <t12>`) in one line, and do not start it here. Without a Skill, read `dg guide discuss` and continue with that step when the human asks.
