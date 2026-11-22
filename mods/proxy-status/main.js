import { View, div } from "gpui-kit";
import { appHome, exec, nextCommand, notify, readTextFile, setShared } from "herdr";

// The proxy the agents of another machine go through (a VPN client listening on a local port there): does it
// answer and does it reach the internet. It draws nothing itself (its layout block is 0 px wide): it publishes the
// state in shared "machine-extras.proxy" and workspace-status-plus shows it in that machine's status card. A proxy
// that stopped listening is restarted on its own; the card's button sends "proxy-status.fix". The machine, the
// proxy, the test URL and the restart commands are in config.json next to this file (see config.example.json).
const POLL = 30000;           // ms
const AUTO_EVERY = 300000;    // ms, at most this often an automatic restart
const AFTER_FIX = 10000;      // ms, the client needs a few seconds to bring its core up
const KEY = "machine-extras.proxy";

const LOOK = {
  up: { level: "ok", text: "works", tip: "The proxy answers and reaches the internet" },
  down: { level: "bad", text: "down", tip: "Nothing listens on the proxy port: the VPN client or its core is not running", fix: "Restart" },
  noexit: { level: "warn", text: "no internet", tip: "The proxy listens but doesn't reach the test site: the VPN server or the network", fix: "Restart" },
  offline: { level: "off", text: "unknown", tip: "The machine doesn't answer" },
};

export default class ProxyStatus extends View {
  init(_props, cx) {
    this.config = null; this.state = null; this.busy = false; this.lastAuto = 0;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/mods/proxy-status/config.json`).catch(() => null);
      try { this.config = text ? JSON.parse(text) : null; } catch { this.config = null; }
      if (!this.config?.machine) return;
      this.poll(cx);
      cx.timer.every(POLL, (cx) => this.poll(cx));
      for (;;) { const c = await nextCommand(); if (c === "fix") this.fix(false, cx); }
    });
  }

  get label() { return this.config?.label || "Proxy"; }

  publish() {
    const look = LOOK[this.state];
    setShared(KEY, { machine: this.config.machine, name: this.label, mod: "proxy-status", at: Date.now(),
      level: this.busy ? "busy" : look?.level ?? "off", text: this.busy ? "restarting…" : look?.text ?? "checking…",
      tip: `${look?.tip ?? ""}\n${this.config.proxy}`.trim(), fix: this.busy || !this.config.fix?.length ? null : look?.fix ?? null });
  }

  poll(cx) {
    if (this.busy) return;
    const { machine, proxy, url } = this.config;
    const check = `curl -s -o /dev/null -m 10 -x '${proxy}' '${url || "https://www.google.com/"}'; echo "rc=$?"`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", check], { on: machine, timeout: 20000 }).catch(() => null);
      const rc = r && /rc=(\d+)/.exec(r.stdout)?.[1];
      this.state = rc == null ? "offline" : rc === "0" ? "up" : rc === "7" ? "down" : "noexit";
      this.publish();
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
    this.publish();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", [].concat(lines).join("\n")], { on: this.config.machine, timeout: 60000 })
        .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0 && !auto)
        notify({ title: `${this.config.machine} ${this.label}: restart failed`, body: (r.stderr || r.stdout || "").trim() || "no output", level: "warning", timeout: 15000 });
      cx.timer.after(AFTER_FIX, (cx) => { this.busy = false; this.poll(cx); });
    });
  }

  render() { return div(); }
}
