// Tasks: a YouTrack sprint board (optional), the tasks already started in each namespace, and taking one in
// work: its own space with a team of agents (presets in config.json, briefs in roles/). A list on the left,
// the selected issue or task on the right: its description, the launch panel (repos, team, materials), and a
// started task's team, repos and chats (live ones focus their tab, others continue in a new one).
// Everything goes through bin/herdr-task, which agents in chat use too. YouTrack is only read: nothing here
// writes to it. The board, the lists and the issues seen are kept in localStorage: shown at once, refreshed behind.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { props, closeOverlay, theme, exec, home, nextCommand, run, spaces, notify, readTextFile } from "herdr";

const ROLE = { impl: "Исполнитель", review: "Ревьюер", qa: "Тестировщик" };

function store(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function keep(key, value) { try { localStorage.setItem(key, value); } catch { } }
function cached(key) { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } }
function cache(key, data) { keep(key, JSON.stringify({ at: Date.now(), data })); }
const two = (n) => String(n).padStart(2, "0");
const hm = (ms) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const when = (sec) => { const d = new Date(sec * 1000), now = new Date(); return d.toDateString() === now.toDateString() ? hm(d) : `${two(d.getDate())}.${two(d.getMonth() + 1)} ${hm(d)}`; };

const CYR = Object.fromEntries([..."абвгдеёжзийклмнопрстуфхцчшщъыьэюя"].map((c, i) =>
  [c, "a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sch _ y _ e yu ya".split(" ")[i]]));
const slug = (s) => [...String(s).toLowerCase()].map((c) => CYR[c] ?? c).join("").replace(/_/g, "").replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
// No key: there is no branch yet, the agent makes one when it starts committing.
const branchFor = (key, title) => (key ? `ветка ${key}/${slug(title).slice(0, 48).replace(/-+$/, "") || "task"}` : "ветку агент назовёт сам");

function ht(args, timeout = 120000) {
  return exec("sh", ["-c", 'exec "$HOME/.config/herdr-app/bin/herdr-task" "$@"', "herdr-task", ...args], { timeout });
}
async function htJson(args, timeout) {
  const r = await ht(args, timeout);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").pop());
  return JSON.parse(r.stdout);
}
const errText = (e) => String(e?.message ?? e).replace(/^herdr-task: /, "");

// open_with in config.json: [{ domains: [...], run: "~/.local/bin/ssh-browser" }]: a link on those domains
// (or their subdomains) opens with that program, the rest with the default browser.
let OPEN_WITH = [];
function openUrl(url) {
  if (!url) return;
  const host = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[\/:?#]/)[0].toLowerCase();
  const rule = OPEN_WITH.find((r) => (r.domains ?? []).some((d) => host === d || host.endsWith(`.${d}`)));
  if (rule?.run) exec(rule.run.replace(/^~/, home()), [url]).catch(() => exec("open", [url]).catch(() => {}));
  else exec("open", [url]).catch(() => {});
}

// YouTrack markdown, cut at its images: [{ md } | { img: name, alt }]. An image names an attachment, and
// the names hold spaces and brackets (![](image (94).png){width=70%}), so the target is matched against the
// issue's attachment names first, the longest one that fits; the {…} attributes YouTrack adds are dropped.
function mdParts(text, names = []) {
  const src = String(text || "").replace(/\r/g, ""), out = [], re = /!\[([^\]]*)\]\(/g, byLength = [...names].sort((a, b) => b.length - a.length);
  let at = 0, m;
  while ((m = re.exec(src))) {
    const from = re.lastIndex;
    let name = null, end = -1;
    for (const n of byLength) for (const form of [n, encodeURI(n)]) if (end < 0 && src.startsWith(`${form})`, from)) { name = n; end = from + form.length + 1; }
    if (end < 0) {
      const close = src.indexOf(")", from);
      if (close < 0) break;
      name = src.slice(from, close).trim().replace(/^<|>$/g, "").replace(/\s+"[^"]*"$/, "");
      try { name = decodeURIComponent(name); } catch { }
      end = close + 1;
    }
    const attr = /^\{[^}]*\}/.exec(src.slice(end));
    if (attr) end += attr[0].length;
    if (m.index > at) out.push({ md: src.slice(at, m.index) });
    out.push({ img: name, alt: m[1] });
    at = end; re.lastIndex = end;
  }
  if (at < src.length) out.push({ md: src.slice(at) });
  return out.filter((x) => x.img || x.md.trim());
}

// A copy in ~/Downloads (name (1).ext when taken); notify says where.
async function download(local, name) {
  const script = 'd="$HOME/Downloads"; n="$2"; b="${n%.*}"; e="${n##*.}"; [ "$b" = "$n" ] && e=""; t="$d/$n"; i=1; ' +
    'while [ -e "$t" ]; do t="$d/$b ($i)${e:+.$e}"; i=$((i+1)); done; cp "$1" "$t" && printf %s "$t"';
  const r = await exec("sh", ["-c", script, "sh", local, name]).catch((e) => ({ code: 1, stderr: String(e) }));
  if (r.code === 0) notify({ title: "Скачано", body: r.stdout.replace(home(), "~"), level: "success" });
  else notify({ title: "Не скачалось", body: (r.stderr || "").trim(), level: "error" });
}
const isImage = (f) => Boolean(f?.png);
// How an attachment shows in the viewer: image, Markdown, plain text, or a card (xlsx, docx, pdf, zip…).
const TEXT_EXT = /\.(txt|log|csv|tsv|json|ya?ml|toml|ini|conf|sql|xml|html?|go|py|js|ts|sh|proto|env)$/i;
function kindOf(f) {
  if (isImage(f)) return "image";
  if (/\.(md|markdown)$/i.test(f.name)) return "md";
  if (TEXT_EXT.test(f.name) || /^text\//.test(f.mime || "")) return "text";
  return "other";
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

const ddmm = (ms) => { if (!ms) return ""; const d = new Date(ms); return `${two(d.getDate())}.${two(d.getMonth() + 1)}`; };

// ---- small pieces shared by the list and the panels ----
function ui(t) {
  const stop = (_e, cx) => cx.stop_propagation();
  // primary: filled, the one main action; plain: outlined; on: a selected toggle.
  const btn = (id, label, fn, o = {}) => div().id(id).flex_none().min_h(o.big ? 32 : 26).px(o.big ? 14 : 10).py(2).flex().items_center().justify_center().text_center().rounded(6).text_size(o.big ? 13 : 12)
    .when(Boolean(o.fill), (x) => x.w_full().whitespace_normal())
    .when(Boolean(o.primary), (x) => x.bg(o.off ? t.raised : t.solid).text_color(o.off ? t.dim : t.solid_foreground).font_semibold())
    .when(!o.primary, (x) => x.border_1().border_color(o.on ? t.accent : t.border).text_color(o.off ? t.dim : o.on ? t.foreground : t.muted).bg(o.on ? t.selected : t.popover))
    .when(Boolean(o.tooltip), (x) => x.tooltip(o.tooltip))
    .when(!o.off, (x) => x.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }))
    .on_mouse_down("left", stop).child(label);
  // One of a few: bordered buttons side by side, the chosen one highlighted.
  const seg = (id, items, value, fn) => h_flex().flex_none().gap(4).children(items.map(([v, label]) =>
    btn(`${id}-${v}`, label, (cx) => { fn(v, cx); cx.notify(); }, { on: v === value })));
  const section = (title, hint) => h_flex().pt(16).pb(6).gap(8).items_baseline()
    .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
    .when(Boolean(hint), (x) => x.child(div().text_size(11.5).text_color(t.dim).child(hint)));
  const field = (st, h = 32) => h_flex().h(h).px(10).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
    .child(Input.new(st).flex_1().h_full().text_size(12.5).text_color(t.foreground));
  const area = (id, st) => div().id(id).rounded(7).border_1().border_color(t.border).bg(t.background).p(8).cursor_text()
    .on_mouse_down("left", stop).child(Textarea.new(st).w_full().text_size(12.5).text_color(t.foreground));
  return { stop, btn, seg, section, field, area };
}

