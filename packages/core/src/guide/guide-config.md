---
description: Explains the deguboard settings (config.yaml) to a human - what each item means, its current value, its default, and its scope (team or personal) - and changes them when a human asks. Recommends a value only when the repository gives a basis for it. Shows before → after and team or personal (--local) for each item, and writes with dg config set only after a human approves. Use when asked「設定を説明して」「commit.mode って何？」「設定を変えて」「おすすめの設定は？」.
argument-hint: "[key...] (followed by what to explain or change)"
---

# Settings (config)

Explains the settings of deguboard (`config.yaml`) to a human, and changes them when a human asks. Reading and explaining proceed without approval. Every change is written only after a human approves its before → after, with `dg config set`. Do not edit `config.yaml` or the personal settings file (`deguboard-local/config.yaml`) directly. The perspectives of the retrospective (`retro.perspectives`) are not written here: they go to `dg retro` (see "The perspectives of the retrospective" below).

## Deciding the target

- The keys after the Skill call (`/dgconfig commit.mode work.parallel`), or the items named in the instruction, are the targets. A group (`models`, `actions`) means every item under it. The instruction says whether to explain or to change, and gives the new value
- A question ("what is `commit.mode`?", "what do you recommend?") asks for an explanation: explain and stop, without proposing to write. Change only when a human asks for a change
- A name that is not among the `fields` of `config show --fields`: say so and show the keys that are close. Do not guess
- No target given: show the items whose value differs from the default (key, value, default, scope) and the groups of the rest, and ask what to explain or change, with the choices below

{{choices}}

## Reading

`dg --json --actor agent config show --fields` returns everything this guide reads (it does not write):

- `fields`: every leaf item, with its `key`, `type`, `options`, `option_descriptions`, `summary`, `description`, `example`, `empty` (what an empty value does), `default`, `scope`, and `clears_to_default`
- `config`: the value in effect, read in the order personal > team > default. `team`: the team's value, without the personal overrides. `local`: the personal overrides on this machine (key → value). `defaults`: every default
- `retro.perspectives` is not in `fields`. Its value is in `config`, and its default in `defaults`

## Explaining

Answer in the language the human used, in plain words. For each target item, give:

- **Meaning**: what the item decides and which commands or behavior it changes, from `description`. For an item with choices, what each choice does (`option_descriptions`); for an item that can be empty, what an empty value does (`empty`); for a number, the allowed range
- **Current value**: the value in effect (`config`). When `local` has the key, say that it is a personal override on this machine, and give the team's value (`team`) too
- **Default**: `default`, and whether the current value is the default
- **Scope**: `team` is decided only by the team's `config.yaml`, which everyone shares through the data branch. `local` can also be overridden per person with `--local` (the personal file is not in Git, and is never committed or pushed)
- **Recommended value**: only when the repository gives a basis for it, and always together with that basis (the file and what it says). For example, the check command that the repository's task file or agent instructions name is a basis for `actions.test`, and the remote's default branch is a basis for `git.base_branch`. When the repository gives no basis, say that there is no recommendation. Do not recommend from general preference, and do not present the default as a recommendation

For several items, use one table with the columns item, meaning, current, default, and scope, and add the recommendations with their basis below it. Explaining writes nothing.

## Changing

1. **Read**: `config show --fields`. Keep the current value of each item to change as "before" (the team's value from `team`, the personal override from `local`)
2. **Decide where to write, per item**: the team's `config.yaml` (changes the value for everyone) or the personal settings (`--local`: only this person, on this machine). An item whose `scope` is `team` can only be written to the team's file. For an item whose `scope` is `local`, use what the instruction says; if it does not say, put the question in the approval of step 3. When the team's value changes while `local` has the key, say that the value in effect on this machine stays the personal one
3. **Approval**: show a table with one row per item (item, before, after, where: team or personal (`--local`), and what the change affects, from `description`), and ask with choices. Ask for every change, even when the instruction settles the value: a setting changes how every later command behaves, for the whole team when it is written to the team's file. Write nothing until approval is obtained
4. **Write**: only the approved rows, one call per item: `dg --json --actor agent config set <key> <value>`, with `--local` for the personal settings. To remove a value and return to the default (with `--local`, to the team's value), use `config unset <key>`. How values are written (lists, empty values, numbers) is in `dg config set --help`
5. **When refused**: on `TRANSITION_REJECTED` (the operation is in `actor.human_only`), do not retry in another way; give the human the exact command to run (without `--actor agent`). On `VALIDATION_FAILED`, show `error.message` and ask for the value again; do not pick another value yourself
6. **Report**: for each item, before → after, where it was written, the value in effect now, and the `warnings` of the result

Moving the data to another remote or branch (`git.data_remote`, `git.data_branch`) is more than one write: follow the "Data in another repository" section of `dg guide overview`.

## The perspectives of the retrospective

`retro.perspectives` is nested by perspective (ID → name, question, and the approved metric definitions), and `config set` refuses it. Explain it by reading it from `config` (each perspective's ID, name, question, and how many metrics it has). Send every change to `dg retro`: `dg retro perspective` adds a perspective or changes its name or question, `dg retro remove` removes a perspective or one definition, and `dg retro metric` records a metric definition. Run them by the "Perspectives" section of `dg guide retro`, with the same approval of before → after as in "Changing". Metric definitions are proposed and approved in the retrospective itself, so do not make them up here.

## Choosing the next step

This guide asks no choices of its own for the next step. It ends with the explanation or the report. If the human asks for a change after an explanation, continue with "Changing". To propose metrics for the perspectives of the retrospective, name `dg guide retro` (if a Skill is available, `/dgretro <S>`) in one line, and do not start it here.
