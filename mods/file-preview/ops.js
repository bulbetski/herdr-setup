// File operations of the tree (new, rename, move, copy, trash, upload), run with one small POSIX
// script on the machine that holds the files, here or remote. Nothing overwrites: an existing
// target is refused (exit 4) and the caller asks, or picks a free "name copy" name.
import { exec, hc } from "herdr";

const EXISTS = 4;

// $1 path. A new empty file / folder; refuses an existing one.
const MKFILE = '[ -e "$1" ] || [ -L "$1" ] && exit 4; mkdir -p -- "$(dirname -- "$1")" && : > "$1"';
const MKDIR = '[ -e "$1" ] || [ -L "$1" ] && exit 4; mkdir -p -- "$1"';
// $1 source, $2 target. mv / cp -R without overwriting.
const MOVE = '[ -e "$2" ] || [ -L "$2" ] && exit 4; mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"';
const COPY = '[ -e "$2" ] || [ -L "$2" ] && exit 4; mkdir -p -- "$(dirname -- "$2")" && cp -Rp -- "$1" "$2"';
// $@ paths: to the Trash (macOS 14+ `trash`, older macOS through Finder), or the desktop trash on Linux (gio).
const TRASH = 'if [ "$(uname)" = Darwin ] && [ -x /usr/bin/trash ]; then /usr/bin/trash "$@"; elif command -v gio >/dev/null 2>&1 && [ "$(uname)" != Darwin ]; then gio trash -- "$@"; ' +
  'else for p in "$@"; do osascript -e "on run a" -e "tell application \\"Finder\\" to delete POSIX file (item 1 of a)" -e "end run" "$p" >/dev/null || exit 1; done; fi';
// $1 folder, $2 name: prints a free name, "name copy.ext", "name copy 2.ext", ...
const FREE = 'd=$1; n=$2; [ -e "$d/$n" ] || [ -L "$d/$n" ] || { printf %s "$n"; exit 0; }; ' +
  'case "$n" in .*.*|[!.]*.*) b=${n%.*}; e=.${n##*.};; *) b=$n; e=;; esac; ' +
  'c="$b copy$e"; i=2; while [ -e "$d/$c" ] || [ -L "$d/$c" ]; do c="$b copy $i$e"; i=$((i+1)); done; printf %s "$c"';
const EXISTING = 'for p in "$@"; do [ -e "$p" ] || [ -L "$p" ] && printf "%s\\0" "$p"; done; exit 0';

export const dirname = (p) => (p.lastIndexOf("/") > 0 ? p.slice(0, p.lastIndexOf("/")) : "/");
export const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

/** A name a person typed: one path segment, not "." or "..". */
export function badName(name) {
  const n = String(name ?? "").trim();
  if (!n) return "Type a name";
  if (n === "." || n === "..") return "Not a valid name";
  if (n.includes("/")) return "A name can't contain /";
  if (n.includes("\0")) return "Not a valid name";
  return null;
}

async function run(script, args, on) {
  let r;
  try { r = await exec("sh", ["-c", script, "fp", ...args], { on, timeout: 120000 }); }
  catch (e) { return { ok: false, error: on ? `Cannot reach ${on}: ${String(e.message ?? e)}` : String(e.message ?? e) }; }
  if (r.code === EXISTS) return { ok: false, exists: true, error: "Already exists" };
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || `Failed (${r.code})`).trim().split("\n").slice(-3).join("\n") };
  return { ok: true, out: r.stdout };
}

export const newFile = (abs, on) => run(MKFILE, [abs], on);
export const newFolder = (abs, on) => run(MKDIR, [abs], on);
export const move = (src, dst, on) => run(MOVE, [src, dst], on);
export const copy = (src, dst, on) => run(COPY, [src, dst], on);
export const trash = (paths, on) => run(TRASH, paths, on);

// $1 path: to the Trash like TRASH, printing where it went, for undo: the file in ~/.Trash (macOS),
// or the trash:// URI (Linux; the entry for that path that wasn't there before).
const TRASH1 = 'p=$1; if [ "$(uname)" = Darwin ] && [ -x /usr/bin/trash ]; then ' +
  'o=$(/usr/bin/trash -v "$p" 2>&1) || { printf "%s" "$o" >&2; exit 1; }; printf "%s" "$o" | sed -n \'s/.*" to "\\(.*\\)"$/\\1/p\' | tail -n 1; ' +
  'elif command -v gio >/dev/null 2>&1; then ' +
  'l() { gio trash --list 2>/dev/null | awk -F "\\t" -v p="$p" \'$2 == p { print $1 }\'; }; b=$(l); gio trash -- "$p" || exit 1; ' +
  'l | while IFS= read -r u; do printf "%s\\n" "$b" | grep -qxF -- "$u" || printf "%s" "$u"; done; ' +
  'else exit 5; fi';
// $1 where (TRASH1's output), $2 the original path: back from the Trash; refuses an existing path.
const RESTORE = '[ -e "$2" ] || [ -L "$2" ] && exit 4; case "$1" in trash://*) gio trash --restore "$1";; ' +
  '*) mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2";; esac';

