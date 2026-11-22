// Modified from Herdr's built-in `workspace-status` mod (github.com/herdrdev/herdr-app, Apache-2.0, see LICENSE here).
// Changed by bulbetski: see the setup's README for what differs from the original.
import { View, div, svg } from "gpui-kit";
import { HoverCard, h_flex, v_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, machines, exec, hc, notify, setShared, shared } from "herdr";

// Herdr's status bar (cloned) with the shown space's machine state beside its name:
// connected / connecting / disconnected / login required, and ↻ Reconnect when it isn't connected.
// A toast says when a machine drops or comes back. Other mods may publish more about a machine in shared
// "machine-extras.<key>" = { machine, name, mod, at, level: ok|warn|bad|busy|off, text, tip, fix }: then the
// machine's name opens a card on hover with the connection and those rows, a row's button sends "<mod>.fix",
// and while connected the worst of them stands in the bar instead of "connected".
const EXTRAS = ["machine-extras.browser", "machine-extras.proxy"];
const STALE = 120000; // ms, a row its mod stopped refreshing is left out
const RANK = { bad: 3, warn: 2, busy: 1, ok: 0, off: 0 };
// A connection error: kept in full for the details window, posted as a toast that opens it and stays.
function reportError(m, title, body) {
  setShared("conn.lastError", { machine: m.name, target: m.target ?? m.name, at: Date.now(), title, body });
  notify({ title, body: `${String(body).split("\n")[0]}\nClick for details.`, level: "warning", timeout: 600000, action: { name: "mod.open", args: { name: "conn-details" } } });
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.list = []; this.busy = new Set(); this.last = new Map();
    this.poll(cx);
    cx.timer.every(15000, (cx) => this.poll(cx));
  }

  poll(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.list = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch { /* keep the last list */ }
      for (const m of this.list) {
        const was = this.last.get(m.name);
        if (was && was !== m.state) {
          if (m.state === "connected") notify({ title: `${m.name}: connected`, level: "info", timeout: 4000 });
          else if (was === "connected") reportError(m, `${m.name}: disconnected`, `hc reports ${m.state.replace(/_/g, " ")}.\nAsleep, no network, another Wi-Fi or a new address. ↻ Reconnect is in the status bar of its space.`);
        }
        this.last.set(m.name, m.state);
      }
      cx.notify();
    });
  }

  reconnect(m, cx) {
    if (this.busy.has(m.name)) return;
    this.busy.add(m.name); cx.notify();
    cx.spawn(async (cx) => {
      try {
        const probe = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", m.target ?? m.name, "true"], { timeout: 15000 })
          .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
        if (probe.code !== 0) {
          const why = (probe.stderr || "").trim().split("\n").pop() || "no answer";
          reportError(m, `${m.name}: not responding`, `${(probe.stderr || "").trim() || why}\nAsleep, no network, another Wi-Fi or a new address (~/.ssh/config).`);
        } else {
          // Any command there makes hc connect now; a password or code needs a terminal for the person.
          const r = await hc(["exec", "--on", m.name, "true"]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
          if (r.code === 0) notify({ title: `${m.name}: connected`, level: "info", timeout: 4000 });
          else if (m.state === "needs_login") run("tab.new", { space: spaces().find((s) => !s.machine)?.id, name: `login ${m.name}`, argv: ["hc", "machine", "login", m.name] });
          else reportError(m, `${m.name}: ssh works, but hc did not connect`, (r.stderr || r.stdout || "").trim());
        }
      } finally { this.busy.delete(m.name); this.poll(cx); }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  extras(m) {
    return EXTRAS.map((k) => shared(k)).filter((x) => x && (x.machine === m.name || x.machine === m.target) && Date.now() - x.at < STALE);
  }

  // The machine's state beside its name: nothing for this computer. Returns { el, card }.
  machineState(t, name) {
    const m = name ? this.list.find((x) => x.name === name) : null;
    if (!m) return null;
    const layout = machines().find((x) => x.name === name)?.layout;
    const busy = this.busy.has(name);
    const ok = m.state === "connected" && layout !== "unavailable";
    const pending = busy || m.state === "connecting" || layout === "loading";
    const color = pending ? t.working : ok ? t.ansi2 : t.ansi1;
    const text = pending ? "connecting" : ok ? "connected" : m.state === "needs_login" ? "login required" : "disconnected";
    const extras = this.extras(m);
    const worst = ok && !pending ? extras.filter((x) => RANK[x.level] >= 2).sort((a, b) => RANK[b.level] - RANK[a.level])[0] : null;
    const shade = (level) => ({ ok: t.ansi2, warn: t.ansi3, bad: t.ansi1, busy: t.working }[level] ?? t.dim);
    const dot = (c) => div().size(7).rounded(4).flex_none().bg(c);
    const button = (id, label, tip, onClick) => div().id(id).px(6).rounded(4).border_1().border_color(t.border).flex_none()
      .text_color(t.foreground).cursor_pointer().hover((st) => st.bg(t.hover)).tooltip(tip).on_click(onClick).child(label);
    const el = h_flex().gap(6).items_center()
      .child(dot(worst ? shade(worst.level) : color))
      .child(div().id("ws-state").text_color(worst ? shade(worst.level) : ok ? t.muted : color).when(!ok, (e) => e.cursor_pointer().tooltip("Details of the last connection error")
        .on_click(() => run("mod.open", { name: "conn-details" }))).child(worst ? `${worst.name} ${worst.text}` : text))
      .when(!ok && !busy, (e) => e.child(button("ws-reconnect", "↻ Reconnect", "Check SSH and reconnect now", (_e, cx) => this.reconnect(m, cx))));
    if (!extras.length) return { el, card: null };
    const row = (id, c, label, value, tip, action) => v_flex().gap(3)
      .child(h_flex().gap(8).items_center().h(22)
        .child(dot(c)).child(div().w(64).text_color(t.foreground).child(label)).child(div().flex_1().text_color(t.muted).child(value))
        .when(Boolean(action), (e) => e.child(action)))
      .when(Boolean(tip), (e) => e.child(div().pl(15).text_size(11).text_color(t.dim).child(tip)));
    const card = v_flex().id("ws-card").w(320).p(12).gap(8).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12).text_color(t.foreground)
      .child(div().text_color(t.dim).text_size(11).child(name))
      .child(row("ws-row-ssh", color, "SSH", text, ok || pending ? null : "Asleep, no network, another Wi-Fi or a new address",
        !ok && !busy ? button("ws-card-reconnect", "↻ Reconnect", "Check SSH and reconnect now", (_e, cx) => this.reconnect(m, cx)) : null))
      .children(extras.map((x) => row(`ws-row-${x.mod}`, shade(x.level), x.name, x.text, RANK[x.level] >= 2 ? x.tip : null,
        x.fix ? button(`ws-fix-${x.mod}`, x.fix, x.tip, () => run(`${x.mod}.fix`)) : null)));
    return { el, card };
  }

  // The name and state; with a card, hovering them opens it above the bar.
  machineItem(name, state) {
    const item = h_flex().id("ws-machine").gap(10).items_center().child(name).when(Boolean(state), (el) => el.child(state.el));
    if (!state?.card) return item;
    return HoverCard.new("ws-machine-card").anchor("bottom_left").open_delay(250).close_delay(300).trigger(item).content(state.card);
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const state = this.machineState(t, space?.machine ?? null);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(this.machineItem(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"), state))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