// Agent and model of one role (or of a new chat): Claude / Codex, then the model behind a small menu.
function agentPicker(owner, id, spec, models, u, t, onChange) {
  const open = owner.modelMenu === id;
  return v_flex().gap(4)
    .child(h_flex().gap(8).items_center()
      .child(u.seg(`${id}-ag`, [["claude", "Claude"], ["codex", "Codex"]], spec.agent, (v) => { if (v !== spec.agent) { spec.agent = v; spec.model = ""; onChange?.(); } }))
      .child(u.btn(`${id}-model`, `${spec.model || "модель по умолчанию"} ▾`, (cx) => { owner.modelMenu = open ? null : id; cx.notify(); }, { on: open })))
    .when(open, (x) => x.child(h_flex().gap(4).flex_wrap().children(["", ...(models[spec.agent] ?? [])].map((m, j) =>
      u.btn(`${id}-m${j}`, m || "по умолчанию", (cx) => { spec.model = m; owner.modelMenu = null; onChange?.(); cx.notify(); }, { on: spec.model === m })))));
}

// ---- the launch panel: what the task gets before its agents start ----
class Launch {
  constructor(owner, ns, issue, cx) {
    this.o = owner; this.ns = ns; this.issue = issue; // issue: a board row, or null for a task of our own
    const known = issue ? owner.issues[issue.key] : null;
    this.key = InputState.new({ placeholder: "Номер, если есть: PROJ-123" });
    this.title = InputState.new({ placeholder: "Что сделать, коротко" });
    this.title.on("change", (_e, cx) => cx.notify()); this.key.on("change", (_e, cx) => cx.notify());
    // The prompt: what the agents are to do, in my words. For an issue the YouTrack description goes along anyway.
    this.desc = TextareaState.new({ placeholder: issue ? "Что сделать, своими словами, как промпт агенту. Можно оставить пустым: описание из YouTrack уйдёт и так."
      : "Что сделать и зачем, как промпт агенту", rows: 7 });
    this.desc.on("change", (_e, cx) => cx.notify());
    this.fileQ = InputState.new({ placeholder: "Найти файл или папку в репозиториях…  (Enter: добавить путь как есть)" });
    this.fileQ.on("change", (_e, cx) => cx.notify());
    this.fileQ.on("submit", (_e, cx) => { const v = this.fileQ.value().trim(); if (v.startsWith("/") || v.startsWith("~")) { this.addFile(v); this.fileQ.set_value(""); } cx.notify(); });
    this.clones = cached(`repos:${ns}`)?.data ?? null; this.picked = new Set(); this.guess = new Set();
    this.files = []; this.index = null;
    this.withComments = true;  // a YouTrack issue's comments go to the agents (TASK.md)
    this.skip = new Set();     // its attachments left out (by id); all of them go by default
    this.preset = owner.presets?.default ?? "solo"; this.team = {}; this.syncTeam();
    this.error = null; this.busy = false;
    if (known) this.useIssue(known);
    (issue ? this.desc : this.title).focus();
    cx.spawn(async (cx) => {
      try {
        const [clones, full] = await Promise.all([htJson(["repos", "--ns", ns]), issue && !known ? owner.fetchIssue(issue.key) : null]);
        this.clones = clones; cache(`repos:${ns}`, clones);
        if (full) this.useIssue(full);
        this.indexFiles(cx);
      } catch (e) { this.error = errText(e); }
      cx.notify();
    });
  }

  useIssue(full) { for (const n of full.guess || []) { this.picked.add(n); this.guess.add(n); } }

