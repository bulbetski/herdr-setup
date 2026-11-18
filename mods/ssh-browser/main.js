import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, home, notify, theme } from "herdr";

// The ssh-browser Chrome profile (~/.local/bin/ssh-browser) in the status bar: is it open and does its
// SSH tunnel work. A dead tunnel is raised again on its own; a click on a red or grey state fixes it by
// hand, a click on green does nothing. The host, the domains and the name shown are in the script's config.
const POLL = 15000;        // ms
const AUTO_EVERY = 30000;  // ms, at most this often an automatic reconnect

const LOOK = {
  up: { color: "ansi2", text: "", tip: "The browser is open, private sites go through the tunnel" },
  down: { color: "ansi1", text: " · tunnel down", tip: "The tunnel is down. Click to raise it again" },
  nocorp: { color: "ansi3", text: " · no access", tip: "The tunnel is up, but the private sites don't answer. Click to reconnect; if it stays, check the network on the remote machine" },
  off: { color: "dim", text: " · off", tip: "The browser is closed. Click to open it" },
};

export default class SshBrowser extends View {
  init(_props, cx) {
    this.bin = `${home()}/.local/bin/ssh-browser`;
    this.label = "SSH browser";
    this.state = null; this.busy = null; this.lastAuto = 0;
    cx.spawn(async (cx) => {
      const r = await exec(this.bin, ["--label"], { timeout: 5000 }).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) { this.label = r.stdout.trim(); cx.notify(); }
    });
    this.poll(cx);
    cx.timer.every(POLL, (cx) => this.poll(cx));
  }

  poll(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      const r = await exec(this.bin, ["--status"], { timeout: 20000 }).catch(() => null);
      const s = r?.stdout.trim();
      this.state = LOOK[s] ? s : null;
      cx.notify();
      if (s === "down" && Date.now() - this.lastAuto > AUTO_EVERY) {
        this.lastAuto = Date.now();
        this.act("--tunnel", true, cx);
      }
    });
  }

  // auto: a failed automatic reconnect stays quiet (the remote asleep, another Wi-Fi); the red state says it.
  act(arg, auto, cx) {
    if (this.busy) return;
    this.busy = arg === "--open" ? "opening" : "connecting";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(this.bin, arg === "--open" ? [] : [arg], { timeout: 30000 })
        .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      this.busy = null;
      if (r.code !== 0 && !auto)
        notify({ title: `${this.label}: tunnel failed`, body: (r.stderr || r.stdout || "").trim() || "ssh failed", level: "warning", timeout: 15000 });
      this.poll(cx);
    });
  }

  render() {
    const t = theme();
    const look = LOOK[this.state];
    const fix = { down: "--tunnel", nocorp: "--reconnect", off: "--open" }[this.state];
    const color = this.busy ? t.working : look ? t[look.color] : t.dim;
    const text = this.busy ? `${this.label} · ${this.busy}…` : `${this.label}${look?.text ?? ""}`;
    return h_flex().id("ssh-browser").size_full().px(10).gap(6).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("ssh-browser-state").gap(6).items_center().px(4).rounded(4)
        .when(Boolean(look), (e) => e.tooltip(look.tip))
        .when(Boolean(fix) && !this.busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.act(fix, false, cx)))
        .child(div().size(7).rounded(4).flex_none().bg(color))
        .child(div().text_color(this.state === "up" && !this.busy ? t.muted : color).child(text)));
  }
}
