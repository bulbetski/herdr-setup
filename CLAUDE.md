# Herdr setup

This folder is the whole Herdr setup and Herdr reads it live: settings, keys, layouts, mods, themes, the
`ssh-browser` and `herdr-task` scripts, Claude Code themes. Read `README.md` first (what is customized and how
to set it up), then `README.local.md` if it is there (this machine's accounts, networks and private mods).

- Two git repos share the folder. `.git` is public (github.com/bulbetski/herdr-setup): everything generic.
  `.git-private` is local only: the files `.gitignore` lists as private (`README.local.md`, `programs.json`,
  `mods/tasks/config.json`, `mods/redline/`, `mods/worklog/`). Commit there with
  `git --git-dir=.git-private --work-tree=. add -f <files>` and `... commit`. Commit after a change.
- Nothing about a workplace, its hosts, domains, task keys or colleagues goes into the public repo: put it in
  the local config files or `README.local.md`. Before a push run the leak check from `README.local.md`.
- Herdr's own manual: `herdr-app --skill`, `hc --skill`, and `AGENTS.md` here (Herdr rewrites it; don't edit).
- Mods listed in README are ours, edit them in place. The other folders in `mods/` and layouts other than
  `main-copy.json` are Herdr's and get replaced on start: clone them (`herdr-app do mod.clone --name X --as X-plus`)
  and wire the clone into `layouts/main-copy.json`. A clone of a Herdr mod keeps its Apache-2.0 `LICENSE` and the
  "Modified from" note at the top of `main.js`; a mod taken from GitHub keeps its upstream `LICENSE`.
- After any mod change: `herdr-app check mods/<mod>`, `herdr-app status` (no `errors`), `herdr-app shot` to look.
- Don't run installers that end with `hc kill $HC_TERMINAL_ID` from your own terminal: it kills the terminal you run in.
- Mod dev hooks (`herdr-app do file-preview.act:...` and the like) act on whatever folder the Explorer shows: never
  run them while the person works in another space.
- Update `README.md` (generic) or `README.local.md` (this machine) when the setup changes.
