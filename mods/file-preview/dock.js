// file-preview as the Explorer: the layout's left column "explorer" (mode "tree") and a viewer tab per
// space (mode "tab") for what it opens; also main-fp's side panel (the stack child "file-preview" of the
// right column "panel") for the popup's Anchor button.
// Mods import only from their own folder, so mods/file-preview-panel/dock.js is a byte-for-byte
// copy (scripts/sync.sh refuses a mismatch).
import { panes, focused, layout, run, spaces, shared, setShared } from "herdr";

export const MOD = "file-preview";
const PANEL = "panel", STACK = "panel-body";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

/** The shown layout has the side panel block (another layout falls back to the popup). */
export function sideAvailable() {
  return Boolean(find(layout(), MOD));
}

/** The side panel is open on file-preview. */
export function sideShown() {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === MOD);
}

/** Opens the side panel on file-preview, which takes the keyboard. */
export function showSide() {
  run("layout.select", { stack: STACK, child: MOD });
  run("layout.show", { id: PANEL });
  run(`${MOD}.focus-side`);
}

export function hideSide() {
  run("layout.hide", { id: PANEL });
}

export const EXPLORER = "explorer";           // the layout's Explorer column (main-copy)
export const VIEWERS_KEY = "file-preview.viewers2";  // shared: { <tab id>: { space, key } }, what each viewer tab shows

/** What a request shows, as one string: the same file (commit, change) opens the same tab. */
export const requestKey = (r) => [r.kind, r.on ?? "", r.kind === "file" ? r.abs : r.kind === "commit" ? `${r.cwd}@${r.hash}` : `${r.cwd}#${r.row?.key}`].join("|");

/**
 * The Explorer column opened something: { kind: "file", abs } | { kind: "commit", hash } |
 * { kind: "change", row }, with the column's cwd / on and a tab label. Each gets a tab of its own
 * in the shown space (like an editor's tabs); one already open there is shown instead.
 * -> null (an open tab was shown) | { space, before, key } (a tab is being made: the caller records
 * which one appears, see recordViewer).
 */
export function openInTab(what) {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const key = requestKey(what), tabs = space.tabs ?? [];
  const viewerTabs = new Set(panes().filter((p) => p.mod === MOD && !p.terminal).map((p) => p.tab));
  const all = new Set(spaces().flatMap((s) => s.tabs?.map((t) => t.id) ?? []));
  const reg = shared(VIEWERS_KEY) ?? {}, kept = {};
  for (const [tab, v] of Object.entries(reg)) if (all.has(tab) && viewerTabs.has(tab)) kept[tab] = v;   // closed tabs leave
  if (Object.keys(kept).length !== Object.keys(reg).length) setShared(VIEWERS_KEY, kept);
  // The recorded tab, else a viewer tab of this space named after it that records nothing else (tabs
  // opened before the record existed).
  let tab = tabs.find((t) => kept[t.id]?.key === key)?.id ?? null;
  if (!tab) {
    const named = tabs.filter((t) => viewerTabs.has(t.id) && t.name === what.label && !kept[t.id]);
    if (named.length) { tab = named[0].id; setShared(VIEWERS_KEY, { ...kept, [tab]: { space: space.id, key } }); }
  }
  if (tab) { run("tab.select", { id: tab }); return null; }
  const before = tabs.map((t) => t.id);
  run("tab.new", { space: space.id, name: what.label ?? "Explorer", mod: MOD,
    props: { mode: "tab", space: space.id, cwd: what.cwd, on: what.on ?? null, request: { ...what, key } } });
  return { space: space.id, before, key };
}

/**
 * The tab openInTab made: the space's viewer tab that wasn't there before. Recorded as
 * { <tab id>: { space, key } }. False while it hasn't appeared yet.
 */
export function recordViewer(made) {
  const space = spaces().find((s) => s.id === made.space);
  const viewerTabs = new Set(panes().filter((p) => p.mod === MOD && !p.terminal).map((p) => p.tab));
  const fresh = (space?.tabs ?? []).filter((t) => !made.before.includes(t.id) && viewerTabs.has(t.id));
  if (fresh.length !== 1) return false;
  setShared(VIEWERS_KEY, { ...(shared(VIEWERS_KEY) ?? {}), [fresh[0].id]: { space: made.space, key: made.key } });
  return true;
}

/** The launcher (cmd-e, the Explorer button): shows or hides the Explorer column; the popup elsewhere. */
export function toggle() {
  if (!find(layout(), EXPLORER)) return run("mod.open", { name: MOD });
  run("layout.toggle", { id: EXPLORER });
}

/** A pane docked by an older version (mode "panel") in a tab, if any: its ✕ still closes it. */
export function panelOf(tab) {
  return panes().find((p) => p.tab === tab && p.mod === MOD && !p.terminal) ?? null;
}

/** The focused tab, for panelOf (null without a window). */
export function focusedTab() {
  return focused()?.tab ?? null;
}
