import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, exec, notify, readTextFile, theme } from "herdr";

// The proxy the agents of another machine go through (a VPN client listening on a local port there), in the
// status bar: does it answer and does it reach the internet. A proxy that stopped listening is restarted on its
// own; a click on a red or yellow state restarts it by hand, a click on green does nothing. The machine, the
// proxy, the test URL and the restart commands are in config.json next to this file (see config.example.json).
const POLL = 30000;           // ms
const AUTO_EVERY = 300000;    // ms, at most this often an automatic restart
const AFTER_FIX = 10000;      // ms, the client needs a few seconds to bring its core up

const LOOK = {
  up: { color: "ansi2", text: "", tip: "The proxy answers and reaches the internet" },
  down: { color: "ansi1", text: " · down", tip: "Nothing listens on the proxy port: the VPN client or its core is not running. Click to restart it" },
  noexit: { color: "ansi3", text: " · no internet", tip: "The proxy listens but doesn't reach the test site: the VPN server or the network. Click to restart the client" },
  offline: { color: "dim", text: " · offline", tip: "The machine doesn't answer" },
};

export default class ProxyStatus extends View {
  init(_props, cx) {
    this.config = null; this.state = null; this.busy = false; this.lastAuto = 0;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/mods/proxy-status/config.json`).catch(() => null);
      try { this.config = text ? JSON.parse(text) : null; } catch { this.config = null; }
      cx.notify();
      if (!this.config?.machine) return;
      this.poll(cx);
      cx.timer.every(POLL, (cx) => this.poll(cx));
    });
  }

  get label() { return this.config?.label || `${this.config?.machine} proxy`; }

  poll(cx) {
    if (this.busy) return;
    const { machine, proxy, url } = this.config;
    const check = `curl -s -o /dev/null -m 10 -x '${proxy}' '${url || "https://www.google.com/"}'; echo "rc=$?"`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", check], { on: machine, timeout: 20000 }).catch(() => null);
      const rc = r && /rc=(\d+)/.exec(r.stdout)?.[1];
      this.state = rc == null ? "offline" : rc === "0" ? "up" : rc === "7" ? "down" : "noexit";
      cx.notify();
      if (this.state === "down" && this.config.auto_fix && Date.now() - this.lastAuto > AUTO_EVERY) {
        this.lastAuto = Date.now();
        this.fix(true, cx);
      }
    });
  }

  // auto: a failed automatic restart stays quiet; the red state says it.
  fix(auto, cx) {
    const lines = this.config.fix;
    if (this.busy || !lines?.length) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", [].concat(lines).join("\n")], { on: this.config.machine, timeout: 60000 })
        .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0 && !auto)
        notify({ title: `${this.label}: restart failed`, body: (r.stderr || r.stdout || "").trim() || "no output", level: "warning", timeout: 15000 });
      cx.timer.after(AFTER_FIX, (cx) => { this.busy = false; this.poll(cx); });
    });
  }

  render() {
    const t = theme();
    const bar = h_flex().id("proxy-status").size_full().px(10).gap(6).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8);
    if (!this.config?.machine) return bar;
    const look = LOOK[this.state];
    const canFix = (this.state === "down" || this.state === "noexit") && this.config.fix?.length && !this.busy;
    const color = this.busy ? t.working : look ? t[look.color] : t.dim;
    const text = this.busy ? `${this.label} · restarting…` : `${this.label}${look?.text ?? ""}`;
    return bar.child(h_flex().id("proxy-status-state").gap(6).items_center().px(4).rounded(4)
      .when(Boolean(look), (e) => e.tooltip(`${look.tip}\n${this.config.machine}: ${this.config.proxy}`))
      .when(Boolean(canFix), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.fix(false, cx)))
      .child(div().size(7).rounded(4).flex_none().bg(color))
      .child(div().text_color(this.state === "up" && !this.busy ? t.muted : color).child(text)));
  }
}