  // Every tracked file and folder of the namespace's clones, for the materials search (as Redline's form).
  indexFiles(cx) {
    const on = this.o.presets?.namespaces?.[this.ns]?.machine ?? null;
    const paths = (this.clones ?? []).map((c) => c.path);
    if (!paths.length) { this.index = []; return; }
    cx.spawn(async (cx) => {
      const script = 'for p in "$@"; do n=$(basename "$p"); git -C "$p" ls-files 2>/dev/null | head -20000 | sed "s#^#$n/#"; done';
      const out = (await exec("sh", ["-c", script, "sh", ...paths], { on: on || undefined, timeout: 120000 }).catch(() => ({ stdout: "" }))).stdout;
      const files = out.split("\n").filter(Boolean), dirs = new Set();
      for (const f of files) { const parts = f.split("/"); for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/"); }
      this.index = [...dirs, ...files]; cx.notify();
    });
  }

  abs(rel) {
    const name = rel.split("/")[0];
    const c = (this.clones ?? []).find((x) => x.name === name);
    return c ? `${c.path}${rel.slice(name.length)}`.replace(/\/$/, "") : rel;
  }
  addFile(p) { if (!this.files.includes(p)) this.files.push(p); }

  syncTeam() {
    const roles = this.o.presets?.presets?.[this.preset]?.roles ?? ["impl"];
    const defaults = this.o.presets?.namespaces?.[this.ns]?.roles ?? {};
    const next = {};
    for (const r of roles) next[r] = this.team[r] ?? { agent: defaults[r]?.agent ?? "claude", model: defaults[r]?.model ?? "" };
    this.team = next;
  }

  start(cx) {
    const key = this.key.value().trim(), title = this.issue ? this.issue.title : this.title.value().trim();
    if (!this.issue && key && !/^[A-Za-z][\w-]*-\d+$/.test(key)) { this.error = "Номер вида PROJ-123, или оставьте пустым."; cx.notify(); return; }
    if (!title) { this.error = "Напишите, что сделать."; cx.notify(); return; }
    const team = Object.entries(this.team).map(([r, s]) => `${r}=${s.agent}:${s.model}`).join(",");
    const args = ["start", "--ns", this.ns, "--preset", this.preset, "--team", team];
    if (this.issue) {
      args.push("--yt", this.issue.key);
      if (this.desc.value().trim()) args.push("--note", this.desc.value().trim());
      const ids = (this.o.issues[this.issue.key]?.attachments ?? []).map((x) => x.id);
      if (this.skip.size) args.push("--attachments", ids.filter((id) => !this.skip.has(id)).join(","));
      if (!this.withComments) args.push("--no-comments");
    }
    else { args.push("--title", title, "--desc", this.desc.value().trim()); if (key) args.push("--key", key); }
    if (this.picked.size) args.push("--repos", [...this.picked].join(","));
    if (this.files.length) args.push("--context", this.files.join(","));
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await htJson(args, 600000); closeOverlay(props().overlay); }
      catch (e) { this.error = errText(e); this.busy = false; cx.notify(); }
    });
  }

  render(t, u) {
    const models = this.o.presets?.models ?? {};
    const presets = Object.entries(this.o.presets?.presets ?? {});
    const p = this.o.presets?.presets?.[this.preset];
    const clones = this.clones ?? [];
    const full = this.issue ? this.o.issues[this.issue.key] : null;
    const nFiles = full?.attachments?.length ?? 0, nComments = full?.comments?.length ?? 0;
    const box = (on) => div().flex_none().w(16).h(16).rounded(4).border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background)
      .flex().items_center().justify_center().text_size(11).text_color(t.solid_foreground).child(on ? "✓" : "");
    const check = (id, on, label, hint, toggle) => h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover)).on_mouse_down("left", u.stop).on_click((_e, cx) => { toggle(); cx.notify(); })
      .child(box(on)).child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).child(label)).child(div().text_size(11).text_color(t.dim).child(hint));
    // Every clone as a chip: a click picks it or drops it; • marks the ones the issue's text names.
    const repoChip = (c, i) => {
      const on = this.picked.has(c.name);
      return u.btn(`tk-r-${i}`, this.guess.has(c.name) ? `${c.name} •` : c.name,
        (cx) => { if (on) this.picked.delete(c.name); else this.picked.add(c.name); cx.notify(); },
        { on, tooltip: this.guess.has(c.name) ? "Назван в тексте задачи" : undefined });
    };
    const fq = this.fileQ.value().trim().toLowerCase();
    const hits = !fq || fq.startsWith("/") || fq.startsWith("~") || !this.index ? []
      : (() => { const w = fq.split(/\s+/), out = []; for (const x of this.index) { const l = x.toLowerCase(); if (w.every((y) => l.includes(y))) { out.push(x); if (out.length >= 8) break; } } return out; })();
    const title = this.issue ? this.issue.title : this.title.value().trim();
    const key = this.issue ? this.issue.key : this.key.value().trim();
    // What goes to the agents besides my prompt, as it stands now: shown faint, read-only.
    const plain = (md) => String(md || "").replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, "[картинка]").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
    const atts = (full?.attachments ?? []).filter((a) => !this.skip.has(a.id));
    const docs = Boolean(this.o.presets?.namespaces?.[this.ns]?.docs) && this.picked.size > 0;
    const extra = [
      ...(this.issue ? [["Описание", full?.desc ? `${plain(full.desc).slice(0, 260)}${plain(full.desc).length > 260 ? "…" : ""}` : full ? "нет" : "загружаю…"]] : []),
      ...(this.issue && nFiles ? [["Вложения", atts.length ? `${atts.map((a) => a.name).join(", ")}; картинки придут с первым сообщением` : "не передаются"]] : []),
      ...(this.issue && nComments ? [["Комментарии", this.withComments ? `${nComments}, в TASK.md` : "не передаются"]] : []),
      ["Материалы", [...this.files.map((f) => f.split("/").slice(-2).join("/")), ...(docs ? ["страницы документации из docs"] : [])].join(", ") || "нет"],
      ["Репозитории", this.picked.size ? `${[...this.picked].join(", ")}; ${branchFor(key, title)}` : "агент выберет сам"],
      ["Команда", Object.entries(this.team).map(([r, sp]) => `${ROLE[r] ?? r}: ${sp.agent === "claude" ? "Claude" : "Codex"}${sp.model ? ` ${sp.model}` : ""}`).join(", ")],
      ["Правила", `работать в worktree задачи, ${key ? "коммиты с ключом" : "ветку и сообщения коммитов агент придумает сам"}, не пушить и не открывать MR, вести «План и статус» в TASK.md`],
    ];
    const form = v_flex().id("tk-launch").flex_1().min_h(0).overflow_y_scrollbar().px(18).pb(18)
      .when(!this.issue, (x) => x
        .child(u.section("Новая задача", this.o.nsList().find(([n]) => n === this.ns)?.[1]))
        .child(h_flex().gap(6).child(div().flex_1().child(u.field(this.title, 34))).child(div().w(220).child(u.field(this.key, 34)))))
      .child(u.section("Задание агенту", this.issue ? "главное, что агенты прочитают первым" : null))
      .child(u.area("tk-prompt", this.desc))
      .child(v_flex().pt(10).gap(3)
        .child(div().pb(2).text_size(11.5).text_color(t.dim).child("Вместе с заданием агенты получат:"))
        .children(extra.map(([k, v]) => h_flex().gap(10).items_start()
          .child(div().w(96).flex_none().text_size(11.5).text_color(t.dim).child(k))
          .child(div().flex_1().min_w(0).text_size(11.5).line_height(1.45).text_color(t.dim).child(v)))))
      .child(u.section("Репозитории", this.picked.size ? `${this.picked.size} выбрано` : "не выбраны: агент выберет сам"))
      .child(h_flex().flex_wrap().gap(6).children(clones.map(repoChip))
        .when(!this.clones && !this.error, (x) => x.child(div().text_size(11.5).text_color(t.dim).child("Ищу клоны…"))))
      .child(div().pt(8).text_size(11.5).text_color(t.dim).child(`${this.guess.size ? "• назван в тексте задачи. " : ""}${key ? `В${branchFor(key, title).slice(1)} от main` : "Ветку от main агент назовёт сам"}, у каждого репозитория своя копия (worktree) в папке задачи.`))
      .child(u.section("Команда", p?.about))
      .child(h_flex().child(u.seg("tk-preset", presets.map(([n, x]) => [n, x.label ?? n]), this.preset, (v) => { this.preset = v; this.syncTeam(); })))
      .child(v_flex().pt(10).gap(10).children(Object.entries(this.team).map(([r, s]) => h_flex().gap(12).items_start()
        .child(div().w(100).flex_none().pt(5).text_size(12.5).text_color(t.muted).child(ROLE[r] ?? r))
        .child(agentPicker(this.o, `tk-role-${r}`, s, models, u, t)))))
      .child(u.section("Материалы для агентов", "прочитают, но не изменят"))
      .when(Boolean(this.issue) && nFiles > 0, (x) => x.child(v_flex().pb(8)
        .child(h_flex().gap(8).items_center().pb(2)
          .child(div().text_size(12).text_color(t.muted).child(`Вложения из YouTrack · ${nFiles - this.skip.size} из ${nFiles}`))
          .child(div().text_size(11.5).text_color(t.dim).child("картинки агенты получат с первым сообщением"))
          .child(div().flex_1())
          .child(u.btn("tk-att-all", this.skip.size ? "Все" : "Ни одного", (cx) => {
            if (this.skip.size) this.skip.clear(); else for (const a of full.attachments) this.skip.add(a.id);
          })))
        .children(full.attachments.map((a, i) => {
          const on = !this.skip.has(a.id), f = Array.isArray(this.o.files[this.issue.key]) ? this.o.files[this.issue.key].find((x) => x.id === a.id) : null;
          const fromComment = a.comment ? full.comments?.find((c) => c.id === a.comment) : null;
          return h_flex().id(`tk-att-pick-${i}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .hover((st) => st.bg(t.hover)).on_mouse_down("left", u.stop).on_click((_e, cx) => { if (on) this.skip.add(a.id); else this.skip.delete(a.id); cx.notify(); })
            .child(box(on))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? t.foreground : t.muted).child(a.name))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(`${fromComment ? `из комментария ${fromComment.author}` : a.comment ? "из комментария" : "из описания"} · ${kb(a.size)}`))
            .child(f?.local ? u.btn(`tk-att-see-${i}`, "Посмотреть", (cx) => this.o.openFile(f, cx)) : div().w(0));
        }))))
      .when(Boolean(this.issue) && nComments > 0, (x) => x.child(v_flex().pb(6)
        .child(check("tk-yt-comments", this.withComments, `Комментарии из YouTrack · ${nComments}`, "в TASK.md", () => { this.withComments = !this.withComments; }))))
      .child(v_flex().gap(4)
        .child(h_flex().gap(6).flex_wrap().children(this.files.map((f, i) => h_flex().id(`tk-f-${i}`).h(26).pl(10).pr(4).gap(6).items_center().rounded(6).border_1().border_color(t.border)
          .child(div().text_size(12).max_w(360).truncate().child(f.replace(/^.*\/(go\/src\/[^/]+\/)/, "")))
          .child(div().id(`tk-fx-${i}`).px(4).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_mouse_down("left", u.stop).on_click((_e, cx) => { this.files = this.files.filter((x) => x !== f); cx.notify(); }).child("✕")))))
        .child(u.field(this.fileQ, 30))
        .children(hits.map((rel, i) => h_flex().id(`tk-hit-${i}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", u.stop)
          .on_click((_e, cx) => { this.addFile(this.abs(rel)); this.fileQ.set_value(""); cx.notify(); })
          .child(div().flex_none().text_color(t.dim).child(rel.endsWith("/") ? "▸" : "·")).child(div().flex_1().min_w(0).truncate().text_size(12).child(rel))))
        .when(Boolean(fq) && !this.index, (x) => x.child(div().px(8).text_size(11.5).text_color(t.dim).child("Индексирую файлы…")))
        .child(div().text_size(11.5).text_color(t.dim).child(this.o.presets?.namespaces?.[this.ns]?.docs ? "Спецификации, выгрузки: всё, что нужно прочитать. Страницы документации выбранных сервисов добавятся сами." : "Спецификации, карточки сервисов, выгрузки: всё, что нужно прочитать.")))
      .when(Boolean(this.error), (x) => x.child(div().pt(12).text_size(12).text_color(t.ansi1).child(this.error)));
    // The button stays in sight below the scrolling form.
    return v_flex().flex_1().min_h(0).child(form)
      .child(h_flex().flex_none().px(18).py(12).gap(12).items_center().border_t(1).border_color(t.border)
        .child(u.btn("tk-go", this.busy ? "Запускаю…" : "Взять в работу", (cx) => { if (!this.busy) this.start(cx); }, { primary: true, big: true }))
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.error ? this.error : "Создаст ветку, папку задачи и спейс с агентами. Ничего не пушит.")));
  }
}

