// Modified from Herdr's built-in `machine-add` mod (github.com/herdrdev/herdr-app, Apache-2.0, see LICENSE here).
// Added: "Make a key and log in without a password". With the box ticked
// (or when a host from ~/.ssh/config asks for a password) the dialog takes
// the password once and runs bin/ssh-add-host: it checks the host key with
// you, makes ~/.ssh/keys/id_ed25519_<name>, puts the public half into the
// machine's authorized_keys, writes `Host <name>` to ~/.ssh/config, checks
// the login, and then the machine is added as usual.
//
// Add a machine: the hosts in ~/.ssh/config to pick from (or type one),
// each added with one click (`hc machine add`). When the machine needs
// something first (herdr-core installed there, a password, a new host
// key), the picker explains what to run in a terminal. Machines that need
// no answers are added quietly. Opened as a dialog
// (`mod.open machine-add`); the sidebars' Add machine and the welcome
// open it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { hc, exec, home, appHome, readTextFile, writeTextFile, theme, props, closeOverlay } from "herdr";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const SCRIPT = () => `${appHome()}/bin/ssh-add-host`;
const ASKS_PASSWORD = ["login_needed", "auth_failed"];
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shellArg = (target) => /^[a-z0-9_@%+=:,./-]+$/i.test(target) ? target : "'" + target.replace(/'/g, "'\\''") + "'";

// An Include's files, as ssh finds them: ~ is home, a relative path is
// under ~/.ssh, and a pattern matches files (through sh; none where there's no sh).
async function includeFiles(value) {
  const paths = (value.match(/"[^"]*"|\S+/g) ?? [])
    .map((p) => p.replace(/^"|"$/g, ""))
    .map((p) => (p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p.startsWith("/") || /^[a-z]:[\\/]/i.test(p) ? p : `${home()}/.ssh/${p}`));
  const files = [];
  for (const p of paths) {
    if (!/[*?[]/.test(p)) {
      files.push(p);
      continue;
    }
    // From a Windows program, Git's sh gets the pattern already expanded, one
    // argument per file, unless a space made it quoted: then sh expands it, and
    // takes a backslash as an escape. So read every argument, never split one
    // at its spaces, and give sh slashes.
    const glob = /^[a-z]:/i.test(p) ? p.replace(/\\/g, "/") : p;
    const r = await exec("sh", ["-c", 'IFS=; for p in "$@"; do for f in $p; do [ -f "$f" ] && printf "%s\\n" "$f"; done; done', "sh", glob]).catch(() => null);
    files.push(...(r?.stdout ?? "").split("\n").filter(Boolean));
  }
  return files;
}

// Host entries people can pick: named ones, not patterns, from the file
// and the files it includes (ssh stops 16 deep).
async function parseConfig(text, hosts = [], depth = 0) {
  let cur = null;
  for (const raw of (text ?? "").split("\n")) {
    const m = raw.trim().match(/^([^\s#=]+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "host" || key === "match") {
      const names = key === "host" ? value.split(/\s+/).filter((h) => h && !/[*?!]/.test(h) && !hosts.some((x) => x.alias === h || x.aliases.includes(h))) : [];
      cur = names.length ? { alias: names[0], aliases: names.slice(1), hostname: null, user: null } : null;
      if (cur) hosts.push(cur);
    } else if (key === "include" && depth < 16) {
      for (const f of await includeFiles(value)) await parseConfig(await readTextFile(f).catch(() => null), hosts, depth + 1);
    } else if (cur && key === "hostname") cur.hostname = value;
    else if (cur && key === "user") cur.user = value;
  }
  return hosts;
}

export default class MachineAdd extends View {
  init(_props, cx) {
    this.hosts = null;
    this.added = [];
    this.state = {}; // target -> "adding" | error text
    this.pending = new Set();
    this.refreshing = false;
    this.typed = "";
    this.input = InputState.new({ placeholder: "user@host" });
    this.input.on("change", (_e, cx) => { this.typed = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submitTyped(cx));
    // Make a key: one job at a time, for the typed host ("typed") or a host
    // from the list that asked for a password (this.offer).
    this.keyMode = false;
    this.offer = null;
    this.job = null; // { key, name, host, port, phase: scanning|confirm|setting|done|error, fps, steps, error }
    this.pw = InputState.new({ placeholder: "password" });
    this.pw.set_masked(true);
    this.pw.on("submit", (_e, cx) => (this.offer ? this.keyExisting(this.offer, cx) : this.keyTyped(cx)));
    this.portIn = InputState.new({ placeholder: "port 22" });
    this.nameIn = InputState.new({ placeholder: "name: from the host" });
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.macs = {}; // target -> { name, core } for an added Mac
    this.opened = {};
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      this.hosts = await parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null));
      await this.refresh();
      cx.notify();
    });
    cx.timer.every(3000, (cx) => {
      if (!this.pending.size || this.refreshing) return;
      this.refreshing = true;
      cx.spawn(async (cx) => {
        try {
          await this.refresh();
          cx.notify();
        } finally {
          this.refreshing = false;
        }
      });
    });
  }

  async refresh() {
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try {
      this.added = r?.code === 0 ? (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary) : [];
    } catch {
      this.added = [];
    }
    for (const target of this.pending) {
      if (!this.isAdded(target)) continue;
      this.pending.delete(target);
      delete this.state[target];
      if (this.typed.trim() === target) {
        this.input.set_value("");
        this.typed = "";
      }
      await this.checkMac(target);
    }
  }

  isAdded(target) {
    return this.added.some((m) => m.target === target || m.name === target || m.host === target);
  }

  add(target, cx) {
    target = target.trim();
    if (!target || this.state[target] === "adding") return;
    this.pending.delete(target);
    this.state[target] = "adding";
    cx.notify();
    cx.spawn(async (cx) => {
      await this.doAdd(target);
      cx.notify();
    });
  }

  async doAdd(target) {
      const r = await hc(["machine", "add", target, "--json"]).catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      let why = null;
      try {
        why = r.code === 0 ? null : (JSON.parse(r.stdout || r.stderr).error ?? { message: (r.stderr || r.stdout).trim() });
      } catch {
        why = { message: (r.stderr || r.stdout || "it didn't answer").trim() };
      }
      if (!why) {
        delete this.state[target];
        this.input.set_value("");
        this.typed = "";
        await this.refresh();
        await this.checkMac(target);
      } else if (ASKS_PASSWORD.includes(why.kind) || (!why.kind && /password|permission denied/i.test(why.message ?? ""))) {
        this.pending.add(target);
        // A host from ~/.ssh/config gets a password field under its row; a
        // typed one ticks the box, so its name and port can be set too.
        if (this.knownAlias(target)) {
          this.offer = target;
          this.keyMode = false;
        } else this.keyMode = true;
        this.state[target] = `${target} asks for a password. Type it below once: Herdr makes a key, puts it on ${target} and logs in without a password from then on. Or run \`hc machine add ${shellArg(target)}\` in a terminal.`;
      } else if (["hc_missing", "incompatible", "login_needed", "auth_failed", "host_key"].includes(why.kind) || /password|passphrase|host key|permission denied|login/i.test(why.message ?? "")) {
        const quoted = shellArg(target);
        this.pending.add(target);
        this.state[target] = `Couldn't add ${target} here: it needs you to answer something (a password, a new host key, or installing herdr-core there). Run \`hc machine add ${quoted}\` in a terminal. \`hc machine --help\` shows the options.`;
      } else this.state[target] = why.message || "it didn't work";
      await this.refresh();
  }

  // ---- Make a key and log in without a password (bin/ssh-add-host) ----

  submitTyped(cx) {
    if (this.keyMode) this.keyTyped(cx);
    else this.add(this.typed, cx);
  }

  busy() {
    return this.job?.phase === "scanning" || this.job?.phase === "setting";
  }

  knownAlias(name) {
    return (this.hosts ?? []).some((h) => h.alias === name || h.aliases.includes(name));
  }

  keyTyped(cx) {
    const spec = this.typed.trim();
    if (!spec || this.busy()) return;
    const host = spec.slice(spec.lastIndexOf("@") + 1);
    if (this.knownAlias(host) && host === spec) return this.keyExisting(host, cx, "typed");
    const name = this.nameIn.value().trim() || (/^[\d.]+$|:/.test(host) ? host.replace(/[^A-Za-z0-9._-]/g, "-") : host.split(".")[0]);
    if (this.knownAlias(name)) {
      this.job = { key: "typed", phase: "error", steps: [], error: `${name} is already in ~/.ssh/config: give this one another name` };
      return cx.notify();
    }
    this.startJob({ key: "typed", name, host: spec, port: this.portIn.value().trim() }, cx);
  }

  keyExisting(target, cx, key = target) {
    if (this.busy()) return;
    this.startJob({ key, name: target, host: null, port: "" }, cx);
  }

  startJob(job, cx) {
    const fail = (error) => { this.job = { ...job, phase: "error", steps: [], error }; cx.notify(); };
    if (!/^[A-Za-z0-9._-]+$/.test(job.name)) return fail("The name may have letters, digits, dot, dash and underscore");
    if (job.port && !/^\d+$/.test(job.port)) return fail("The port is a number");
    if (!this.pw.value()) return fail("Type the password first");
    this.job = { ...job, phase: "scanning", steps: [] };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.script(["--json", "scan", job.host ?? job.name, ...(job.port ? ["-p", job.port] : [])]);
      if (this.job?.key !== job.key) return;
      if (!r.ok) Object.assign(this.job, { phase: "error", error: r.error });
      else if (r.known) return this.setup(cx, null);
      else Object.assign(this.job, { phase: "confirm", fps: r.fingerprints ?? [] });
      cx.notify();
    });
  }

  async script(args) {
    const r = await exec(SCRIPT(), args, { timeout: 120000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { ok: false, error: (r.stderr || r.stdout || "ssh-add-host didn't answer").trim() };
    }
  }

  trust(cx) {
    const fps = this.job?.fps ?? [];
    const fp = (fps.find((f) => f.type === "ED25519") ?? fps[0])?.fingerprint;
    if (!fp) return;
    cx.spawn(async (cx) => this.setup(cx, fp));
  }

  // The password goes to the script in a file in a fresh private temp
  // folder; the script deletes it as soon as it has read it.
  async setup(cx, fingerprint) {
    const job = this.job;
    job.phase = "setting";
    cx.notify();
    const dir = (await exec("mktemp", ["-d"]).catch(() => null))?.stdout?.trim();
    let r = { ok: false, error: "Couldn't make a temp folder for the password" };
    if (dir) {
      try {
        await writeTextFile(`${dir}/pw`, this.pw.value(), null);
        r = await this.script(["--json", "setup", "--name", job.name, ...(job.host ? ["--host", job.host] : []), ...(job.port ? ["-p", job.port] : []), "--password-file", `${dir}/pw`, ...(fingerprint ? ["--fingerprint", fingerprint] : [])]);
      } catch (e) {
        r = { ok: false, error: String(e) };
      } finally {
        await exec("rm", ["-rf", dir]).catch(() => null);
      }
    }
    if (this.job !== job) return;
    job.steps = r.steps ?? [];
    if (!r.ok) {
      Object.assign(job, r.kind === "host_key_changed" ? { phase: "confirm", fps: r.fingerprints ?? [], error: r.error } : { phase: "error", error: r.error });
      return cx.notify();
    }
    job.phase = "done";
    this.pw.set_value("");
    if (job.key === "typed") {
      for (const s of [this.input, this.nameIn, this.portIn]) s.set_value("");
      this.typed = "";
    }
    this.offer = null;
    this.pending.delete(job.name);
    this.hosts = await parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null));
    this.state[job.name] = "adding";
    cx.notify();
    await this.doAdd(job.name);
    cx.notify();
  }

  // macOS asks on its own screen before anything reads Desktop, Documents
  // or Downloads, and the asking program waits: say so once, with the way
  // to allow it for good.
  async checkMac(target) {
    const m = this.added.find((x) => x.target === target || x.name === target);
    if (!m) return;
    const r = await exec("sh", ["-c", 'uname; command -v herdr-core || echo "$HOME/.local/bin/herdr-core"'], { on: m.name }).catch(() => null);
    const [os, core] = (r?.stdout ?? "").trim().split("\n");
    if (os === "Darwin") this.macs[target] = { name: m.name, core: core ?? "~/.local/bin/herdr-core" };
  }

  macCard(t, target) {
    const mac = this.macs[target];
    return v_flex()
      .mx(10)
      .mb(8)
      .p(12)
      .gap(8)
      .rounded(10)
      .bg(t.blocked + "14")
      .border_1()
      .border_color(t.blocked + "40")
      .child(div().text_size(12.8).font_semibold().text_color(t.foreground).child(`${mac.name} is a Mac: allow its folders once`))
      .child(
        div()
          .text_size(12.5)
          .line_height("18px")
          .text_color(t.muted)
          .child("macOS asks on the Mac's own screen before an agent reads Desktop, Documents or Downloads, and waits until someone answers. Give herdr-core Full Disk Access there and it never asks again: in the list, press + and pick this file:"),
      )
      .child(div().px(8).py(4).rounded(6).bg(t.background).border_1().border_color(t.border).text_size(12).text_color(t.foreground).child(mac.core))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .id(`ma-mac-${target}`)
              .h(28)
              .px(12)
              .flex()
              .items_center()
              .rounded(7)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.opacity(0.88))
              .on_click((_e, cx) => {
                exec("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], { on: mac.name }).catch(() => null);
                this.opened[target] = true;
                cx.notify();
              })
              .child(`Open the setting on ${mac.name}`),
          )
          .when(Boolean(this.opened[target]), (el) => el.child(div().text_size(12).text_color(t.dim).child("It's open on the Mac's screen."))),
      );
  }

  checkbox(t, id, on, label, toggle) {
    return h_flex()
      .id(id)
      .gap(8)
      .items_center()
      .cursor_pointer()
      .on_click(toggle)
      .child(
        div()
          .size(15)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .border_1()
          .border_color(on ? t.accent : t.input)
          .bg(on ? t.accent : t.background)
          .when(on, (el) => el.child(svg(I("check")).size(11).text_color(t.solid_foreground))),
      )
      .child(div().text_size(12.5).text_color(t.foreground).child(label));
  }

  field(t, state, width) {
    const el = Input.new(state).h(30).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    return width ? el.w(width).flex_none() : el.flex_1();
  }

  button(t, id, label, solid, action) {
    return div()
      .id(id)
      .h(30)
      .px(12)
      .flex()
      .flex_none()
      .items_center()
      .rounded(7)
      .text_size(12)
      .font_medium()
      .cursor_pointer()
      .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(!solid, (el) => el.border_1().border_color(t.input).bg(t.raised).hover((s) => s.bg(t.hover)))
      .when(this.busy(), (el) => el.opacity(0.4))
      .on_click(action)
      .child(label);
  }

  // Password field and button under a listed host that asked for one.
  offerRow(t, target) {
    return h_flex()
      .gap(8)
      .pt(2)
      .child(this.field(t, this.pw))
      .child(this.button(t, `ma-key-${target}`, "Make a key and add", true, (_e, cx) => this.keyExisting(target, cx)));
  }

  // What the key job is doing, what it did, and the host key to confirm.
  jobView(t) {
    const job = this.job;
    const spin = (text) => h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(svg(I("spinner")).size(12).text_color(t.working).spin(900)).child(text);
    const steps = (job.steps ?? []).map((s, i) =>
      h_flex().id(`ma-step-${i}`).gap(6).items_start().text_size(12).text_color(t.muted)
        .child(svg(I("circle-check")).size(12).mt(2).flex_none().text_color(t.ansi2))
        .child(div().flex_1().min_w(0).child(TextView.html(`ma-step-text-${i}`, `<span><b>${esc(s.step)}</b>: ${esc(s.text)}</span>`).selectable(true))));
    const col = v_flex().gap(5).pt(6).children(steps);
    if (job.phase === "scanning") return col.child(spin("Looking at the host key…"));
    if (job.phase === "setting") return col.child(spin("Logging in with the password, putting the key there…"));
    if (job.phase === "error") return col.child(div().text_size(12).text_color(t.blocked).child(TextView.html("ma-job-error", `<span>${esc(job.error)}</span>`).selectable(true)));
    if (job.phase === "confirm") {
      return col.child(
        v_flex()
          .p(10)
          .gap(6)
          .rounded(8)
          .bg(t.blocked + "14")
          .border_1()
          .border_color(t.blocked + "40")
          .when(Boolean(job.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(job.error)))
          .child(div().text_size(12.5).text_color(t.foreground).child(`This Mac hasn't met ${job.host ?? job.name} before. If you can, compare its key with what the machine's owner sees (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub there):`))
          .children((job.fps ?? []).map((f, i) => h_flex().id(`ma-fp-${i}`).gap(8).text_size(12).child(div().w(64).flex_none().text_color(t.dim).child(f.type)).child(div().flex_1().min_w(0).text_color(t.foreground).child(TextView.html(`ma-fp-text-${i}`, `<span>${esc(f.fingerprint)}</span>`).selectable(true)))))
          .child(
            h_flex()
              .gap(8)
              .pt(2)
              .child(this.button(t, "ma-trust", "Trust and continue", true, (_e, cx) => this.trust(cx)))
              .child(this.button(t, "ma-cancel", "Cancel", false, (_e, cx) => { this.job = null; cx.notify(); })),
          ),
      );
    }
    return col;
  }

  close() {
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
  }

  message(t, target) {
    const text = String(this.state[target]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const command = `hc machine add ${shellArg(target)}`;
    return v_flex().gap(5)
      .child(div().text_size(12).text_color(t.blocked).child(TextView.html(`ma-message-${target}`, `<span>${text}</span>`).selectable(true)))
      .when(this.pending.has(target), (el) => el.child(h_flex().child(div()
        .id(`ma-copy-${target}`).px(10).py(4).rounded(6).bg(t.raised).text_color(t.foreground)
        .text_size(12).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { cx.write_to_clipboard(command); this.copiedCommand = command; cx.notify(); })
        .child(this.copiedCommand === command ? "Copied" : "Copy"))));
  }

  row(t, target, label, sub) {
    const st = this.state[target];
    const done = this.isAdded(target);
    const right = done
      ? h_flex().gap(5).items_center().text_size(12).text_color(t.ansi2).child(svg(I("circle-check")).size(13)).child("Added")
      : st === "adding"
        ? h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(svg(I("spinner")).size(12).text_color(t.working).spin(900)).child("Connecting")
        : div()
              .id(`ma-add-${target}`)
              .px(10)
              .h(26)
              .flex()
              .items_center()
              .rounded(7)
              .border_1()
              .border_color(t.input)
              .bg(t.raised)
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.add(target, cx))
              .child("Add");
    const idle = !done && !st;
    return v_flex()
      .flex_none()
      .child(
        h_flex()
          .id(`ma-row-${target}`)
          .h(40)
          .px(10)
          .gap(10)
          .items_center()
          .rounded(8)
          .hover((s) => s.bg(t.hover))
          .when(idle, (el) => el.cursor_pointer().on_click((_e, cx) => this.add(target, cx)))
          .child(svg(I("server")).size(15).text_color(t.muted))
          .child(div().flex_none().text_size(13).text_color(t.foreground).child(label))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(sub ?? ""))
          .child(right),
      )
      .when(typeof st === "string" && st !== "adding", (el) => el.child(div().px(35).pb(6).child(this.message(t, target))))
      .when(this.offer === target && !done, (el) => el.child(div().px(35).pb(6).child(this.offerRow(t, target))))
      .when(this.job?.key === target, (el) => el.child(div().px(35).pb(8).child(this.jobView(t))))
      .when(Boolean(this.macs[target]), (el) => el.child(this.macCard(t, target)));
  }

  render() {
    const t = theme();
    const hosts = this.hosts ?? [];
    return v_flex()
      .id("machine-add")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Add a machine")).child(div().id("ma-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(
        div()
          .pt(6)
          .text_size(12.8)
          .line_height("19px")
          .text_color(t.muted)
          .child("A VPS, a Mac mini, a box at home: Herdr reaches it over ssh, and agents there keep running while your laptop sleeps."),
      )
      .child(div().pt(16).pb(6).text_size(11.5).font_medium().text_color(t.dim).child(hosts.length ? "From your ssh config" : "Your ssh config lists no hosts"))
      .child(
        v_flex()
          .id("ma-hosts")
          .max_h(280)
          .min_h(0)
          .flex_shrink(1)
          .overflow_y_scroll()
          .children(
            this.hosts === null
              ? [div().px(10).py(8).text_size(12.5).text_color(t.dim).child("Reading ~/.ssh/config…")]
              : hosts.map((h) => this.row(t, h.alias, h.alias, [h.user, h.hostname].filter(Boolean).join("@") || (h.aliases.length ? `also ${h.aliases.join(", ")}` : ""))),
          ),
      )
      .child(div().pt(14).pb(6).text_size(11.5).font_medium().text_color(t.dim).child("Or type how ssh reaches it"))
      .child(
        h_flex()
          .gap(8)
          .child(
            Input.new(this.input)
              .flex_1()
              .h(34)
              .px(10)
              .gap(6)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(this.inputFocused ? t.accent : t.input)
              .bg(t.background)
              .text_size(13)
              .text_color(t.foreground),
          )
          .child(
            div()
              .id("ma-add-typed")
              .h(34)
              .px(14)
              .flex()
              .items_center()
              .rounded(8)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12.5)
              .font_medium()
              .when(!this.typed.trim() || this.busy(), (el) => el.opacity(0.4))
              .cursor_pointer()
              .on_click((_e, cx) => this.submitTyped(cx))
              .child("Add"),
          ),
      )
      .when(Boolean(this.typed.trim() && this.state[this.typed.trim()]), (el) => el.child(div().pt(6).child(this.message(t, this.typed.trim()))))
      .child(
        div().pt(10).child(
          this.checkbox(t, "ma-key-mode", this.keyMode, "Make a key and log in without a password", (_e, cx) => {
            this.keyMode = !this.keyMode;
            if (this.keyMode) this.offer = null;
            if (this.job?.key === "typed" && !this.busy()) this.job = null;
            cx.notify();
          }),
        ),
      )
      .when(this.keyMode, (el) =>
        el.child(
          v_flex()
            .pt(8)
            .gap(6)
            .child(h_flex().gap(8).child(this.field(t, this.pw)).child(this.field(t, this.portIn, 90)).child(this.field(t, this.nameIn, 150)))
            .child(div().text_size(11.5).line_height("16px").text_color(t.dim).child("The password is used once, to put a new key from ~/.ssh/keys there, and isn't saved. The name becomes the Host in ~/.ssh/config and the machine's name in Herdr.")),
        ),
      )
      .when(this.job?.key === "typed", (el) => el.child(this.jobView(t)));
  }
}
