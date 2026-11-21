#!/usr/bin/env bash
# Sets this setup up on a fresh machine, after the repo is cloned into ~/.config/herdr-app.
# Safe to run again: it never overwrites a file that is already there, it only says so.
set -euo pipefail

APP="$(cd "$(dirname "$0")" && pwd)"
ok() { printf '  ok    %s\n' "$*"; }
skip() { printf '  skip  %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }

# A symlink at $2 to $1, unless something else is there.
link() {
  if [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; then ok "$2"; return; fi
  if [ -e "$2" ] || [ -L "$2" ]; then skip "$2 exists, not replaced (move it away and run again to link it)"; return; fi
  mkdir -p "$(dirname "$2")"; ln -s "$1" "$2"; ok "$2 -> $1"
}

# A copy of an example at $2, unless the file is there already.
seed() {
  if [ -e "$2" ]; then ok "$2 (kept)"; return; fi
  mkdir -p "$(dirname "$2")"; cp "$1" "$2"; ok "$2 (from ${1#"$APP"/}: fill it in)"
}

echo "Scripts in ~/.local/bin:"
link "$APP/bin/herdr-task" "$HOME/.local/bin/herdr-task"
link "$APP/bin/ssh-browser" "$HOME/.local/bin/ssh-browser"
link "$APP/bin/ssh-add-host" "$HOME/.local/bin/ssh-add-host"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "~/.local/bin is not in PATH" ;; esac

echo "Claude Code themes in ~/.claude/themes:"
for f in "$APP"/claude-themes/*.json; do link "$f" "$HOME/.claude/themes/$(basename "$f")"; done

echo "Settings of your own (not in git):"
seed "$APP/programs.example.json" "$APP/programs.json"
seed "$APP/mods/tasks/config.example.json" "$APP/mods/tasks/config.json"
seed "$APP/bin/ssh-browser.example.conf" "$HOME/.config/ssh-browser/config"

echo "Programs the mods use:"
need() { if command -v "$1" >/dev/null 2>&1; then ok "$1"; else warn "$1 not found: $2"; fi; }
need python3 "Tasks (herdr-task) and the tps mod need it"
need git "Explorer and Tasks need it"
need node "Explorer draws Mermaid with mmdc, which runs on node"
need mmdc "Mermaid diagrams in Explorer: npm install -g @mermaid-js/mermaid-cli"
need sips "images in Explorer and Tasks (macOS only)"
need claude "agents in Tasks"
need codex "agents in Tasks (optional)"

cat <<EOF

Next:
  1. Fill in mods/tasks/config.json (namespaces, agents, YouTrack) and, for ssh-browser,
     ~/.config/ssh-browser/config. Until then Tasks shows the example namespaces and
     ssh-browser points at a made-up host.
  2. Switch Herdr to this layout: cmd-shift-l and pick main-copy.
  3. auto-title: herdr-app do mod.open '{"name":"auto-title"}' and install its service in that popup.
  4. Check: herdr-app status (no errors).
EOF
