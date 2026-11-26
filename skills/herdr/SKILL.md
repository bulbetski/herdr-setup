---
name: herdr
description: Work inside Herdr and herdr-core (hc). Use when the user mentions Herdr, hc, another machine added to hc, or asks to hand a task to another agent (a review, a test run, a helper) and get its report back, or to start a task (an issue key such as ABC-123, or a described one) in its own space with agents. Also for changing the Herdr window (layouts, keys, mods, programs.json).
license: MIT
---

# Herdr

Two programs:
- `hc` (herdr-core) runs every terminal and agent, here and on added machines (`hc machine ls` lists them by name).
- `herdr-app` is the window: spaces, tabs, layouts, mods in `~/.config/herdr-app`.

Before using either, read the current manual from the installed binary; it is the authority:

```bash
hc --skill          # running, delegating and waiting for agents, other machines
herdr-app --skill   # driving and changing the window
```

Delegating: check `hc templates` first (reviewer templates and the like, if you defined any). Start helpers with
`hc run --bg --name <name> --cwd <repo> <template|agent> "<task>. Report with hc send $HC_TERMINAL_ID when done or stuck."`
and collect results with `hc wait --children any|all`. Never sleep or poll.

Codex always runs as `codex --no-daemon` under hc.

Namespaces and accounts: agents for a namespace start through wrappers that load `~/.config/ns/<ns>.env`
(`claude-<ns>`, `codex-<ns>`, `omp-<ns>`). A namespace whose code lives on another machine runs there:
`hc run --on <machine> ...`, never a local agent on that code.

## Start a task in its own space

When the user says "начни задачу X / возьми ABC-123 / заведи задачу, контекст там-то", use `herdr-task` (Mac only;
`herdr-task --help`). It makes the task folder with worktrees on the namespace's machine, opens a space for it and
starts the preset's agents there; nobody reports back to you.

```bash
herdr-task start --ns <ns> --yt ABC-123 [--preset pair] [--repos a,b] [--context /path/one,/path/two]
# tracker attachments (all by default; --attachments id1,id2 picks, --attachments '' none) go to context/youtrack/,
# comments to TASK.md (--no-comments); images reach every agent with its first message
herdr-task start --ns <ns> --title "..." --desc "..." --repos <repo> --preset solo [--key ABC-123]
# without a key the task is named after its title (`herdr-task ls` shows the name to open it by), commits get no
# [KEY] prefix and the agent names and makes the branch itself before its first commit
herdr-task ls              # tasks of every namespace, JSON
herdr-task open KEY        # show its space, or open it again with the agents continuing
herdr-task edit KEY --add-repo <repo> --rm-repo <repo> [--force] --add-context /path --rm-context /path
                           # change the task's repos and context; TASK.md's lists follow, the agents are told
herdr-task issue ABC-123   # the issue and a guess of its repos (board: the sprint)
herdr-task sessions KEY    # the agents' conversations in the task (live: which tab)
herdr-task chat KEY --agent claude --model opus --message "..."   # a new chat tab in the task's space
```

- Namespace: each one maps to a code root, a machine and the agent wrappers; the list, the issue tracker
  (which namespace it serves, its board) and per-namespace roles are in `~/.config/herdr-app/mods/tasks/config.json`.
  Read it to pick the namespace for a key or a repo. Without `--repos` it guesses from the text, else the agent picks them itself.
- Presets: `solo` (one implementer), `pair` (+ reviewer), `trio` (+ tester). Agent and model per role:
  `--team impl=claude:opus,review=codex:gpt-6.2-sol[:effort]` (default: the namespace's roles in config.json). Settings and role briefs:
  `~/.config/herdr-app/mods/tasks/` (`config.json`, `roles/*.md`).
- The issue tracker is read-only: herdr-task never writes to it, and a task made here doesn't appear there.
- The same tasks show in the window: the Tasks button (board, forms) and, if Redline is installed, its OPEN TASKS.
