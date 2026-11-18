// The last machine connection error in full (shared "conn.lastError", written by the status bar and
// the sidebar): copy it, reconnect, close. Opened by clicking the error toast or "disconnected".
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, shared, setShared, theme, exec, hc, notify } from "herdr";

export default class ConnDetails extends View {
  init(_props, cx) { this.busy = false; this.copied = false; this.result = null; }

  reconnect(e, cx) {
    if (this.busy) return;
    this.busy = true; this.result = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const probe = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", e.target ?? e.machine, "true"], { timeout: 15000 })
          .catch((x) => ({ code: 1, stderr: String(x?.message ?? x) }));
        if (probe.code !== 0) {
          const why = (probe.stderr || "").trim() || "no answer";
          setShared("conn.lastError", { ...e, at: Date.now(), title: `${e.machine}: not responding`, body: `${why}\nAsleep, no network, another Wi-Fi or a new address (~/.ssh/config).` });
          this.result = "Still not responding: the text above is updated.";
        } else {
          const r = await hc(["exec", "--on", e.machine, "true"]).catch((x) => ({ code: 1, stderr: String(x?.message ?? x) }));
          if (r.code === 0) { this.result = "Connected."; notify({ title: `${e.machine}: connected`, level: "info", timeout: 4000 }); }
          else {
            setShared("conn.lastError", { ...e, at: Date.now(), title: `${e.machine}: ssh works, but hc did not connect`, body: (r.stderr || r.stdout || "").trim() });
            this.result = "ssh works, hc didn't connect: the text above is updated.";
          }
        }
      } finally { this.busy = false; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme(), e = shared("conn.lastError");
    const btn = (id, label, fn, primary = false) => div().id(id).flex_none().h(28).px(12).flex().items_center().rounded(6).text_size(12)
      .when(primary, (x) => x.bg(t.solid).text_color(t.solid_foreground)).when(!primary, (x) => x.border_1().border_color(t.border))
      .cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_ev, cx) => fn(cx)).child(label);
    if (!e) {
      return v_flex().size_full().p(16).gap(12).bg(t.popover).text_color(t.foreground)
        .child(div().text_size(13).child("No connection errors yet."))
        .child(h_flex().justify_end().child(btn("cd-close", "Close", () => closeOverlay(props().overlay))));
    }
    const text = `${e.title}\n${new Date(e.at).toLocaleString()}\n\n${e.body ?? ""}`;
    return v_flex().size_full().p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(div().text_size(14).font_semibold().text_color(t.ansi1).child(e.title))
      .child(div().text_size(11).text_color(t.dim).child(`${e.machine} · ${new Date(e.at).toLocaleString()}`))
      .child(v_flex().id("cd-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).rounded(6).bg(t.background)
        .font_family("JetBrains Mono").text_size(12)
        .children(String(e.body ?? "").split("\n").map((l) => div().child(l || " "))))
      .when(Boolean(this.result), (x) => x.child(div().text_size(12).text_color(t.muted).child(this.result)))
      .child(h_flex().gap(8).items_center()
        .child(btn("cd-copy", this.copied ? "Copied" : "Copy", (cx) => { cx.write_to_clipboard(text); this.copied = true; cx.notify(); }))
        .child(div().flex_1())
        .child(btn("cd-reconnect", this.busy ? "Reconnecting…" : "↻ Reconnect", (cx) => this.reconnect(e, cx), true))
        .child(btn("cd-close", "Close", () => closeOverlay(props().overlay))));
  }
}
