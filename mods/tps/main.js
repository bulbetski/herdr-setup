import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, appHome, exec, focused, hc, readTextFile, spaces, theme } from "herdr";

// Tokens per second of the agent in the focused terminal (Claude Code or Codex, here or on
// another machine), in the status bar. tps.py reads the agent's session log: the last
// response and the average of the recent ones, each timed from its input to its last record,
// so the wait for the first token counts too. Logs are written per response, not per token:
// the number changes when a response ends.
const TICK = 1500;      // ms, focus check; the log is read on every tick while the agent works
const IDLE_EVERY = 10;  // s, how often an idle agent's log is read
const APPS = { "claude-code": "claude", claude: "claude", codex: "codex" };

const rate = (x) => (x && x.secs > 0 ? x.tokens / x.secs : null);
const fmt = (n) => (n == null ? "—" : n >= 100 ? String(Math.round(n)) : n.toFixed(1));

function appOf(info) {
  const fg = info.foreground ?? {};
  const names = [info.status?.app, fg.name, (fg.argv?.[0] ?? "").split("/").pop()];
  for (const n of names) if (n && APPS[n]) return APPS[n];
  return null;
}

export default class Tps extends View {
  init(_props, cx) {
    this.src = null;      // tps.py, passed inline so it runs on any machine
    this.terminal = null;
    this.data = null;     // tps.py's output for this.terminal
    this.app = null;
    this.at = 0;          // ms, last read
    this.busy = false;
    cx.spawn(async (cx) => {
      this.src = await readTextFile(`${appHome()}/mods/tps/tps.py`).catch(() => null);
      this.tick(cx);
    });
    cx.timer.every(TICK, (cx) => this.tick(cx));
  }

  tick(cx) {
    const f = focused();
    const terminal = f?.terminal ?? f?.agent ?? null;
    if (terminal !== this.terminal) {
      this.terminal = terminal;
      this.data = null;
      this.app = null;
      this.at = 0;
      cx.notify();
    }
    if (!terminal || !this.src || this.busy) return;
    const working = agents().find((a) => a.address === terminal)?.status === "working";
    if (this.at && !working && !this.data?.busy && Date.now() - this.at < IDLE_EVERY * 1000) return;
    const machine = spaces().find((s) => s.id === f.space)?.machine ?? null;
    this.read(terminal, machine, cx);
  }

  read(terminal, machine, cx) {
    this.busy = true;
    this.at = Date.now();
    cx.spawn(async (cx) => {
      let data = null, app = null;
      try {
        const info = JSON.parse((await hc(["get", terminal])).stdout);
        app = appOf(info);
        const pid = info.foreground?.pid;
        if (app && pid) {
          const r = await exec("python3", ["-I", "-c", this.src, app, String(pid)], { on: machine, timeout: 10000 });
          if (r.code === 0) data = JSON.parse(r.stdout);
        }
      } catch {
        data = null;
      } finally {
        this.busy = false;
      }
      if (terminal !== this.terminal) return;
      this.data = data;
      this.app = app;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const d = this.data;
    const last = rate(d?.last), recent = rate(d?.recent);
    const tip = d
      ? [`${d.model ?? this.app}`,
         `Last response: ${fmt(last)} tok/s (${d.last.tokens} tok in ${d.last.secs.toFixed(1)} s)`,
         `Last ${d.recent.n}: ${fmt(recent)} tok/s`,
         d.busy ? "Working now: the number updates when this response ends" : null,
         "Timed from the prompt or tool result, so the wait for the first token counts"].filter(Boolean).join("\n")
      : this.app ? "No finished response in this session yet" : "The focused terminal runs no Claude Code or Codex";
    return h_flex().id("tps").size_full().px(10).gap(6).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("tps-value").gap(5).items_center().px(4).rounded(4).tooltip(tip)
        .child(div().size(7).rounded(4).flex_none().bg(d?.busy ? t.working : d ? t.muted : t.dim))
        .child(div().text_color(d ? t.foreground : t.dim).child(`${fmt(last)} tok/s`))
        .when(Boolean(d), (e) => e.child(div().text_color(t.dim).child(`· ${fmt(recent)} avg`))));
  }
}
