// Modified from Herdr's built-in `machine-add` mod (github.com/herdrdev/herdr-app, Apache-2.0, see LICENSE here):
// reading ~/.ssh/config (includeFiles, parseConfig) is theirs, the dialog is rewritten.
//
// Connect a machine. On the left: New machine, the machines Herdr has (with
// their state) and the hosts in ~/.ssh/config it doesn't have yet. On the
// right: the form for the one picked, then the connection steps, live.
// "Password once, then a key" runs bin/ssh-add-host step by step: host key
// (you confirm a new one), a key in ~/.ssh/keys, the public half into the
// machine's authorized_keys, `Host <name>` in ~/.ssh/config, a login check
// without the password; then `hc machine add --install`. "Password only"
// adds the machine with the password through SSH_ASKPASS and saves nothing.
// "Already set up" only adds the machine. Opened as a dialog (`mod.open machine-add-plus`)
// from Add machine in the sidebar (workspace-chrome-plus).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { hc, exec, home, appHome, readTextFile, writeTextFile, theme, props, closeOverlay, settings, run } from "herdr";

const I = (name) => `mods/machine-add-plus/icons/${name}.svg`;
const SCRIPT = () => `${appHome()}/bin/ssh-add-host`;
const MONO = () => settings().font_family || "JetBrains Mono";
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shellArg = (s) => (/^[a-z0-9_@%+=:,./-]+$/i.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
const me = () => home().split("/").pop();

// An Include's files, as ssh finds them: ~ is home, a relative path is
// under ~/.ssh, and a pattern matches files (through sh).
async function includeFiles(value) {
  const paths = (value.match(/"[^"]*"|\S+/g) ?? [])
    .map((p) => p.replace(/^"|"$/g, ""))
    .map((p) => (p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p.startsWith("/") ? p : `${home()}/.ssh/${p}`));
  const files = [];
  for (const p of paths) {
    if (!/[*?[]/.test(p)) {
      files.push(p);
      continue;
    }
    const r = await exec("sh", ["-c", 'IFS=; for p in "$@"; do for f in $p; do [ -f "$f" ] && printf "%s\\n" "$f"; done; done', "sh", p]).catch(() => null);
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
      cur = names.length ? { alias: names[0], aliases: names.slice(1), hostname: null, user: null, port: null, identity: null } : null;
      if (cur) hosts.push(cur);
    } else if (key === "include" && depth < 16) {
      for (const f of await includeFiles(value)) await parseConfig(await readTextFile(f).catch(() => null), hosts, depth + 1);
    } else if (cur && key === "hostname") cur.hostname = value;
    else if (cur && key === "user") cur.user = value;
    else if (cur && key === "port") cur.port = value;
    else if (cur && key === "identityfile" && !cur.identity) cur.identity = value;
  }
  return hosts;
}

// The steps of a connection, in order.
const STEPS = {
  hostkey: { title: "Host key", idle: "Who answers at that address" },
  key: { title: "Key on this Mac", idle: (j) => `~/.ssh/keys/id_ed25519_${j.name}` },
  install: { title: "Public key on the machine", idle: (j) => `Log in with the password once, add it to ${j.user || "you"}'s authorized_keys` },
  config: { title: "~/.ssh/config", idle: (j) => (j.existing ? `IdentityFile in Host ${j.name}` : `Host ${j.name}, so \`ssh ${j.name}\` just works`) },
  verify: { title: "Login without a password", idle: (j) => `ssh -o BatchMode=yes ${j.name}` },
  herdr: { title: "Add to Herdr", idle: (j) => (j.auth === "once" ? "With the password, nothing saved; copies herdr-core there if it has none" : "Copies herdr-core there if it has none") },
};

export default class MachineAdd extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.machines = [];
    this.hosts = null;
    this.sel = "new"; // "new" | "host:<alias>" | "machine:<name>"
    this.auth = "key"; // "key" | "plain"
    this.tried = false;
    this.focus = null;
    this.job = null;
    this.copied = null;
    // Placeholders are drawn by input(), dim: the Input's own takes the text color.
    this.ph = {};
    const field = (key, placeholder, masked) => {
      const s = InputState.new({});
      this.ph[key] = placeholder;
      if (masked) s.set_masked(true);
      s.on("change", (_e, cx) => cx.notify());
      s.on("submit", (_e, cx) => this.connect(cx));
      s.on("focus", (_e, cx) => { this.focus = key; cx.notify(); });
      s.on("blur", (_e, cx) => { if (this.focus === key) this.focus = null; cx.notify(); });
      return s;
    };
    this.addr = field("addr", "203.0.113.7  or  root@box.example.com:2222");
    this.port = field("port", "22");
    this.user = field("user", me());
    this.name = field("name", "from the address");
    this.pw = field("pw", "not saved anywhere", true);
    this.addr.focus();
    cx.timer.after(500, () => this.addr.focus());
    cx.spawn(async (cx) => {
      await this.reload();
      cx.notify();
    });
  }

  async reload() {
    this.hosts = await parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null));
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try {
      this.machines = r?.code === 0 ? (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary) : [];
    } catch {
      this.machines = [];
    }
  }

  inHerdr(alias) {
    return this.machines.some((m) => m.name === alias || m.target === alias);
  }

  aliasTaken(name) {
    return (this.hosts ?? []).some((h) => h.alias === name || h.aliases.includes(name));
  }

  // ---- the form ----

  // What the picked entry and the fields describe, and what's wrong with it.
  plan() {
    if (this.sel.startsWith("host:")) {
      const h = (this.hosts ?? []).find((x) => x.alias === this.sel.slice(5));
      if (!h) return { errors: {} };
      const errors = {};
      if (this.auth !== "plain" && !this.pw.value()) errors.pw = "Type the password";
      return { existing: true, name: h.alias, host: h.hostname || h.alias, user: h.user || "", port: h.port || "22", errors };
    }
    const raw = this.addr.value().trim();
    const m = raw.match(/^(?:([^@\s]+)@)?([^@:\s]+|\[[^\]]+\])(?::(\d+))?$/);
    const host = m ? m[2].replace(/^\[|\]$/g, "") : "";
    const user = this.user.value().trim() || (m && m[1]) || "";
    const port = this.port.value().trim() || (m && m[3]) || "22";
    const auto = /^[\d.]+$|:/.test(host) ? host.replace(/[^A-Za-z0-9._-]/g, "-") : host.split(".")[0];
    const name = this.name.value().trim() || auto;
    const errors = {};
    if (!raw) errors.addr = "Where is it: an address or a name ssh knows";
    else if (!m) errors.addr = "Looks like [user@]host[:port]";
    if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) errors.port = "1–65535";
    if (name && !NAME_RE.test(name)) errors.name = "Letters, digits, . - _";
    else if (name && this.aliasTaken(name)) errors.name = `~/.ssh/config already has ${name}`;
    else if (name && this.machines.some((x) => x.name === name)) errors.name = `Herdr already has ${name}`;
    if (this.auth !== "plain" && !this.pw.value()) errors.pw = "Type the password";
    return { existing: false, name, host, user, port, errors };
  }

  connect(cx) {
    if (this.job && !this.job.done && !this.job.failed && !this.job.asking) return;
    if (this.sel.startsWith("machine:")) return;
    const p = this.plan();
    this.tried = true;
    if (Object.keys(p.errors).length || !p.name) return cx.notify();
    const order = this.auth === "key" ? ["hostkey", "key", "install", "config", "verify", "herdr"] : this.auth === "once" ? ["hostkey", "herdr"] : ["herdr"];
    this.job = { ...p, auth: this.auth, order, steps: Object.fromEntries(order.map((s) => [s, { state: "wait" }])), fps: null, fingerprint: null };
    this.tried = false;
    cx.notify();
    cx.spawn(async (cx) => this.advance(cx));
  }

  async advance(cx) {
    const job = this.job;
    job.failed = null;
    job.asking = false;
    for (const id of job.order) {
      if (job.steps[id].state === "ok") continue;
      job.steps[id] = { state: "run" };
      cx.notify();
      const r = await this.step(job, id).catch((e) => ({ ok: false, error: String(e) }));
      if (this.job !== job) return;
      if (r.ask) {
        job.steps[id] = { state: "ask" };
        job.fps = r.fps;
        job.asking = true;
        return cx.notify();
      }
      if (!r.ok) {
        job.steps[id] = { state: "fail", text: r.error, command: r.command };
        job.failed = id;
        return cx.notify();
      }
      job.steps[id] = { state: "ok", text: r.text };
      cx.notify();
    }
    job.done = true;
    this.pw.set_value("");
    await this.reload();
    cx.notify();
  }

  async script(args) {
    const r = await exec(SCRIPT(), args, { timeout: 120000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { ok: false, error: (r.stderr || r.stdout || "ssh-add-host didn't answer").trim() };
    }
  }

  // Runs fn with a file holding the password, in a fresh private temp
  // folder; the script deletes it as soon as it has read it.
  async withPassword(fn) {
    const dir = (await exec("mktemp", ["-d"]).catch(() => null))?.stdout?.trim();
    if (!dir) return { code: 1, stdout: "", stderr: "Couldn't make a temp folder for the password" };
    try {
      await writeTextFile(`${dir}/pw`, this.pw.value(), null);
      return await fn(`${dir}/pw`);
    } catch (e) {
      return { code: 1, stdout: "", stderr: String(e) };
    } finally {
      await exec("rm", ["-rf", dir]).catch(() => null);
    }
  }

  async step(job, id) {
    const target = `${job.user ? job.user + "@" : ""}${job.host}`;
    const base = ["--json", "setup", "--name", job.name, ...(job.existing ? [] : ["--host", target, "-p", job.port])];
    const done = (r) => (r.ok ? { ok: true, text: r.steps?.[0]?.text } : { ok: false, error: r.error, kind: r.kind, fps: r.fingerprints });
    if (id === "hostkey") {
      if (!job.fingerprint) {
        const s = await this.script(["--json", "scan", job.existing ? job.name : job.host, ...(job.existing ? [] : ["-p", job.port])]);
        if (!s.ok) return { ok: false, error: s.error };
        if (!s.known) return { ask: true, fps: s.fingerprints ?? [] };
        return { ok: true, text: "Known: it's in ~/.ssh/known_hosts" };
      }
      const r = done(await this.script([...base, "--step", "hostkey", "--fingerprint", job.fingerprint]));
      if (!r.ok && r.kind === "host_key_changed") return { ask: true, fps: r.fps ?? [] };
      return r;
    }
    if (id === "install") {
      const r = await this.withPassword((f) => this.script([...base, "--step", "install", "--password-file", f]));
      return r.code === 1 && r.stdout === "" ? { ok: false, error: r.stderr } : done(r);
    }
    if (id === "herdr") {
      const args = job.auth === "key" || job.existing
        ? [job.name]
        : [`${target}${job.port !== "22" ? ":" + job.port : ""}`, "--name", job.name];
      const r = job.auth === "once" ? await this.withPassword((f) => exec(SCRIPT(), ["herdr-add", ...args, "--password-file", f], { timeout: 200000 }))
        : await hc(["machine", "add", ...args, "--install", "--json"]);
      if (r.code === 0) return { ok: true, text: job.auth === "once" ? `${job.name} is in the sidebar. Nothing saved: a reconnect asks for the password again` : `${job.name} is in the sidebar` };
      let why;
      try {
        why = JSON.parse(r.stdout || r.stderr).error ?? {};
      } catch {
        why = { message: (r.stderr || r.stdout).trim() };
      }
      const command = `hc machine add ${args.map(shellArg).join(" ")}`;
      if (["login_needed", "auth_failed"].includes(why.kind) || /password|permission denied/i.test(why.message ?? ""))
        return { ok: false, error: job.auth === "plain" ? "It asks for a password. Go back and pick a way with the password, or add it in a terminal:" : "The password didn't get through. Check it and try again, or add it in a terminal:", command };
      return { ok: false, error: why.message || "hc machine add failed", command };
    }
    return done(await this.script([...base, "--step", id]));
  }

  trust(cx) {
    const fps = this.job?.fps ?? [];
    this.job.fingerprint = (fps.find((f) => f.type === "ED25519") ?? fps[0])?.fingerprint;
    if (!this.job.fingerprint) return;
    cx.spawn(async (cx) => this.advance(cx));
  }

  close() {
    closeOverlay(props().overlay);
  }

  pick(sel, cx) {
    if (this.job && !this.job.done && !this.job.failed && !this.job.asking) return;
    this.sel = sel;
    this.job = null;
    this.tried = false;
    if (sel === "new") this.addr.focus();
    else if (sel.startsWith("host:") && this.auth === "key") this.pw.focus();
    cx.notify();
  }

  // ---- pieces ----

  tile(t, icon, color, size = 30) {
    return div().size(size).flex_none().flex().items_center().justify_center().rounded(size > 32 ? 11 : 8).bg(color + "1f").child(svg(I(icon)).size(Math.round(size * 0.5)).text_color(color));
  }

  btn(t, id, label, opts, action) {
    const { solid, icon, disabled } = opts;
    return h_flex()
      .id(id)
      .h(34)
      .px(14)
      .gap(7)
      .flex_none()
      .items_center()
      .rounded(8)
      .text_size(12.8)
      .font_medium()
      .when(Boolean(solid), (el) => el.bg(t.accent).text_color(t.accent_foreground ?? t.solid_foreground).shadow_md())
      .when(!solid, (el) => el.border_1().border_color(t.input).bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(Boolean(disabled), (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)).on_click(action))
      .child(label)
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(14)));
  }

  input(t, key, state, label, opts = {}) {
    const err = this.tried ? opts.error : null;
    return v_flex()
      .gap(5)
      .min_w(0)
      .when(Boolean(opts.w), (el) => el.w(opts.w).flex_none())
      .when(!opts.w, (el) => el.flex_1())
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
      .child(
        div()
          .relative()
          .h(36)
          .rounded(8)
          .border_1()
          .border_color(err ? t.blocked : this.focus === key ? t.accent : t.input)
          .bg(t.background)
          .when(!state.value(), (el) =>
            el.child(div().absolute().top(0).bottom(0).left(12).right(12).flex().items_center().text_size(13).text_color(t.dim).truncate().child(this.ph[key] ?? "")),
          )
          .child(Input.new(state).size_full().px(11).items_center().text_size(13).text_color(t.foreground)),
      )
      .when(Boolean(err), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(err)))
      .when(!err && Boolean(opts.hint), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(opts.hint)));
  }

  authCard(t, id, icon, title, text) {
    const on = this.auth === id;
    return v_flex()
      .id(`ma-auth-${id}`)
      .flex_1()
      .min_w(0)
      .p(12)
      .gap(6)
      .rounded(10)
      .border_1()
      .border_color(on ? t.accent : t.border)
      .bg(on ? t.accent + "12" : t.background)
      .cursor_pointer()
      .hover((s) => s.border_color(on ? t.accent : t.input))
      .on_click((_e, cx) => {
        this.auth = id;
        if (id !== "plain") this.pw.focus();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .child(this.tile(t, icon, on ? t.accent : t.muted, 26))
          .child(div().flex_1())
          .child(
            div()
              .size(16)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded_full()
              .border_1()
              .border_color(on ? t.accent : t.input)
              .when(on, (el) => el.child(div().size(8).rounded_full().bg(t.accent))),
          ),
      )
      .child(div().pt(2).text_size(12.8).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(11.8).line_height("16px").text_color(t.muted).child(text));
  }

  // A code card: lines of [key, value], keys tinted.
  code(t, title, lines) {
    return v_flex()
      .gap(6)
      .child(h_flex().gap(6).items_center().text_size(11.5).font_medium().text_color(t.muted).child(svg(I("file")).size(12)).child(title))
      .child(
        v_flex()
          .p(12)
          .gap(2)
          .rounded(9)
          .bg(t.chrome)
          .border_1()
          .border_color(t.border)
          .font_family(MONO())
          .text_size(12)
          .children(
            lines.map(([k, v, indent], i) =>
              h_flex()
                .id(`ma-code-${i}`)
                .gap(8)
                .when(Boolean(indent), (el) => el.pl(16))
                .child(div().flex_none().text_color(indent ? t.ansi4 : t.accent).child(k))
                .child(div().min_w(0).truncate().text_color(v ? t.foreground : t.dim).child(v || "…")),
            ),
          ),
      );
  }

  // ---- left: the list ----

  rail(t) {
    const item = (sel, icon, label, sub, right) => {
      const on = this.sel === sel;
      return h_flex()
        .id(`ma-item-${sel}`)
        .h(40)
        .px(8)
        .gap(9)
        .flex_none()
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected ?? t.hover))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pick(sel, cx))
        .child(icon)
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(div().truncate().text_size(12.8).font_medium().text_color(t.foreground).child(label))
            .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))),
        )
        .when(Boolean(right), (el) => el.child(right));
    };
    const label = (text) => div().pt(14).pb(4).px(8).text_size(10.5).font_semibold().text_color(t.dim).child(text);
    const dot = (state) => div().size(7).flex_none().rounded_full().bg(state === "connected" ? t.ansi2 : state === "connecting" ? t.working : t.blocked);
    const mini = (icon, color) => div().size(24).flex_none().flex().items_center().justify_center().rounded(7).bg(t.raised).border_1().border_color(t.border).child(svg(I(icon)).size(13).text_color(color));
    const free = (this.hosts ?? []).filter((h) => !this.inHerdr(h.alias));
    return v_flex()
      .id("ma-rail")
      .w(214)
      .flex_none()
      .h_full()
      .p(10)
      .bg(t.chrome)
      .border_r_1()
      .border_color(t.border)
      .overflow_y_scroll()
      .child(item("new", div().size(24).flex_none().flex().items_center().justify_center().rounded(7).bg(t.accent).child(svg(I("plus")).size(14).text_color(t.accent_foreground ?? t.solid_foreground)), "New machine", "address and password"))
      .when(this.machines.length > 0, (el) =>
        el.child(label("IN HERDR")).children(this.machines.map((m) => item(`machine:${m.name}`, mini("server", t.muted), m.name, m.state === "connected" ? "connected" : m.state, dot(m.state)))),
      )
      .child(label("IN ~/.SSH/CONFIG"))
      .when(this.hosts !== null && !free.length, (el) => el.child(div().px(8).text_size(11.5).text_color(t.dim).child("All of them are in Herdr")))
      .children(free.map((h) => item(`host:${h.alias}`, mini("terminal", t.muted), h.alias, [h.user, h.hostname].filter(Boolean).join("@"))));
  }

  // ---- right: form, machine, job ----

  header(t, icon, color, title, sub, right) {
    return h_flex()
      .gap(13)
      .items_center()
      .child(this.tile(t, icon, color, 42))
      .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(16.5).font_semibold().text_color(t.foreground).truncate().child(title)).child(div().text_size(12.3).text_color(t.muted).truncate().child(sub)))
      .when(Boolean(right), (el) => el.child(right));
  }

  formPane(t) {
    const p = this.plan();
    const host = this.sel.startsWith("host:") ? (this.hosts ?? []).find((x) => x.alias === this.sel.slice(5)) : null;
    const key = this.auth === "key";
    const body = v_flex().gap(18);
    if (host) {
      body.child(this.header(t, "terminal", t.accent, host.alias, `${host.user ? host.user + "@" : ""}${host.hostname || host.alias}${host.port ? ":" + host.port : ""}  ·  from ~/.ssh/config`));
    } else {
      body
        .child(this.header(t, "server", t.accent, "New machine", "A VPS, a box at work, a Mac mini: Herdr reaches it over ssh"))
        .child(
          v_flex()
            .gap(12)
            .child(h_flex().gap(10).items_start().child(this.input(t, "addr", this.addr, "Address", { error: p.errors.addr })).child(this.input(t, "port", this.port, "Port", { w: 92, error: p.errors.port })))
            .child(
              h_flex()
                .gap(10)
                .items_start()
                .child(this.input(t, "user", this.user, "User"))
                .child(this.input(t, "name", this.name, "Name", { error: p.errors.name, hint: p.name ? `ssh ${p.name}` : "how you'll call it" })),
            ),
        );
    }
    body
      .child(
        v_flex()
          .gap(7)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("How to log in"))
          .child(
            h_flex()
              .gap(10)
              .items_start()
              .child(this.authCard(t, "key", "key", "Make a key", "Password once, then a key there: never asked again."))
              .child(this.authCard(t, "once", "terminal", "Password only", "No key, nothing saved. Every reconnect asks again."))
              .child(this.authCard(t, "plain", "shield", "Already set up", "Your ssh key or agent already gets in.")),
          ),
      )
      .when(this.auth !== "plain", (el) => el.child(this.input(t, "pw", this.pw, `Password${p.user ? " for " + p.user : ""}`, { error: p.errors.pw })))
      .when(key && !host, (el) =>
        el.child(this.code(t, "Goes into ~/.ssh/config", [["Host", p.name], ["HostName", p.host, 1], ["User", p.user || me(), 1], ...(p.port !== "22" ? [["Port", p.port, 1]] : []), ["IdentityFile", p.name ? `~/.ssh/keys/id_ed25519_${p.name}` : "", 1], ["IdentitiesOnly", "yes", 1]])),
      )
      .when(key && Boolean(host), (el) => el.child(this.code(t, "Added to its entry in ~/.ssh/config", [["Host", host.alias], ["IdentityFile", `~/.ssh/keys/id_ed25519_${host.alias}`, 1]])))
      .when(!key, (el) => el.child(this.code(t, this.auth === "once" ? "Herdr runs, with the password through SSH_ASKPASS" : "Herdr runs", [["hc", `machine add ${host ? host.alias : `${p.user ? p.user + "@" : ""}${p.host || "…"}${p.port !== "22" ? ":" + p.port : ""} --name ${p.name || "…"}`} --install`]])));
    const ready = !Object.keys(p.errors).length && Boolean(p.name);
    return this.pane(t, body, h_flex().gap(10).items_center().child(div().flex_1().text_size(11.5).text_color(t.dim).child("↵ connects  ·  esc closes")).child(this.btn(t, "ma-connect", key ? "Connect and make a key" : this.auth === "once" ? "Connect with the password" : "Add machine", { solid: true, icon: "arrow", disabled: !ready && this.tried }, (_e, cx) => this.connect(cx))));
  }

  machinePane(t) {
    const m = this.machines.find((x) => x.name === this.sel.slice(8));
    if (!m) return this.pane(t, div());
    const ok = m.state === "connected";
    const row = (k, v) => h_flex().gap(12).py(9).border_b_1().border_color(t.border).child(div().w(90).flex_none().text_size(12).text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(v ?? "—"));
    const chip = h_flex().gap(6).px(9).py(3).rounded(20).items_center().bg((ok ? t.ansi2 : t.blocked) + "1a").child(div().size(7).rounded_full().bg(ok ? t.ansi2 : t.blocked)).child(div().text_size(11.5).font_medium().text_color(ok ? t.ansi2 : t.blocked).child(m.state));
    const body = v_flex()
      .gap(18)
      .child(this.header(t, "server", ok ? t.ansi2 : t.blocked, m.name, `ssh ${m.target}`, chip))
      .child(v_flex().child(row("Reached as", m.target)).child(row("hc there", m.version)).child(row("Host name", m.host)).child(row("After logout", m.keeps_running_after_logout === null ? "unknown" : m.keeps_running_after_logout ? "keeps running" : "stops")));
    return this.pane(
      t,
      body,
      h_flex()
        .gap(10)
        .child(div().flex_1())
        .child(this.btn(t, "ma-space", `New space on ${m.name}`, { solid: true, icon: "arrow" }, () => {
          run("space.new", { machine: m.name });
          this.close();
        })),
    );
  }

  jobPane(t) {
    const job = this.job;
    const failed = Boolean(job.failed);
    const head = job.done
      ? this.header(t, "check", t.ansi2, `${job.name} is ready`, job.auth === "key" ? `ssh ${job.name} gets in without a password` : job.auth === "once" ? `${job.name} is in Herdr, with the password` : `${job.name} is in Herdr`)
      : this.header(t, failed ? "x" : job.asking ? "fingerprint" : "server", failed ? t.blocked : t.accent, failed ? "Something stopped it" : job.asking ? "Is this the right machine?" : `Connecting ${job.name}`, `${job.user ? job.user + "@" : ""}${job.host}${job.port !== "22" ? ":" + job.port : ""}`);
    const steps = job.order.map((id, i) => this.stepRow(t, id, i, i === job.order.length - 1));
    const foot = job.done
      ? h_flex().gap(10).child(div().flex_1()).child(this.btn(t, "ma-done", "Done", {}, () => this.close())).child(this.btn(t, "ma-space", `New space on ${job.name}`, { solid: true, icon: "arrow" }, () => {
          run("space.new", { machine: job.name });
          this.close();
        }))
      : failed
        ? h_flex().gap(10).child(div().flex_1()).child(this.btn(t, "ma-back", "Back to the form", {}, (_e, cx) => { this.job = null; cx.notify(); })).child(this.btn(t, "ma-retry", "Try again", { solid: true }, (_e, cx) => cx.spawn(async (cx) => this.advance(cx))))
        : h_flex().gap(10).child(div().flex_1().text_size(11.5).text_color(t.dim).child(job.asking ? "Nothing has been sent to it yet" : "This takes a few seconds"));
    return this.pane(t, v_flex().gap(20).child(head).child(v_flex().children(steps)), foot);
  }

  stepRow(t, id, i, last) {
    const job = this.job;
    const st = job.steps[id];
    const info = STEPS[id];
    const idle = typeof info.idle === "function" ? info.idle(job) : info.idle;
    const circle = div()
      .size(26)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded_full()
      .when(st.state === "wait", (el) => el.border_1().border_color(t.border).text_size(11).font_medium().text_color(t.dim).child(String(i + 1)))
      .when(st.state === "run", (el) => el.bg(t.accent + "1a").child(svg(I("spinner")).size(14).text_color(t.accent).spin(900)))
      .when(st.state === "ok", (el) => el.bg(t.ansi2 + "22").child(svg(I("check")).size(14).text_color(t.ansi2)))
      .when(st.state === "fail", (el) => el.bg(t.blocked + "22").child(svg(I("x")).size(14).text_color(t.blocked)))
      .when(st.state === "ask", (el) => el.border_2().border_color(t.accent).child(svg(I("fingerprint")).size(13).text_color(t.accent)));
    const rail = v_flex().w(26).flex_none().self_stretch().items_center().child(circle).when(!last, (el) => el.child(div().w(2).flex_1().min_h(10).my(3).rounded(1).bg(st.state === "ok" ? t.ansi2 + "66" : t.border)));
    const text = st.text ?? idle;
    const body = v_flex()
      .flex_1()
      .min_w(0)
      .pt(3)
      .pb(last ? 0 : 14)
      .gap(3)
      .child(div().text_size(13).font_medium().text_color(st.state === "wait" ? t.muted : t.foreground).child(info.title))
      .child(div().text_size(12).line_height("17px").text_color(st.state === "fail" ? t.blocked : t.dim).child(TextView.html(`ma-step-${id}`, `<span>${esc(text)}</span>`).selectable(true)))
      .when(Boolean(st.command), (el) => el.child(this.commandCard(t, st.command)))
      .when(st.state === "ask", (el) => el.child(this.fingerprintCard(t)));
    return h_flex().id(`ma-steprow-${id}`).gap(12).items_start().child(rail).child(body);
  }

  commandCard(t, command) {
    return h_flex()
      .mt(6)
      .gap(8)
      .p(8)
      .pl(10)
      .rounded(8)
      .bg(t.chrome)
      .border_1()
      .border_color(t.border)
      .items_center()
      .child(div().flex_1().min_w(0).font_family(MONO()).text_size(12).text_color(t.foreground).child(TextView.html("ma-cmd", `<span>${esc(command)}</span>`).selectable(true)))
      .child(
        h_flex()
          .id("ma-copy")
          .gap(5)
          .px(8)
          .h(24)
          .items_center()
          .rounded(6)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .text_size(11.5)
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            cx.write_to_clipboard(command);
            this.copied = command;
            cx.notify();
          })
          .child(svg(I("copy")).size(12))
          .child(this.copied === command ? "Copied" : "Copy"),
      )
      .child(
        h_flex()
          .id("ma-term")
          .gap(5)
          .px(8)
          .h(24)
          .items_center()
          .rounded(6)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .text_size(11.5)
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => {
            run("tab.new", { name: "hc machine add", argv: ["sh", "-c", `${command}; printf '\\nPress Enter to close'; read _`] });
            this.close();
          })
          .child(svg(I("terminal")).size(12))
          .child("In a terminal"),
      );
  }

  fingerprintCard(t) {
    const fps = this.job.fps ?? [];
    const main = fps.find((f) => f.type === "ED25519") ?? fps[0];
    return v_flex()
      .mt(8)
      .p(14)
      .gap(10)
      .rounded(10)
      .bg(t.accent + "10")
      .border_1()
      .border_color(t.accent + "55")
      .child(div().text_size(12.3).line_height("18px").text_color(t.foreground).child(`This Mac hasn't met ${this.job.host} before. If you can, compare with what the machine itself says: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`))
      .when(Boolean(main), (el) =>
        el.child(
          v_flex()
            .p(10)
            .gap(4)
            .rounded(8)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(main.type))
            .child(div().font_family(MONO()).text_size(12.5).text_color(t.foreground).child(TextView.html("ma-fp", `<span>${esc(main.fingerprint)}</span>`).selectable(true))),
        ),
      )
      .when(fps.length > 1, (el) => el.child(div().text_size(11).text_color(t.dim).child(`also ${fps.filter((f) => f !== main).map((f) => f.type).join(", ")}`)))
      .child(
        h_flex()
          .gap(8)
          .child(this.btn(t, "ma-trust", "Trust and continue", { solid: true, icon: "check" }, (_e, cx) => this.trust(cx)))
          .child(this.btn(t, "ma-cancel", "Not this one", {}, (_e, cx) => { this.job = null; cx.notify(); })),
      );
  }

  pane(t, body, foot) {
    return v_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .child(v_flex().id("ma-body").flex_1().min_h(0).overflow_y_scroll().px(24).pt(22).pb(18).child(body))
      .when(Boolean(foot), (el) => el.child(div().flex_none().px(24).py(12).border_t_1().border_color(t.border).child(foot)));
  }

  render() {
    const t = theme();
    const right = this.job ? this.jobPane(t) : this.sel.startsWith("machine:") ? this.machinePane(t) : this.formPane(t);
    return h_flex()
      .id("machine-add")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          this.close();
          cx.stop_propagation();
        }
      })
      .w_full()
      .h(690)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(this.rail(t))
      .child(right);
  }
}