/** One path to the Trash: { ok, where } (where: what restore() needs, "" when unknown). */
export async function trashOne(path, on) {
  const r = await run(TRASH1, [path], on);
  return r.ok ? { ok: true, where: r.out.trim() } : r;
}

export const restore = (where, path, on) => run(RESTORE, [where, path], on);

// Writing a file on a remote machine (exec has no stdin): the text as arguments, in chunks appended to a
// temp file next to it, then copied over the file with cat, which keeps its mode and owner. Text has no
// NUL bytes, so printf %s carries it as it is (the mod runtime has no TextEncoder for base64).
// $1 temp, $2 chunk / $2 target.
const W_START = ': > "$1"';
const W_CHUNK = 'printf %s "$2" >> "$1"';
const W_DONE = 'cat -- "$1" > "$2" && rm -f -- "$1"';
const W_ONE = 'printf %s "$2" > "$1" && cat -- "$1" > "$3" && rm -f -- "$1"';   // $1 temp, $2 text, $3 target
const CHUNK = 30000;   // characters per call: at most 120 KB of UTF-8, under one argument's 128 KB limit

/** Replaces a remote file's text. -> { ok } | { ok: false, error } */
export async function writeRemote(path, text, on) {
  if (text.includes("\0")) return { ok: false, error: "The text has a NUL byte" };
  const tmp = `${dirname(path)}/.${basename(path)}.herdr-save`;
  // A small text in one call (also what a closing tab has time for).
  if (text.length <= CHUNK) { const r = await run(W_ONE, [tmp, text, path], on); return r.ok ? { ok: true } : { ok: false, error: r.error }; }
  let r = await run(W_START, [tmp], on);
  for (let i = 0; r.ok && i < text.length; ) {
    let end = Math.min(text.length, i + CHUNK);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;   // never split a surrogate pair
    r = await run(W_CHUNK, [tmp, text.slice(i, end)], on);
    i = end;
  }
  if (r.ok) r = await run(W_DONE, [tmp, path], on);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// macOS pasteboard through JXA: files out (Copy in the tree, so Finder can paste them), files in
// (⌘V after a copy in Finder), and its change count (which copy is newer).
const PB = 'ObjC.import("AppKit"); const pb = $.NSPasteboard.generalPasteboard;';
export async function pbWriteFiles(paths) {
  const js = PB + `pb.clearContents; pb.writeObjects($(${JSON.stringify(paths)}.map(p => $.NSURL.fileURLWithPath(p)))); pb.changeCount;`;
  const r = await exec("osascript", ["-l", "JavaScript", "-e", js]).catch(() => null);
  return r?.code === 0 ? Number(r.stdout.trim()) : null;
}
export async function pbRead() {
  const js = PB + 'const u = pb.readObjectsForClassesOptions($([$.NSURL]), $()); const out = []; ' +
    'if (u && !u.isNil()) for (let i = 0; i < u.count; i++) { const x = u.objectAtIndex(i); if (x.isFileURL) out.push(ObjC.unwrap(x.path)); } ' +
    'JSON.stringify({ n: pb.changeCount, files: out });';
  const r = await exec("osascript", ["-l", "JavaScript", "-e", js]).catch(() => null);
  try { const v = r?.code === 0 ? JSON.parse(r.stdout.trim()) : null; return v ? { n: Number(v.n), files: v.files ?? [] } : null; } catch { return null; }
}

/** A free name for `name` in folder `dir` ("a copy.txt" when "a.txt" is taken). */
export async function freeName(dir, name, on) {
  const r = await run(FREE, [dir, name], on);
  return r.ok && r.out ? r.out : null;
}

/** Which of `paths` exist (on that machine). */
export async function existing(paths, on) {
  const r = await run(EXISTING, paths, on);
  return r.ok ? r.out.split("\0").filter(Boolean) : [];
}

/** ssh target of an added machine (hc machine ls), for scp. */
async function target(machine) {
  const r = await hc(["machine", "ls", "--json"]).catch(() => null);
  try { return (JSON.parse(r.stdout).machines ?? []).find((m) => m.name === machine)?.target ?? machine; }
  catch { return machine; }
}

/**
 * Copies between this computer and a remote machine with scp (-r, times kept). from / to: { path, on }.
 * The caller has picked a free target name, so nothing is overwritten.
 */
export async function transfer(from, to) {
  if (from.on && to.on) return { ok: false, error: "Copying between two remote machines isn't supported" };
  const remote = from.on ?? to.on, host = await target(remote);
  const src = from.on ? `${host}:${from.path}` : from.path;
  const dst = to.on ? `${host}:${to.path}` : to.path;
  let r;
  // -s: the SFTP protocol, which takes remote paths as they are (no remote shell, so no quoting).
  try { r = await exec("scp", ["-s", "-rpq", "-o", "BatchMode=yes", "--", src, dst], { timeout: 600000 }); }
  catch (e) { return { ok: false, error: String(e.message ?? e) }; }
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || `scp failed (${r.code})`).trim().split("\n").slice(-3).join("\n") };
}

