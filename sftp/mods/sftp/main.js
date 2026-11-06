import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { appHome, home, exec, hc, theme, props, shared, setShared, closeOverlay, openOverlay, run, nextCommand, pickFolder } from "herdr";
import { CONNECTIONS_KEY, connectionFrom, machineConnections, joinPath, parentPath, visibleEntries, sizeLabel, makeTransfer } from "./model.js";

const icon = (name, size = 15) => svg(`mods/sftp/${name}.svg`).size(size).flex_none();
const message = error => String(error?.message || error);
const terminalState = state => ["done", "error", "cancelled"].includes(state);

export default class Sftp extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (props()?.launcher) {
      cx.spawn(async (cx) => {
        for (;;) {
          if (await nextCommand() === "focus") this.handle.focus();
          cx.notify();
        }
      });
      return;
    }
    this.handle.focus();
    this.closed = false;
    this.machineList = [];
    this.machineError = "";
    this.machineLoading = false;
    this.connection = null;
    this.connected = false;
    this.notice = "";
    this.form = null;
    this.formError = "";
    this.hidden = false;
    this.width = 1120;
    this.queue = [];
    this.transferring = false;
    this.polling = false;
    this.sequence = 0;
    this.authTerminal = null;
    this.activeSide = "local";
    this.fields = {};
    for (const [key, placeholder] of Object.entries({ name: "连接名称（可选）", target: "ali / 192.168.1.10 / user@host", user: "使用 SSH 配置中的用户名", port: "使用 SSH 配置，默认 22", key: "~/.ssh/id_ed25519（可选）", path: "远程起始目录，默认主目录" })) {
      this.fields[key] = InputState.new({ placeholder });
      this.fields[key].on("change", (_e, cx) => { this.formError = ""; cx.notify(); });
      this.fields[key].on("submit", (_e, cx) => this.saveConnection(cx));
    }
    this.folderInput = InputState.new({ placeholder: "新文件夹名称" });
    this.folderInput.on("submit", (_e, cx) => this.createFolder(cx));
    this.folderSide = null;
    this.panes = {};
    for (const side of ["local", "remote"]) {
      const pane = { path: side === "local" ? home() : "", entries: [], selection: [], error: "", loading: false, epoch: 0, filter: "", sort: "name", descending: false };
      pane.pathInput = InputState.new({ value: pane.path, placeholder: "输入路径，按 Enter 跳转" });
      pane.filterInput = InputState.new({ placeholder: "筛选文件…" });
      pane.scroll = VirtualListScrollHandle.new();
      pane.pathInput.on("submit", (_e, cx) => this.load(side, pane.pathInput.value(), cx));
      pane.filterInput.on("change", (_e, cx) => { pane.filter = pane.filterInput.value(); pane.selection = []; pane.scroll.scroll_to_item(0); cx.notify(); });
      this.panes[side] = pane;
    }
    this.load("local", props()?.localPath || home(), cx);
    this.loadMachines(cx);
    if (props()?.connection) this.connect(props().connection, cx);
    cx.timer.every(600, (cx) => this.poll(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  async backend(request) {
    const folder = `${appHome()}/mods/sftp`;
    const result = await exec(`${folder}/.venv/bin/python`, [`${folder}/backend.py`, `${appHome()}/data/sftp`, JSON.stringify(request)]);
    let data;
    try { data = JSON.parse(result.stdout); }
    catch { throw new Error(result.stderr || "SFTP 后端未返回数据，请重新运行 install.sh"); }
    if (!data.ok) throw new Error(data.error || "操作失败");
    return data;
  }

  saved() {
    const records = shared(CONNECTIONS_KEY);
    return Array.isArray(records) ? records.filter(c => c && typeof c.id === "string" && typeof c.target === "string") : [];
  }

  loadMachines(cx) {
    if (this.machineLoading) return;
    this.machineLoading = true;
    cx.spawn(async (cx) => {
      try {
        const result = await hc(["machine", "ls", "--json"]);
        if (result.code !== 0) throw new Error(result.stderr || "无法读取机器列表");
        this.machineList = machineConnections(JSON.parse(result.stdout).machines || []);
        this.machineError = "";
      } catch (error) { this.machineError = message(error); }
      this.machineLoading = false;
      cx.notify();
    });
  }

  load(side, path, cx) {
    if (this.closed || (side === "remote" && !this.connection)) return;
    const pane = this.panes[side];
    const connection = side === "remote" ? { ...this.connection } : null;
    const epoch = ++pane.epoch;
    pane.loading = true;
    pane.error = "";
    pane.selection = [];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.backend({ op: "list", path, connection });
        if (this.closed || epoch !== pane.epoch) return;
        pane.path = result.path;
        pane.pathInput.set_value(result.path);
        pane.entries = result.entries;
        pane.scroll.scroll_to_item(0);
        if (side === "remote") this.connected = true;
      } catch (error) {
        if (this.closed || epoch !== pane.epoch) return;
        pane.error = message(error);
      }
      pane.loading = false;
      cx.notify();
    });
  }

  connect(connection, cx) {
    this.form = null;
    this.folderSide = null;
    this.connection = { ...connection };
    this.connected = false;
    const pane = this.panes.remote;
    pane.entries = [];
    pane.path = "";
    pane.pathInput.set_value("");
    pane.filterInput.set_value("");
    pane.filter = "";
    this.load("remote", connection.path || ".", cx);
  }

  disconnect(cx) {
    if (this.queue.some(job => !terminalState(job.state))) this.notice = "已断开文件浏览。队列中的传输仍使用原来的机器和路径；可在下方取消。";
    const pane = this.panes.remote;
    pane.epoch++;
    pane.entries = [];
    pane.selection = [];
    pane.error = "";
    pane.path = "";
    pane.loading = false;
    pane.pathInput.set_value("");
    this.connection = null;
    this.connected = false;
    this.folderSide = null;
    cx.notify();
  }

  edit(connection, cx) {
    this.form = connection || {};
    this.formError = "";
    for (const key of Object.keys(this.fields)) this.fields[key].set_value(connection?.[key] || "");
    this.fields.target.focus();
    cx.notify();
  }

  saveConnection(cx) {
    try {
      const values = Object.fromEntries(Object.entries(this.fields).map(([k, v]) => [k, v.value()]));
      const connection = { ...connectionFrom(values), id: this.form?.id || `saved:${Date.now()}-${++this.sequence}`, source: "saved" };
      const existing = this.saved().filter(c => c.id !== connection.id);
      setShared(CONNECTIONS_KEY, [...existing, connection]);
      this.connect(connection, cx);
    } catch (error) { this.formError = message(error); cx.notify(); }
  }

  authenticate(cx) {
    if (!this.connection || this.authBusy) return;
    const connection = { ...this.connection };
    this.authBusy = true;
    cx.spawn(async (cx) => {
      try {
        const { argv } = await this.backend({ op: "auth", connection });
        // All connection values remain positional argv; the shell program is fixed.
        const script = '"$@"; result=$?; printf "\\nSSH finished (%s). Close this window and reconnect in SFTP.\\n" "$result"; read -r answer';
        const result = await hc(["run", "--bg", "--json", "--no-parent", "--", "sh", "-c", script, "sftp-auth", ...argv]);
        if (result.code !== 0) throw new Error(result.stderr || "无法打开认证终端");
        const address = JSON.parse(result.stdout).address;
        if (!address) throw new Error("认证终端没有返回地址");
        if (this.closed) { run("terminal.kill", { terminal: address }); return; }
        if (this.authTerminal) run("terminal.kill", { terminal: this.authTerminal });
        this.authTerminal = address;
        openOverlay({ kind: "dialog", width: 760, height: 360, layout: { type: "block", content: { terminal: address } } });
        this.notice = "完成 SSH 认证后，关闭终端并点击“重新连接”。认证会复用 10 分钟。";
      } catch (error) { this.notice = message(error); }
      this.authBusy = false;
      cx.notify();
    });
  }

  select(side, name, cx) {
    const pane = this.panes[side];
    const file = pane.entries.find(e => e.name === name);
    if (!file || pane.loading) return;
    this.activeSide = side;
    this.handle.focus();
    const now = Date.now();
    if (file.directory && pane.lastClick?.name === name && now - pane.lastClick.time < 450) {
      pane.lastClick = null;
      this.load(side, joinPath(pane.path, name), cx);
      return;
    }
    pane.lastClick = { name, time: now };
    pane.selection = pane.selection.includes(name) ? pane.selection.filter(n => n !== name) : [...pane.selection, name];
    cx.notify();
  }

  enqueue(side, cx) {
    const pane = this.panes[side];
    if (!this.connected || this.form || this.panes.local.loading || this.panes.remote.loading || this.panes.local.error || this.panes.remote.error) return;
    const files = pane.entries.filter(e => pane.selection.includes(e.name));
    let skipped = 0;
    for (const file of files) {
      if (!file.regular || file.link) { skipped++; continue; }
      const request = makeTransfer(side, file, this.panes.local.path, this.panes.remote.path, this.connection);
      this.queue.push({ key: ++this.sequence, name: file.name, request, state: "queued", bytes: 0, total: file.size });
    }
    if (skipped) this.notice = "文件夹和链接未加入队列；请进入文件夹选择普通文件。";
    pane.selection = [];
    this.startNext(cx);
    cx.notify();
  }

  startNext(cx) {
    if (this.closed || this.transferring) return;
    const job = this.queue.find(item => item.state === "queued");
    if (!job) return;
    this.transferring = true;
    job.state = "starting";
    cx.spawn(async (cx) => {
      try {
        const result = await this.backend({ op: "start", task: job.request });
        job.id = result.id;
        if (this.closed || job.cancel) await this.backend({ op: "cancel", id: job.id });
        job.state = "running";
      } catch (error) {
        job.state = "error";
        job.error = message(error);
        this.transferring = false;
      }
      if (this.closed) return;
      this.startNext(cx);
      cx.notify();
    });
  }

  poll(cx) {
    if (this.closed || this.polling) return;
    const job = this.queue.find(item => item.state === "running" && item.id);
    if (!job) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const result = await this.backend({ op: "status", id: job.id });
        Object.assign(job, result);
        job.pollFailures = 0;
      } catch (error) {
        job.pollFailures = (job.pollFailures || 0) + 1;
        if (job.pollFailures >= 3) {
          job.state = "error";
          job.error = message(error);
          await this.backend({ op: "cancel", id: job.id }).catch(() => {});
        }
      }
      this.polling = false;
      if (this.closed) return;
      if (terminalState(job.state)) {
        this.transferring = false;
        const side = job.request.op === "upload" ? "remote" : "local";
        const pane = this.panes[side];
        const sameHost = side === "local" || JSON.stringify(this.connection) === JSON.stringify(job.request.connection);
        if (job.state === "done" && sameHost && parentPath(job.request.destination) === pane.path) this.load(side, pane.path, cx);
        this.startNext(cx);
      }
      cx.notify();
    });
  }

  cancelJob(job, cx) {
    job.cancel = true;
    if (job.state === "queued") job.state = "cancelled";
    if (job.id) cx.spawn(async (cx) => {
      try { await this.backend({ op: "cancel", id: job.id }); }
      catch (error) { this.notice = message(error); }
      cx.notify();
    });
    cx.notify();
  }

  newFolder(side, cx) {
    this.folderSide = side;
    this.folderInput.set_value("");
    this.folderInput.focus();
    cx.notify();
  }

  createFolder(cx) {
    const side = this.folderSide;
    const name = this.folderInput.value().trim();
    if (!side || !name || this.folderBusy) return;
    const pane = this.panes[side];
    const path = pane.path;
    const connection = side === "remote" ? this.connection : null;
    this.folderBusy = true;
    cx.spawn(async (cx) => {
      try {
        await this.backend({ op: "mkdir", path, name, connection });
        this.folderSide = null;
        if (path === pane.path && (side === "local" || connection === this.connection)) this.load(side, path, cx);
      } catch (error) { this.notice = message(error); }
      this.folderBusy = false;
      cx.notify();
    });
  }

  async close() {
    if (props()?.launcher) return;
    this.closed = true;
    if (this.authTerminal) run("terminal.kill", { terminal: this.authTerminal });
    const job = this.queue.find(item => item.id && !terminalState(item.state));
    if (job) await this.backend({ op: "cancel", id: job.id }).catch(() => {});
  }

  button(id, label, action, { glyph, primary = false, disabled = false } = {}) {
    const t = theme();
    return h_flex().id(id).h(30).px(glyph && !label ? 7 : 10).gap(6).flex_none().items_center().justify_center()
      .rounded(6).border(1).border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.muted).text_size(12)
      .opacity(disabled ? 0.4 : 1).cursor_pointer().when(!disabled, el => el.hover(s => s.opacity(0.8)).on_click(action))
      .when(Boolean(glyph), el => el.child(icon(glyph)))
      .when(Boolean(label), el => el.child(label));
  }

  input(state, id) {
    const t = theme();
    return Input.new(state).id(id).w_full().min_w(0).h(32).px(9).text_size(12.5)
      .bg(t.background).text_color(t.foreground).border(1).border_color(t.input).rounded(6);
  }

  empty(glyph, title, detail) {
    const t = theme();
    return v_flex().flex_1().min_h(100).px(22).gap(10).items_center().justify_center()
      .child(icon(glyph, 30).text_color(t.dim))
      .child(div().text_size(14).font_medium().text_color(t.foreground).child(title))
      .child(div().text_size(12).line_height("19px").text_color(t.dim).child(detail));
  }

  sidebar() {
    const t = theme();
    const row = (c) => h_flex().id(`host-${c.id}`).h(52).px(10).gap(8).items_center().rounded(7)
      .bg(this.connection?.id === c.id ? t.selected : "#00000000").hover(s => s.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => this.connect(c, cx))
      .child(icon("server").text_color(this.connection?.id === c.id ? t.accent : t.dim))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(13).text_color(t.foreground).child(c.name))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(c.target)))
      .when(c.source === "saved", el => el.child(div().id(`edit-${c.id}`).p(4).rounded(4).hover(s => s.bg(t.raised))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.edit(c, cx); }).child(icon("edit", 12).text_color(t.dim))));
    const heading = label => div().px(10).pt(16).pb(6).text_size(10.5).font_semibold().text_color(t.dim).child(label);
    return v_flex().w(this.width < 960 ? 164 : 190).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border).p(10)
      .child(h_flex().h(44).gap(8).px(10).items_center().child(icon("transfer", 20).text_color(t.accent))
        .child(div().text_size(17).font_semibold().child("SFTP")))
      .child(this.button("add-connection", "添加连接", (_e, cx) => this.edit(null, cx), { glyph: "plus" }))
      .child(v_flex().id("connections").flex_1().min_h(0).overflow_y_scrollbar()
        .child(heading("HERDR 机器"))
        .children(this.machineList.map(row))
        .when(!this.machineList.length, el => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child(this.machineLoading ? "正在读取…" : "暂无已添加的机器")))
        .when(Boolean(this.machineError), el => el.child(div().p(10).text_size(11).text_color(t.blocked).child(this.machineError)))
        .child(heading("已保存连接"))
        .children(this.saved().map(row))
        .when(!this.saved().length, el => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child("添加主机或 SSH 别名"))))
      .child(div().px(10).py(10).text_size(11).line_height("17px").text_color(t.dim).child("通过 SSH 安全传输\n连接配置保存在本机"))
      .child(this.button("refresh-machines", "刷新机器列表", (_e, cx) => this.loadMachines(cx), { glyph: "refresh", disabled: this.machineLoading }));
  }

  connectionForm() {
    const t = theme();
    const field = (key, title) => v_flex().gap(5).child(div().text_size(12).text_color(t.muted).child(title)).child(this.input(this.fields[key], `connection-${key}`));
    const body = v_flex().id("connection-form").flex_1().min_h(0).p(18).gap(10).overflow_y_scrollbar()
      .child(div().text_size(17).font_semibold().child(this.form?.id ? "编辑连接" : "添加 SFTP 连接"))
      .child(div().text_size(12).line_height("18px").text_color(t.dim).child("输入 SSH 别名或服务器地址，无需在服务器安装 Herdr。"))
      .child(field("name", "名称"))
      .child(field("target", "主机 / SSH 别名 *"))
      .child(h_flex().gap(10).child(div().flex_1().min_w(0).child(field("user", "用户名"))).child(div().w(110).child(field("port", "端口"))))
      .child(field("key", "私钥路径"))
      .child(field("path", "起始目录"))
      .child(div().text_size(11.5).line_height("18px").text_color(t.dim).child("默认使用 SSH 配置和 Agent。需要密码或首次确认主机时，连接后点击“SSH 认证”。密码不会保存。"))
      .when(Boolean(this.formError), el => el.child(div().text_size(12).text_color(t.blocked).child(this.formError)))
      .when(Boolean(this.form?.id), el => el.child(this.button("remove-connection", "移除已保存连接", (_e, cx) => {
        setShared(CONNECTIONS_KEY, this.saved().filter(c => c.id !== this.form.id));
        this.form = null;
        cx.notify();
      })));
    return v_flex().flex_1().min_h(0).child(body).child(h_flex().h(54).flex_none().px(18).gap(8).items_center().border_t(1).border_color(t.border)
      .child(this.button("save-connect", "保存并连接", (_e, cx) => this.saveConnection(cx), { primary: true }))
      .child(this.button("cancel-form", "取消", (_e, cx) => { this.form = null; cx.notify(); })));
  }

  filePane(side) {
    const t = theme();
    const pane = this.panes[side];
    const remote = side === "remote";
    const available = !remote || this.connected;
    const rows = visibleEntries(pane.entries, pane.filter, this.hidden, pane.sort, pane.descending);
    const listId = `${side}-files`;
    const sortButton = (label, key, width) => div().id(`${side}-sort-${key}`).when(Boolean(width), el => el.w(width).flex_none()).when(!width, el => el.flex_1())
      .cursor_pointer().on_click((_e, cx) => { pane.descending = pane.sort === key ? !pane.descending : false; pane.sort = key; cx.notify(); })
      .child(`${label}${pane.sort === key ? pane.descending ? " ↓" : " ↑" : ""}`);
    const container = v_flex().flex_1().min_w(0).h_full().min_h(0).bg(t.surface)
      .when(!remote, el => el.border_r(1).border_color(t.border))
      .child(h_flex().h(48).px(14).gap(8).items_center().flex_none()
        .child(icon(remote ? "server" : "computer").text_color(t.accent))
        .child(div().flex_1().truncate().font_medium().text_size(13).child(remote ? this.connection?.name || "远程机器" : "本地文件"))
        .when(remote && Boolean(this.connection), el => el.child(this.button("disconnect", "断开", (_e, cx) => this.disconnect(cx)))));
    if (remote && this.form) return container.child(this.connectionForm());
    if (remote && !this.connection) return container.child(this.empty("server", "连接一台机器", "选择左侧已有机器，或添加新的 SFTP 连接。"))
      .child(div().p(20).child(this.button("empty-add", "添加连接", (_e, cx) => this.edit(null, cx), { glyph: "plus" })));
    container.child(v_flex().px(12).pb(10).gap(8).flex_none()
      .child(h_flex().gap(5)
        .child(this.button(`${side}-up`, "", (_e, cx) => this.load(side, parentPath(pane.path), cx), { glyph: "up", disabled: !available || pane.loading }))
        .child(this.button(`${side}-home`, "", (_e, cx) => this.load(side, remote ? "." : home(), cx), { glyph: "home", disabled: pane.loading }))
        .child(div().flex_1().min_w(0).child(this.input(pane.pathInput, `${side}-path`)))
        .child(this.button(`${side}-refresh`, "", (_e, cx) => this.load(side, pane.path || this.connection?.path || ".", cx), { glyph: "refresh", disabled: pane.loading })))
      .child(h_flex().gap(6)
        .child(div().flex_1().min_w(0).child(this.input(pane.filterInput, `${side}-filter`)))
        .child(this.button(`${side}-mkdir`, "", (_e, cx) => this.newFolder(side, cx), { glyph: "folder-plus", disabled: !available || pane.loading }))
        .when(!remote, el => el.child(this.button("pick-local-folder", "", (_e, cx) => cx.spawn(async (cx) => {
          try { const path = await pickFolder({ prompt: "选择本地文件夹" }); if (path) this.load("local", path, cx); }
          catch (error) { this.notice = message(error); cx.notify(); }
        }), { glyph: "folder" })))));
    if (pane.error) container.child(v_flex().px(14).py(10).gap(8).bg(t.chrome)
      .child(div().text_size(12).line_height("18px").text_color(t.blocked).child(pane.error))
      .when(remote, el => el.child(h_flex().gap(8)
        .child(this.button("ssh-auth", this.authBusy ? "正在打开…" : "SSH 认证", (_e, cx) => this.authenticate(cx), { disabled: this.authBusy }))
        .child(this.button("reconnect", "重新连接", (_e, cx) => this.load("remote", pane.path || this.connection.path || ".", cx))))));
    if (this.folderSide === side) container.child(h_flex().px(12).pb(8).gap(6)
      .child(div().flex_1().min_w(0).child(this.input(this.folderInput, `${side}-folder-name`)))
      .child(this.button("create-folder", "创建", (_e, cx) => this.createFolder(cx), { disabled: this.folderBusy }))
      .child(this.button("cancel-folder", "", (_e, cx) => { this.folderSide = null; cx.notify(); }, { glyph: "close" })));
    container.child(h_flex().h(28).px(14).gap(8).items_center().text_size(10.5).text_color(t.dim).border_y(1).border_color(t.border).bg(t.chrome)
      .child(sortButton("名称", "name"))
      .child(sortButton("大小", "size", 62))
      .when(this.width >= 1050, el => el.child(sortButton("修改时间", "modified", 78))));
    if (pane.loading) container.child(this.empty("refresh", "正在读取目录…", remote ? this.connection.target : pane.path));
    else if (!rows.length) container.child(this.empty("folder", pane.error ? "目录未加载" : "没有可显示的文件", pane.filter ? "试试其他文件名，或清空筛选条件。" : this.hidden ? "此目录为空。" : "此目录为空，或仅包含隐藏文件。"));
    else container.child(div().relative().flex_1().min_h(0)
      .child(v_virtual_list(listId, rows.length, 32, index => rows[index].name,
        range => rows.slice(range.start, range.end).map(file => h_flex().h(32).px(14).gap(8).items_center()
          .bg(pane.selection.includes(file.name) ? t.selected : "#00000000").hover(s => s.bg(t.hover))
          .child(icon(file.directory ? "folder" : "file", 14).text_color(file.directory ? t.accent : t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${file.name}${file.link ? " ↗" : ""}`))
          .child(div().w(62).flex_none().text_size(10.5).text_color(t.dim).child(file.directory ? "—" : sizeLabel(file.size)))
          .when(this.width >= 1050, el => el.child(div().w(78).flex_none().text_size(10.5).text_color(t.dim).child(new Date(file.modified * 1000).toISOString().slice(0, 10))))))
        .size_full().track_scroll(pane.scroll).on_item_click((name, cx) => this.select(side, name, cx)))
      .child(Scrollbar.vertical(listId).absolute().inset_0()));
    return container.child(h_flex().h(45).px(12).gap(8).flex_none().items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().text_size(11).text_color(t.dim).child(pane.selection.length ? `已选 ${pane.selection.length} 项` : `${rows.length} 项 · 双击进入文件夹`))
      .child(this.button(`${side}-transfer`, remote ? "下载" : "上传", (_e, cx) => this.enqueue(side, cx), {
        glyph: remote ? "download" : "upload", primary: true,
        disabled: !this.connected || Boolean(this.form) || this.panes.local.loading || this.panes.remote.loading || Boolean(this.panes.local.error || this.panes.remote.error) || !pane.entries.some(e => pane.selection.includes(e.name) && e.regular && !e.link),
      })));
  }

  transfers() {
    const t = theme();
    const labels = { queued: "等待中", starting: "正在连接", running: "传输中", done: "已完成", error: "失败", cancelled: "已取消" };
    const active = this.queue.filter(j => !terminalState(j.state)).length;
    const rows = this.queue.map(job => v_flex().py(5).gap(3)
      .child(h_flex().gap(8).items_center()
        .child(icon(job.request.op === "upload" ? "upload" : "download", 13).text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(`${job.name} → ${job.request.op === "upload" ? job.request.connection.name : "本地"}`))
        .child(div().text_size(11).text_color(job.state === "error" ? t.blocked : job.state === "done" ? t.done : t.dim).child(`${labels[job.state]}${job.cancel && !terminalState(job.state) ? " · 正在取消" : ""}`))
        .child(div().w(112).text_size(11).text_color(t.dim).child(`${sizeLabel(job.bytes)} / ${sizeLabel(job.total)}`))
        .when(!terminalState(job.state), el => el.child(this.button(`cancel-${job.key}`, "", (_e, cx) => this.cancelJob(job, cx), { glyph: "close", disabled: job.cancel }))))
      .when(Boolean(job.error), el => el.child(div().text_size(11).text_color(t.blocked).child(job.error)))
      .when(job.state === "running" && job.total > 0, el => el.child(div().h(2).bg(t.border)
        .child(div().h(2).w(`${Math.min(100, job.bytes / job.total * 100)}%`).bg(t.accent)))));
    return v_flex().h(this.queue.length ? 135 : 46).flex_none().border_t(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().h(36).px(16).gap(8).items_center().flex_none()
        .child(icon("transfer", 14).text_color(t.dim))
        .child(div().font_medium().text_size(12).child(active ? `传输队列 · ${active} 个任务` : "传输队列"))
        .child(div().flex_1().text_size(11).text_color(t.muted).child(active ? "关闭面板会取消未完成的传输" : this.queue.length ? "" : "单击文件可多选 · 同名文件不会覆盖"))
        .when(this.queue.some(j => terminalState(j.state)), el => el.child(this.button("clear-transfers", "清除记录", (_e, cx) => { this.queue = this.queue.filter(j => !terminalState(j.state)); cx.notify(); }))))
      .when(Boolean(this.queue.length), el => el.child(v_flex().id("transfer-list").flex_1().min_h(0).overflow_y_scrollbar().px(16)
        .children(rows)));
  }

  render() {
    const t = theme();
    if (props()?.launcher) return h_flex().id("sftp-launcher").size_full().bg(t.chrome).px(8).text_size(13).overflow_hidden()
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === "enter" || event.key === "space") {
          run("mod.open", { name: "sftp" });
          cx.stop_propagation();
        }
      })
      .on_size_change((size, cx) => { if (size.width !== this.launcherWidth) { this.launcherWidth = size.width; cx.notify(); } })
      .child(h_flex().id("open-sftp").h(28).w_full().px(8).gap(9).items_center().rounded(8)
        .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(() => run("mod.open", { name: "sftp" })).child(icon("transfer", 14)).when(this.launcherWidth > 100, el => el.child("SFTP")));
    return h_flex().id("sftp-root").size_full().min_h(0).bg(t.popover).text_color(t.foreground).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          if (this.folderSide) this.folderSide = null;
          else if (this.form) this.form = null;
          else { closeOverlay(props().overlay); return; }
        } else if (event.key === "enter") {
          const pane = this.panes[this.activeSide];
          const directory = pane.entries.find(e => pane.selection.includes(e.name) && e.directory);
          if (directory) this.load(this.activeSide, joinPath(pane.path, directory.name), cx);
          else return;
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.sidebar())
      .child(v_flex().flex_1().min_w(0).h_full().min_h(0)
        .child(h_flex().h(56).px(18).gap(10).flex_none().items_center().border_b(1).border_color(t.border)
          .child(v_flex().flex_1().gap(3).child(div().text_size(15).font_semibold().child("文件传输"))
            .child(div().text_size(11).text_color(t.dim).child("本地与远程，左右浏览")))
          .child(this.button("hidden-files", this.hidden ? "隐藏点文件" : "显示隐藏文件", (_e, cx) => {
            this.hidden = !this.hidden;
            this.panes.local.selection = [];
            this.panes.remote.selection = [];
            cx.notify();
          }))
          .child(this.button("close-sftp", "", () => closeOverlay(props().overlay), { glyph: "close" })))
        .when(Boolean(this.notice), el => el.child(h_flex().px(14).py(8).gap(8).bg(t.raised)
          .child(div().flex_1().text_size(11.5).line_height("17px").text_color(t.muted).child(this.notice))
          .child(this.button("dismiss-notice", "", (_e, cx) => { this.notice = ""; cx.notify(); }, { glyph: "close" }))))
        .child(h_flex().flex_1().min_h(0).min_w(0).child(this.filePane("local")).child(this.filePane("remote")))
        .child(this.transfers()));
  }
}
