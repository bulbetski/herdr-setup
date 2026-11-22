import { View, div } from "gpui-kit";
import { exec, home, nextCommand, notify, setShared } from "herdr";

// The ssh-browser Chrome profile (~/.local/bin/ssh-browser): is it open and does its SSH tunnel work.
// It draws nothing itself (its layout block is 0 px wide): it publishes the state in shared "machine-extras.browser"
// and workspace-status-plus shows it in the status card of the machine SSH_HOST names. A dead tunnel is raised
// again on its own; the card's button sends "ssh-browser.fix", which raises, reconnects or opens it.
const POLL = 15000;        // ms
const AUTO_EVERY = 30000;  // ms, at most this often an automatic reconnect
const KEY = "machine-extras.browser";

const LOOK = {
  up: { level: "ok", text: "open", tip: "The browser is open, private sites go through the tunnel" },
  down: { level: "bad", text: "tunnel down", tip: "The tunnel is down", fix: "Raise tunnel" },
  nocorp: { level: "warn", text: "no access", tip: "The tunnel is up, but the private sites don't answer; if a reconnect doesn't help, check the network on the remote machine", fix: "Reconnect" },
  off: { level: "off", text: "closed", tip: "The browser is closed", fix: "Open" },
};
const ARG = { down: "--tunnel", nocorp: "--reconnect", off: "--open" };

export default class SshBrowser extends View {
  init(_props, cx) {
    this.bin = `${home()}/.local/bin/ssh-browser`;
    this.label = "SSH browser"; this.host = "";
    this.state = null; this.busy = null; this.lastAuto = 0;
    cx.spawn(async (cx) => {
      const [l, h] = await Promise.all(["--label", "--host"].map((a) => exec(this.bin, [a], { timeout: 5000 }).catch(() => null)));
      if (l?.code === 0 && l.stdout.trim()) this.label = l.stdout.trim();
      if (h?.code === 0) this.host = h.stdout.trim();
      this.poll(cx);
    });
    cx.timer.every(POLL, (cx) => this.poll(cx));
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "fix" && ARG[this.state]) this.act(ARG[this.state], false, cx); } });
  }

  publish() {
    if (!this.host) return;
    const look = LOOK[this.state];
    setShared(KEY, { machine: this.host, name: "Browser", mod: "ssh-browser", at: Date.now(),
      level: this.busy ? "busy" : look?.level ?? "off", text: this.busy ? `${this.busy}…` : look?.text ?? "checking…",
      tip: look?.tip ?? "", fix: this.busy ? null : look?.fix ?? null });
  }

  poll(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      const r = await exec(this.bin, ["--status"], { timeout: 20000 }).catch(() => null);
      const s = r?.stdout.trim();
      this.state = LOOK[s] ? s : null;
      this.publish();
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
    this.publish();
    cx.spawn(async (cx) => {
      const r = await exec(this.bin, arg === "--open" ? [] : [arg], { timeout: 30000 })
        .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      this.busy = null;
      if (r.code !== 0 && !auto)
        notify({ title: `${this.label}: tunnel failed`, body: (r.stderr || r.stdout || "").trim() || "ssh failed", level: "warning", timeout: 15000 });
      this.poll(cx);
    });
  }

  render() { return div(); }
}