export default class Tasks extends View {
  init(_props, cx) {
    this.presets = cached("presets")?.data ?? null;
    OPEN_WITH = this.presets?.open_with ?? [];
    this.ns = store("ns", this.nsList()[0]?.[0] ?? "");
    this.mine = store("mine", "1") === "1";
    this.query = InputState.new({ placeholder: "Поиск по ключу, названию, людям" });
    this.showDone = false;     // finished statuses (youtrack.done) are hidden until asked
    this.query.on("change", (_e, cx) => cx.notify());
    this.chatMsg = InputState.new({ placeholder: "О чём чат (необязательно), Enter: открыть" });
    this.chatMsg.on("submit", (_e, cx) => { const m = this.taskOf(this.sel); if (m) this.newChat(m, cx); });
    this.chatSpec = { agent: "claude", model: "" };
    this.issues = {}; this.sessions = {}; this.files = {};
    this.sel = null;           // { kind: "issue" | "task" | "new", key }; the last one comes back on the next opening
    this.viewer = null;        // an attachment shown over the window: the file entry
    this.area = null;          // the body's size, for fitting the viewer's image
    this.view = "about";       // the right panel: "about" (description), "launch", "task"
    this.launch = null; this.modelMenu = null;
    this.error = {}; this.note = null; this.busy = {}; this.refreshing = {};
    cx.spawn(async (cx) => {
      try {
        const had = this.boardNs();
        this.presets = await htJson(["presets"]); cache("presets", this.presets); OPEN_WITH = this.presets.open_with ?? [];
        if (!this.nsList().some(([n]) => n === this.ns)) this.setNs(cx, this.nsList()[0]?.[0] ?? "");
        else if (had !== this.boardNs()) this.load(cx);
      } catch { }
      cx.notify();
    });
    this.load(cx);
    try { const last = JSON.parse(store("sel", "null")); if (last?.kind && last.kind !== "new" && last.ns === this.ns) cx.timer.after(50, (cx) => this.pick(last, cx)); } catch { }
    // Dev hooks: `herdr-app do tasks.show:<KEY>` (its card), `tasks.launch:<KEY>` (launch panel), `tasks.new:`,
    // `tasks.ns:<namespace>`.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const what = c.slice(0, c.indexOf(":")), key = c.slice(c.indexOf(":") + 1);
        if (what === "new") this.newTask(cx);
        else if (what === "ns") this.setNs(cx, key);
        else if (key) {
          await this.boardP?.catch(() => null);
          const it = this.board?.issues.find((x) => x.key === key);
          const m = this.tasks?.find((x) => x.key === key);
          if (it) this.pick({ kind: "issue", key }, cx, what === "launch" ? "launch" : null);
          else if (m) this.pick({ kind: "task", key }, cx);
        }
        cx.notify();
      }
    });
  }

  // Namespaces as [id, label], from config.json (through `herdr-task presets`).
  nsList() { return Object.entries(this.presets?.namespaces ?? {}).map(([n, x]) => [n, x.label ?? n]); }
  // The namespace that shows the YouTrack board, if one is set up.
  boardNs() { return this.presets?.youtrack?.ns ?? null; }
  hasBoard() { return Boolean(this.ns) && this.ns === this.boardNs(); }
  done() { return this.presets?.youtrack?.done ?? []; }

  // Cached data at once, then the fresh one.
  load(cx) {
    const ns = this.ns;
    const tc = cached(`tasks:${ns}`);
    this.tasks = tc?.data ?? null; this.tasksAt = tc?.at ?? null; this.error = {};
    this.refreshing = { tasks: true, board: this.hasBoard() };
    cx.spawn(async (cx) => {
      try { const list = (await htJson(["ls", "--ns", ns])).filter((m) => m.key); cache(`tasks:${ns}`, list); if (ns === this.ns) { this.tasks = list; this.tasksAt = Date.now(); } }
      catch (e) { if (ns === this.ns) { this.error.tasks = errText(e); this.tasks = this.tasks ?? []; } }
      this.refreshing.tasks = false; cx.notify();
    });
    if (this.hasBoard()) {
      const bc = cached("board");
      this.board = bc?.data ?? null; this.boardAt = bc?.at ?? null;
      this.boardP = htJson(["board"]);
      cx.spawn(async (cx) => {
        try { this.board = await this.boardP; this.boardAt = Date.now(); cache("board", this.board); }
        catch (e) { this.error.board = errText(e); }
        this.refreshing.board = false; cx.notify();
      });
    } else this.board = null;
    if (this.sel?.kind === "task" || this.taskOf(this.sel)) this.loadSessions(this.sel.key, cx);
    cx.notify();
  }

  async fetchIssue(key) {
    const full = await htJson(["issue", key]);
    this.issues[key] = full; cache(`issue:${key}`, full);
    return full;
  }

  loadSessions(key, cx) {
    if (!this.sessions[key]) this.sessions[key] = cached(`sessions:${key}`)?.data ?? null;
    cx.spawn(async (cx) => {
      try { const list = await htJson(["sessions", key, "--ns", this.ns]); this.sessions[key] = list; cache(`sessions:${key}`, list); }
      catch (e) { this.sessions[key] = this.sessions[key] ?? { error: errText(e) }; }
      cx.notify();
    });
  }

  taskOf(sel) { return sel ? this.tasks?.find((m) => m.key === sel.key) ?? null : null; }

  pick(sel, cx, view = null) {
    if (this.sel && sel && this.sel.kind === sel.kind && this.sel.key === sel.key && !view) { this.sel = null; keep("sel", "null"); cx.notify(); return; }
    this.sel = sel; keep("sel", JSON.stringify({ ...sel, ns: this.ns })); this.modelMenu = null; this.launch = null;
    const task = this.taskOf(sel);
    this.view = view ?? (task ? "task" : "about");
    if (sel.kind === "issue") {
      if (!this.issues[sel.key]) this.issues[sel.key] = cached(`issue:${sel.key}`)?.data ?? null;
      if (!this.files[sel.key]) this.files[sel.key] = cached(`files:${sel.key}`)?.data ?? null;
      cx.spawn(async (cx) => {
        try { await this.fetchIssue(sel.key); } catch (e) { if (!this.issues[sel.key]) this.issues[sel.key] = { error: errText(e) }; }
        cx.notify();
        // Attachments come over from the YouTrack machine once; images get a PNG for image().
        if (this.issues[sel.key]?.attachments?.length) {
          try { const f = await htJson(["files", sel.key], 300000); this.files[sel.key] = f; cache(`files:${sel.key}`, f); }
          catch (e) { this.files[sel.key] = this.files[sel.key] ?? { error: errText(e) }; }
          cx.notify();
        }
      });
    }
    if (task) this.loadSessions(sel.key, cx);
    if (this.view === "launch") this.startLaunch(cx);
    cx.notify();
  }

  startLaunch(cx) {
    const it = this.sel?.kind === "issue" ? this.board?.issues.find((x) => x.key === this.sel.key) : null;
    this.launch = new Launch(this, this.sel?.kind === "new" ? this.ns : this.boardNs(), it, cx);
    this.view = "launch";
  }

  newTask(cx) { this.sel = { kind: "new", key: "" }; this.modelMenu = null; this.launch = new Launch(this, this.ns, null, cx); this.view = "launch"; cx.notify(); }

  run(cx, key, label, args, close) {
    if (this.busy[key]) return;
    this.busy[key] = label; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await htJson(args, 600000);
        if (close) { closeOverlay(props().overlay); return; }
      } catch (e) { this.note = { text: `${key}: ${errText(e)}`, bad: true }; }
      delete this.busy[key]; cx.notify();
    });
  }

  // A conversation: a live one shows its tab; another continues in a new tab of the task's space.
  openSession(m, s, cx) {
    if (s.live && s.tab) {
      const sp = spaces().find((x) => (x.tabs ?? []).some((tb) => tb.id === s.tab));
      if (sp) { run("space.select", { id: sp.id }); run("tab.select", { id: s.tab }); closeOverlay(props().overlay); return; }
    }
    this.run(cx, m.key, "Открываю чат…", ["chat", m.key, "--ns", this.ns, "--agent", s.agent, "--resume", s.id, "--folder", s.folder,
      "--name", (s.title || s.who).slice(0, 24)], true);
  }

  setNs(cx, ns) { if (ns === this.ns) return; this.ns = ns; keep("ns", ns); this.sel = null; this.launch = null; this.load(cx); }

  newChat(m, cx) {
    const args = ["chat", m.key, "--ns", this.ns, "--agent", this.chatSpec.agent];
    if (this.chatSpec.model) args.push("--model", this.chatSpec.model);
    if (this.chatMsg.value().trim()) args.push("--message", this.chatMsg.value().trim());
    this.run(cx, m.key, "Открываю…", args, true);
  }

  render(cx) {
    const t = theme(), u = ui(t);
    const status = this.refreshing.board || this.refreshing.tasks ? "обновляю…"
      : (this.hasBoard() ? this.boardAt : this.tasksAt) ? `обновлено ${hm(this.hasBoard() ? this.boardAt : this.tasksAt)}` : "";
    const header = h_flex().h(52).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().pr(4).text_size(15).font_semibold().child("Задачи"))
      .child(u.seg("ns", this.nsList(), this.ns, (v, cx) => this.setNs(cx, v)))
      .when(this.hasBoard(), (x) => x
        .child(div().w(8))
        .child(u.seg("who", [["mine", "Мои"], ["all", "Все"]], this.mine ? "mine" : "all", (v) => { this.mine = v === "mine"; keep("mine", this.mine ? "1" : "0"); }))
        .child(div().w(8))
        .child(h_flex().w(260).h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
          .child(div().text_size(12).text_color(t.dim).child("⌕")).child(Input.new(this.query).flex_1().h_full().text_size(12).text_color(t.foreground))))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.dim).child(status))
      .child(u.btn("refresh", "↻", (cx) => this.load(cx), { tooltip: "Обновить доску и задачи" }))
      .child(u.btn("new", "+ Новая задача", (cx) => this.newTask(cx), { on: this.sel?.kind === "new" }))
      .child(u.btn("close", "✕", () => closeOverlay(props().overlay)));

    if (this.viewer) return v_flex().size_full().bg(t.popover).text_color(t.foreground).text_size(13).child(header).child(this.viewerView(t, u));
    const narrow = Boolean(this.sel);
    const list = v_flex().id("tk-list").flex_1().min_w(0).h_full().min_h(0).overflow_y_scrollbar().px(14).py(10).gap(18)
      .when(Boolean(this.note), (x) => x.child(div().text_size(12).text_color(this.note.bad ? t.ansi1 : t.muted).child(this.note.text)))
      .child(this.workTable(t, u, narrow))
      .when(this.hasBoard(), (x) => x.child(this.boardTable(t, u, narrow)));
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).text_size(13).child(header)
      .child(h_flex().flex_1().min_h(0).items_start().child(list).when(narrow, (x) => x.child(this.panel(t, u))));
  }

  // Table pieces: a caption over the table, a header row of column names, and rows of cells.
  caption(title, extra, t) {
    return h_flex().pb(6).gap(10).items_center()
      .child(div().text_size(13).font_semibold().child(title))
      .when(Boolean(extra), (x) => x.child(extra));
  }
  head(cols, t) {
    return h_flex().h(28).px(8).gap(12).items_center().border_b(1).border_color(t.border)
      .children(cols.map(([label, w]) => (w ? div().w(w).flex_none() : div().flex_1().min_w(0)).text_size(11.5).text_color(t.dim).child(label)));
  }
  row(id, on, cells, onClick, t) {
    return h_flex().id(id).h(32).px(8).gap(12).items_center().border_b(1).border_color(t.border + "66").cursor_pointer()
      .bg(on ? t.selected : t.popover).hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, cx) => onClick(cx))
      .children(cells.map(([content, w, color]) => (w ? div().w(w).flex_none() : div().flex_1().min_w(0)).when(typeof content === "string", (x) => x.truncate())
        .text_size(12.5).text_color(color ?? t.foreground).child(content)));
  }

  // Tasks already started in this namespace (hidden next to the board while there are none).
  workTable(t, u, narrow) {
    if (this.error.tasks) return div().text_size(12).text_color(t.ansi1).child(this.error.tasks);
    const list = this.tasks ?? [];
    if (!list.length) return this.hasBoard() ? div() : div().py(8).text_size(12.5).text_color(t.dim)
      .child(this.tasks ? "Задач пока нет. «+ Новая задача» заведёт первую." : "Загружаю задачи…");
    const cols = narrow ? [["Ключ", 96], ["Название"]] : [["Ключ", 96], ["Название"], ["Спейс", 110], ["Чаты", 70]];
    return v_flex()
      .child(this.caption("В работе", null, t))
      .child(this.head(cols, t))
      .children(list.map((m, i) => this.row(`tk-w-${i}`, this.sel?.key === m.key, [
        [m.keyless ? "—" : m.key, 96, t.muted], [m.title],
        ...(narrow ? [] : [[m.open ? "открыт" : "закрыт", 110, m.open ? t.ansi2 : t.dim], [m.chats ? String(m.chats) : "—", 70, t.muted]]),
      ], (cx) => this.pick({ kind: "task", key: m.key }, cx), t)));
  }

  boardTable(t, u, narrow) {
    const b = this.board;
    if (!b && this.error.board) return div().p(10).rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.ansi1).child(`YouTrack: ${this.error.board}`);
    if (!b) return div().text_size(12).text_color(t.dim).child("Загружаю доску YouTrack…");
    const q = this.query.value().trim().toLowerCase();
    const order = (s) => { const i = b.columns.indexOf(s); return i < 0 ? 999 : i; };
    const matched = b.issues.filter((it) => (!this.mine || it.mine)
      && (!q || `${it.key} ${it.title} ${it.dev.join(" ")} ${it.products.join(" ")}`.toLowerCase().includes(q)))
      .sort((x, y) => order(x.state) - order(y.state) || (y.updated ?? 0) - (x.updated ?? 0));
    const fin = this.done();
    const done = matched.filter((it) => fin.includes(it.state));
    const shown = this.showDone || q ? matched : matched.filter((it) => !fin.includes(it.state));
    const cols = narrow ? [["Ключ", 96], ["Название"]]
      : [["Ключ", 96], ["Название"], ...(this.mine ? [] : [["Исполнитель", 150]]), ["Статус", 130], ["Приоритет", 80], ["Обновлена", 80]];
    return v_flex()
      .child(this.caption(`${b.board} · ${b.sprint}`, h_flex().flex_1().gap(8).items_center()
        .child(div().text_size(12).text_color(t.dim).child(`${shown.length} из ${b.issues.length}`))
        .child(div().flex_1())
        .child(u.btn("tk-board", "Доска в YouTrack ↗", () => openUrl(b.url))), t))
      .when(Boolean(this.error.board), (x) => x.child(div().pb(6).text_size(11.5).text_color(t.ansi1).child(`Не обновилось: ${this.error.board}`)))
      .child(this.head(cols, t))
      .children(shown.map((it, i) => this.row(`tk-b-${i}`, this.sel?.key === it.key, [
        [it.key, 96, t.muted],
        [it.task ? `${it.title}  · в работе` : it.title],
        ...(narrow ? [] : [
          ...(this.mine ? [] : [[it.dev.join(", ") || "—", 150, t.muted]]),
          [it.state, 130, t.muted],
          [it.priority || "—", 80, it.priority === "Critical" ? t.ansi1 : t.muted],
          [ddmm(it.updated), 80, t.muted],
        ]),
      ], (cx) => this.pick({ kind: "issue", key: it.key }, cx), t)))
      .when(!shown.length, (x) => x.child(div().py(8).text_size(12.5).text_color(t.dim).child(this.mine ? "Моих задач в спринте нет." : "Ничего не найдено.")))
      .when(!q && done.length > 0, (x) => x.child(h_flex().pt(8).child(u.btn("tk-done", this.showDone ? "Скрыть завершённые" : `Показать завершённые: ${done.length}`,
        (cx) => { this.showDone = !this.showDone; cx.notify(); }))));
  }

  // The right side: an issue (description, launch), a started task (team, repos, chats), or a new task.
  panel(t, u) {
    const shell = v_flex().id("tk-panel").w_2_5().flex_none().h_full().min_h(0).border_l(1).border_color(t.border).bg(t.background);
    const close = u.btn("tk-x", "✕", (cx) => { this.sel = null; this.launch = null; keep("sel", "null"); cx.notify(); });
    if (this.sel.kind === "new") return shell
      .child(h_flex().px(18).pt(14).pb(4).items_center().child(div().flex_1().text_size(15).font_semibold().child("Новая задача")).child(close))
      .child(this.launch.render(t, u));
    const it = this.sel.kind === "issue" ? this.board?.issues.find((x) => x.key === this.sel.key) : null;
    const m = this.taskOf(this.sel);
    const tabs = [...(m ? [["task", "Задача"]] : []), ...(it ? [["about", "Описание"]] : [])];
    const meta = it ? [it.priority, it.dev.join(", "), it.products.join(", "), it.updated ? `обновлена ${ddmm(it.updated)}` : ""].filter(Boolean).join(" · ") : "";
    const primary = m
      ? u.btn("tk-open", this.busy[m.key] ?? (m.open ? "Перейти в спейс" : "Открыть спейс"), (cx) => this.run(cx, m.key, "Открываю…", ["open", m.key, "--ns", this.ns], true),
        { primary: true, tooltip: m.open ? "Показать спейс задачи" : "Открыть спейс заново: агенты продолжат свои разговоры" })
      : this.view === "launch" ? u.btn("tk-back", "← Назад к описанию", (cx) => { this.view = "about"; this.launch = null; cx.notify(); })
        : u.btn("tk-take", "Взять в работу", (cx) => { this.startLaunch(cx); cx.notify(); }, { primary: true, tooltip: "Выбрать репозитории, команду и материалы, потом запустить" });
    const head = v_flex().px(18).pt(14).pb(12).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(12).text_color(t.muted).child(it ? `${this.sel.key} · ${it.state}` : m?.keyless ? "без номера" : this.sel.key))
        .when(Boolean(it), (x) => x
          .child(u.btn("tk-yt", "YouTrack ↗", () => openUrl(it.url))))
        .child(close))
      .child(div().text_size(16).font_semibold().child(it?.title ?? m?.title ?? ""))
      .when(Boolean(meta), (x) => x.child(div().text_size(12).text_color(t.muted).child(meta)))
      .child(h_flex().pt(2).gap(8).items_center().child(primary).child(div().flex_1())
        .when(tabs.length > 1 && this.view !== "launch", (x) => x.child(u.seg("tk-tab", tabs, this.view, (v) => { this.view = v; }))));
    let body;
    if (this.view === "launch" && this.launch) body = this.launch.render(t, u);
    else if (this.view === "task" && m) body = this.taskView(m, t, u);
    else body = this.about(it, t, u);
    return shell.child(head).child(body);
  }

  // Markdown with its images in place: text through TextView (as Explorer shows Markdown), each image as
  // its PNG, sized to the panel; a click on an image or on a link to an attachment opens it in Explorer.
  md(id, text, key, commentId, t) {
    const files = Array.isArray(this.files[key]) ? this.files[key] : [];
    const meta = this.issues[key]?.attachments ?? [];
    const find = (name) => {
      const ids = new Set(meta.filter((x) => x.name === name && (x.comment ?? null) === (commentId ?? null)).map((x) => x.id));
      return files.find((f) => ids.has(f.id)) ?? files.find((f) => f.name === name) ?? null;
    };
    const link = (url, cx) => {
      const f = !/^[a-z][a-z0-9+.-]*:/i.test(url) ? find(decodeURIComponent(url)) : null;
      if (f?.local) this.openFile(f, cx); else openUrl(url);
    };
    return v_flex().gap(6).children(mdParts(text, meta.map((x) => x.name)).map((p, i) => {
      if (p.md) return TextView.markdown(`${id}-${i}`, p.md).selectable(true).on_link_click((url, cx) => link(url, cx));
      const f = find(p.img);
      if (!f?.png) return div().text_size(12).text_color(t.dim).child(Array.isArray(this.files[key]) ? `[${p.img}]` : `[${p.img}: загружаю…]`);
      const w = Math.min(f.w || 520, 520), h = f.w ? Math.round((f.h * w) / f.w) : 300;
      return div().id(`${id}-img-${i}`).w(w).h(h).rounded(6).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
        .tooltip(`${f.name}: открыть`).on_click((_e, cx) => this.openFile(f, cx))
        .child(image(f.png).w(w).h(h));
    }));
  }

  // An image opens over the window (closing it comes back here); other files open in Explorer's viewer tab.
  openFile(f, cx) {
    this.viewer = f; this.viewerText = null;
    const kind = kindOf(f);
    if ((kind === "md" || kind === "text") && (f.size ?? 0) <= 2 * 1048576)
      cx.spawn(async (cx) => { const text = await readTextFile(f.local).catch(() => null); if (this.viewer === f) { this.viewerText = text ?? ""; cx.notify(); } });
    cx.notify();
  }

  viewerView(t, u) {
    const f = this.viewer, kind = kindOf(f);
    const head = h_flex().h(48).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
      .child(u.btn("tk-v-back", "← Назад", (cx) => { this.viewer = null; this.viewerText = null; cx.notify(); }))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(f.name))
      .child(div().text_size(12).text_color(t.dim).child(f.w ? `${f.w}×${f.h} · ${kb(f.size)}` : kb(f.size)))
      .child(u.btn("tk-v-dl", "Скачать", () => download(f.local, f.name), { primary: true, tooltip: "Копия в ~/Downloads" }))
      .when(kind === "other", (x) => x.child(u.btn("tk-v-app", "Открыть в приложении", () => exec("open", [f.local]).catch(() => {}), { tooltip: "Приложением macOS по умолчанию (Excel, Numbers, Preview…)" })));
    const shell = v_flex().flex_1().min_h(0).child(head);
    if (kind === "image") {
      const aw = (this.area?.width ?? 1200) - 48, ah = (this.area?.height ?? 700) - 24;
      const k = Math.min(1, aw / (f.w || aw), ah / (f.h || ah));
      const w = Math.round((f.w || aw) * k), h = Math.round((f.h || ah) * k);
      return shell.child(div().id("tk-v-area").flex_1().min_h(0).flex().items_center().justify_center().p(12)
        .on_size_change((size, cx) => { if (!this.area || Math.abs(this.area.width - size.width) > 1 || Math.abs(this.area.height - size.height) > 1) { this.area = { width: size.width, height: size.height }; cx.notify(); } })
        .child(image(f.png).w(w).h(h)));
    }
    if (kind === "md" || kind === "text") {
      const text = this.viewerText;
      const body = v_flex().id("tk-v-text").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16);
      if (text == null) return shell.child(body.child(div().text_size(12).text_color(t.dim).child((f.size ?? 0) > 2 * 1048576 ? "Файл больше 2 МБ: скачайте его." : "Читаю файл…")));
      if (kind === "md") return shell.child(body.child(TextView.markdown("tk-v-md", text).selectable(true).on_link_click((url) => openUrl(url))));
      const lines = text.split("\n");
      return shell.child(body.font_family("JetBrains Mono").text_size(12)
        .children(lines.slice(0, 3000).map((l) => div().whitespace_nowrap().child(l || " ")))
        .when(lines.length > 3000, (x) => x.child(div().pt(8).text_color(t.dim).child(`… ещё ${lines.length - 3000} строк: скачайте файл`))));
    }
    return shell.child(v_flex().flex_1().min_h(0).items_center().justify_center().gap(10)
      .child(div().text_size(15).font_semibold().child(f.name))
      .child(div().text_size(12.5).text_color(t.muted).child(`${f.mime || "файл"} · ${kb(f.size)}`))
      .child(div().text_size(12.5).text_color(t.dim).child("Просмотра для этого формата нет: скачайте или откройте в приложении."))
      .child(h_flex().pt(6).gap(8)
        .child(u.btn("tk-v-dl2", "Скачать", () => download(f.local, f.name), { primary: true, big: true }))
        .child(u.btn("tk-v-app2", "Открыть в приложении", () => exec("open", [f.local]).catch(() => {}), { big: true }))));
  }

  about(it, t, u) {
    const full = it ? this.issues[it.key] : null;
    const files = it ? this.files[it.key] : null;
    const atts = full?.attachments ?? [];
    const comments = full?.comments ?? [];
    const local = (a) => (Array.isArray(files) ? files.find((f) => f.id === a.id) : null);
    return v_flex().id("tk-about").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(4)
      .when(Boolean(full?.guess?.length) && !it?.task, (x) => x.child(div().pb(8).text_size(12).text_color(t.dim).child(`Похоже, репозитории: ${full.guess.join(", ")}`)))
      .when(Boolean(full?.error), (x) => x.child(div().text_size(12).text_color(t.ansi1).child(full.error)))
      .when(!full, (x) => x.child(div().text_size(12).text_color(t.dim).child("Загружаю описание…")))
      .when(Boolean(full) && !full.error && !full.desc, (x) => x.child(div().text_size(12).text_color(t.dim).child("Описания нет.")))
      .when(Boolean(full?.desc), (x) => x.child(this.md("tk-desc", full.desc, it.key, null, t)))
      .when(atts.length > 0, (x) => x
        .child(div().pt(20).pb(6).text_size(13).font_semibold().child(`Вложения · ${atts.length}`))
        .when(Boolean(files?.error), (y) => y.child(div().pb(4).text_size(12).text_color(t.ansi1).child(`Не скачались: ${files.error}`)))
        .child(this.head([["Файл"], ["Тип", 120], ["Размер", 70], ["", 90]], t))
        .children(atts.map((a, i) => {
          const f = local(a);
          return this.row(`tk-att-${i}`, false, [[a.name], [a.mime || "—", 120, t.muted], [kb(a.size), 70, t.muted],
            [f?.local ? u.btn(`tk-dl-${i}`, "Скачать", () => download(f.local, a.name), { fill: true, tooltip: "Копия в ~/Downloads" }) : "", 90]],
            (cx) => { if (f?.local) this.openFile(f, cx); }, t);
        }))
        .when(!Array.isArray(files) && !files?.error, (y) => y.child(div().pt(4).text_size(11.5).text_color(t.dim).child("Скачиваю вложения…"))))
      .when(comments.length > 0, (x) => x
        .child(div().pt(20).pb(6).text_size(13).font_semibold().child(`Комментарии · ${comments.length}`))
        .children(comments.map((c, i) => v_flex().py(10).gap(6).border_t(1).border_color(t.border)
          .child(h_flex().gap(8).items_baseline()
            .child(div().text_size(12.5).font_semibold().child(c.author || "—"))
            .child(div().text_size(11.5).text_color(t.dim).child(c.created ? `${ddmm(c.created)} ${hm(c.created)}` : "")))
          .child(this.md(`tk-c-${i}`, c.text, it.key, c.id, t)))));
  }

  // A started task: its team and repos, then its chats as a table with a new-chat row last.
  taskView(m, t, u) {
    const list = this.sessions[m.key];
    const models = this.presets?.models ?? {};
    const team = Object.entries(m.agents ?? {});
    const kv = (k, v) => h_flex().gap(12).items_start().py(3).child(div().w(110).flex_none().text_size(12.5).text_color(t.muted).child(k)).child(div().flex_1().min_w(0).text_size(12.5).child(v));
    const chats = Array.isArray(list) ? list : [];
    return v_flex().id("tk-task").flex_1().min_h(0).overflow_y_scrollbar().px(18).pb(18)
      .child(u.section("Задача"))
      .child(kv("Ветка", m.branch || "агент ещё не создал"))
      .child(kv("Репозитории", (m.repos ?? []).map((r) => r.name).join(", ") || "агент выберет сам"))
      .when(team.length > 0, (x) => x.children(team.map(([r, a]) => kv(ROLE[r] ?? r, [a.agent === "claude" ? "Claude" : "Codex", a.model || "модель по умолчанию"].join(" · ")))))
      .child(kv("Папка", m.dir))
      .child(u.section("Чаты", "идущий открывает свою вкладку, остальные продолжаются в новой"))
      .child(this.head([["Кто", 100], ["О чём"], ["Агент", 60], ["Когда", 86]], t))
      .when(!list, (x) => x.child(div().py(8).text_size(12).text_color(t.dim).child("Ищу разговоры…")))
      .when(Boolean(list?.error), (x) => x.child(div().py(8).text_size(12).text_color(t.ansi1).child(list.error)))
      .when(Array.isArray(list) && !chats.length, (x) => x.child(div().py(8).text_size(12).text_color(t.dim).child("Разговоров пока нет.")))
      .children(chats.map((s, i) => this.row(`tk-s-${i}`, false, [
        [ROLE[s.who] ?? s.who, 100, t.muted], [s.title || "без названия"],
        [s.agent === "claude" ? "Claude" : "Codex", 60, t.muted], [s.live ? "идёт" : when(s.at), 86, s.live ? t.ansi2 : t.muted],
      ], (cx) => this.openSession(m, s, cx), t)))
      .child(v_flex().pt(12).gap(8)
        .child(div().text_size(12.5).font_semibold().child("Новый чат"))
        .child(agentPicker(this, "tk-chat", this.chatSpec, models, u, t))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().child(u.field(this.chatMsg, 30)))
          .child(u.btn("tk-chat-go", this.busy[m.key] ?? "Открыть чат", (cx) => this.newChat(m, cx), { primary: true }))));
  }
}
