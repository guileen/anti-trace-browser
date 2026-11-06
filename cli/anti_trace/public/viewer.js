(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries(["connection-dot", "connection-state", "viewer-title", "owner-status", "take-control", "resume-agent", "reclaim", "error", "page-select", "refresh", "focus-page", "page-url", "stage", "empty-frame", "frame-status", "frame", "frame-meta", "input-status", "text-entry", "send-text", "input-sink"].map((id) => [id, byId(id)]));
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token") || "";
  history.replaceState(null, "", location.pathname);
  const viewerId = crypto.randomUUID();
  let state = null, frame = null, imageURL = null, connected = false, stopped = false;
  let capturePromise = null, queued = 0, actionChain = Promise.resolve(), controlBusy = false;
  let composing = false, compositionCommit = null, lastMove = 0;
  let pages = [], lastPages = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const human = () => connected && state?.owner === "human" && state.owner_id === viewerId;

  function error(message) {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }
  function applyState(next) {
    if (next) state = next;
    if (!state) return;
    const mine = human();
    const owners = {agent: "Agent 持有控制权 · 当前仅查看", human: mine ? "人工控制中 · Agent 写入已暂停" : "另一查看器持有人工控制权", paused: "已暂停 · 不会自动恢复写入"};
    ui["owner-status"].textContent = state.pending_human ? "正在等待已下发动作结束，再授予人工控制…" : owners[state.owner] || "未知控制状态";
    if (state.reason && state.owner === "paused") ui["owner-status"].textContent += `（${state.reason}）`;
    ui["take-control"].disabled = controlBusy || !connected || mine || state.owner === "human" || state.pending_human;
    ui["resume-agent"].disabled = controlBusy || !mine;
    ui.reclaim.disabled = controlBusy || !connected || state.owner !== "paused" || state.pending_human;
    ui["page-select"].disabled = !mine || !frame || controlBusy;
    ui["focus-page"].disabled = !mine || !frame || controlBusy;
    ui["text-entry"].disabled = !mine || controlBusy;
    ui["send-text"].disabled = !mine || !frame || controlBusy;
    ui["input-sink"].disabled = !mine || controlBusy;
    ui.refresh.disabled = !connected || controlBusy;
    ui.stage.classList.toggle("controlling", mine);
    ui["input-status"].textContent = mine ? (queued ? `输入队列 ${queued}` : "人工独占输入 · 点击页面后可直接打字") : "当前只读";
    ui["input-status"].classList.toggle("controlling", mine);
  }
  function connection(live, label) {
    connected = live;
    ui["connection-state"].textContent = label;
    ui["connection-dot"].className = `dot ${live ? "live" : "error"}`;
    applyState();
  }
  async function request(path, payload, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(path, {
        method: payload === undefined ? "GET" : "POST",
        headers: {Authorization: `Bearer ${token}`, "X-Viewer-Id": viewerId,
          ...(payload === undefined ? {} : {"Content-Type": "application/json"})},
        body: payload === undefined ? undefined : JSON.stringify(payload),
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
        ...options
      });
      if (!response.ok) {
        const data = await response.json();
        applyState(data.state);
        const failure = new Error(data.error?.message || `HTTP ${response.status}`);
        failure.code = data.error?.code;
        if (response.status === 401) {
          stopped = true;
          connection(false, "链接已失效");
        }
        throw failure;
      }
      return response;
    } finally { clearTimeout(timer); }
  }
  async function json(path, payload) { return (await request(path, payload)).json(); }

  async function updatePages() {
    const data = await json("/api/pages");
    pages = data.pages;
    applyState(data.state);
    ui["page-select"].replaceChildren();
    for (const page of pages) {
      const option = document.createElement("option");
      option.value = page.page_id;
      option.textContent = page.title || "未命名页面";
      option.selected = page.page_id === (frame?.page_id || data.page_id);
      ui["page-select"].append(option);
    }
    if (!pages.length) {
      const option = document.createElement("option");
      option.textContent = "没有可用标签页";
      ui["page-select"].append(option);
    }
    lastPages = performance.now();
  }

  function refreshFrame() {
    if (capturePromise) return capturePromise;
    capturePromise = (async () => {
      const response = await request("/api/frame");
      const encoded = response.headers.get("X-Viewer-Frame");
      if (!encoded) throw new Error("运行时没有返回画面标识");
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const next = JSON.parse(new TextDecoder().decode(bytes));
      const blob = await response.blob();
      if (blob.type !== "image/png" || blob.size > 8 * 1024 * 1024) throw new Error("运行时画面格式或大小错误");
      const url = URL.createObjectURL(blob);
      const decoded = new Image();
      decoded.src = url;
      try { await decoded.decode(); } catch (failure) { URL.revokeObjectURL(url); throw failure; }
      const previous = imageURL;
      imageURL = url;
      ui.frame.src = url;
      frame = next;
      ui.frame.hidden = false;
      ui["empty-frame"].hidden = true;
      if (previous) URL.revokeObjectURL(previous);
      connection(true, "本机会话已连接");
      applyState(next.state);
      ui["frame-meta"].textContent = `${next.width} × ${next.height} px · CSS ${next.viewport.width} × ${next.viewport.height} · 观察 ${next.observation_id}`;
      ui["page-select"].value = next.page_id;
      const currentPage = pages.find((page) => page.page_id === next.page_id);
      ui["page-url"].textContent = currentPage?.url || "当前运行时页面";
      return next;
    })().finally(() => { capturePromise = null; });
    return capturePromise;
  }

  function observed() {
    if (!frame || !human()) return null;
    return {page_id: frame.page_id, frame_id: frame.frame_id,
      observation_id: frame.observation_id, owner_revision: state.owner_revision};
  }
  function enqueue(operation, args, origin = observed()) {
    if (!origin) return Promise.resolve();
    if (queued >= 32) { error("输入队列已满；请等待已有输入完成。"); return Promise.resolve(); }
    queued += 1;
    applyState();
    const work = actionChain.then(async () => {
      if (capturePromise) await capturePromise;
      if (!human() || !frame) throw new Error("控制权已改变；未发送此输入。");
      if (origin.page_id !== frame.page_id || origin.frame_id !== frame.frame_id || origin.owner_revision !== state.owner_revision) {
        throw new Error("页面或控制版本已改变；未发送排队中的输入。");
      }
      if ((operation === "mouse.click" || operation === "mouse.move" || operation === "mouse.wheel") && origin.observation_id !== frame.observation_id) {
        throw new Error("点击或滚动所依据的画面已改变，请重新操作。");
      }
      const payload = {operation, args, image_id: frame.image_id, page_id: frame.page_id,
        frame_id: frame.frame_id, observation_id: frame.observation_id, owner_revision: state.owner_revision};
      const data = await json("/api/action", payload);
      applyState(data.state);
      await refreshFrame();
      error("");
      if (operation === "context.select_page") await updatePages();
    });
    actionChain = work.catch(async (failure) => {
      error(`${failure.code ? `${failure.code} · ` : ""}${failure.message}`);
      if (!stopped) {
        try { await refreshFrame(); } catch (_) { /* The streaming loop retains the visible error. */ }
      }
    }).finally(() => { queued -= 1; applyState(); });
    return actionChain;
  }

  async function control(operation) {
    if (controlBusy || !state) return;
    controlBusy = true;
    applyState();
    try {
      await actionChain;
      const data = await json("/api/control", {operation, owner_revision: state.owner_revision, run_id: state.run_id});
      applyState(data.state);
      frame = null;
      await refreshFrame();
      await updatePages();
      error("");
    } catch (failure) { error(failure.message); }
    finally { controlBusy = false; applyState(); }
  }
  ui["take-control"].addEventListener("click", () => control("request_human"));
  ui["resume-agent"].addEventListener("click", () => control("resume_agent"));
  ui.reclaim.addEventListener("click", () => control("reclaim"));
  ui.refresh.addEventListener("click", () => {
    actionChain.then(() => refreshFrame()).catch((failure) => error(failure.message));
  });
  ui["page-select"].addEventListener("change", () => {
    const target = ui["page-select"].value;
    ui["page-select"].value = frame?.page_id || "";
    enqueue("context.select_page", {target_page_id: target});
  });

  function focusInput(event) {
    const sink = ui["input-sink"];
    if (event) {
      sink.style.left = `${Math.min(innerWidth - 4, Math.max(0, event.clientX))}px`;
      sink.style.top = `${Math.min(innerHeight - 24, Math.max(0, event.clientY))}px`;
    }
    sink.focus({preventScroll: true});
  }
  ui["focus-page"].addEventListener("click", () => {
    enqueue("page.focus", {}).then(() => { if (human()) focusInput(); });
  });
  function coordinates(event) {
    if (!frame || !human() || ui.frame.hidden) return null;
    const rect = ui.frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) / rect.width * frame.viewport.width;
    const y = (event.clientY - rect.top) / rect.height * frame.viewport.height;
    if (x < 0 || y < 0 || x >= frame.viewport.width || y >= frame.viewport.height) return null;
    return {x, y};
  }
  function click(event) {
    const point = coordinates(event);
    if (!point) return;
    event.preventDefault();
    const button = ({0: "left", 1: "middle", 2: "right"})[event.button];
    if (!button) return;
    focusInput(event);
    enqueue("mouse.click", {...point, button, click_count: Math.min(3, Math.max(1, event.detail || 1))});
  }
  ui.frame.addEventListener("click", click);
  ui.frame.addEventListener("auxclick", (event) => { if (event.button === 1) click(event); });
  ui.frame.addEventListener("contextmenu", click);
  ui.frame.addEventListener("dragstart", (event) => event.preventDefault());
  ui.frame.addEventListener("pointermove", (event) => {
    if (queued || capturePromise || performance.now() - lastMove < 160) return;
    const point = coordinates(event);
    if (!point) return;
    lastMove = performance.now();
    enqueue("mouse.move", point);
  });
  ui.stage.addEventListener("wheel", (event) => {
    if (!human() || !coordinates(event)) return;
    event.preventDefault();
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.viewport.height : 1;
    const clamp = (value) => Math.max(-10000, Math.min(10000, value * multiplier));
    enqueue("mouse.wheel", {delta_x: clamp(event.deltaX), delta_y: clamp(event.deltaY)});
  }, {passive: false});
  ui.stage.addEventListener("keydown", (event) => {
    if (human() && event.key === "Enter") { event.preventDefault(); focusInput(); }
  });

  const sink = ui["input-sink"];
  sink.addEventListener("compositionstart", () => { composing = true; compositionCommit = null; });
  sink.addEventListener("compositionend", (event) => {
    composing = false;
    compositionCommit = event.data || "";
    sink.value = "";
    if (compositionCommit) enqueue("keyboard.insert_text", {text: compositionCommit});
    // Chromium and WebKit differ on whether a final input follows compositionend.
    setTimeout(() => { compositionCommit = null; }, 0);
  });
  sink.addEventListener("input", (event) => {
    if (composing || event.isComposing) return;
    const value = sink.value;
    sink.value = "";
    if (compositionCommit !== null && (event.data === compositionCommit || value === compositionCommit)) {
      compositionCommit = null;
      return;
    }
    if (value) enqueue("keyboard.insert_text", {text: value});
  });
  sink.addEventListener("keydown", (event) => {
    if (!human() || event.isComposing || composing || event.key === "Process" || event.key === "Dead") return;
    if (["Control", "Meta", "Alt", "Shift", "CapsLock"].includes(event.key)) return;
    // Paste into the local input sink, then send the resulting actual text.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault();
    const modifiers = [];
    if (event.ctrlKey) modifiers.push("Control");
    if (event.altKey) modifiers.push("Alt");
    if (event.metaKey) modifiers.push("Meta");
    if (event.shiftKey) modifiers.push("Shift");
    const key = event.key === " " ? "Space" : event.key;
    enqueue("keyboard.press", {key: [...modifiers, key].join("+")});
  });
  ui["send-text"].addEventListener("click", () => {
    const value = ui["text-entry"].value;
    if (!value) { error("请先输入需要提交的文本。"); return; }
    enqueue("keyboard.insert_text", {text: value}).then(() => { if (human()) focusInput(); });
  });

  window.addEventListener("pagehide", () => {
    stopped = true;
    if (imageURL) URL.revokeObjectURL(imageURL);
    if (!token) return;
    // No URL/query token and no beacon fallback: authentication stays in headers.
    fetch("/api/control", {method: "POST", keepalive: true, credentials: "omit",
      headers: {Authorization: `Bearer ${token}`, "X-Viewer-Id": viewerId, "Content-Type": "application/json"},
      body: JSON.stringify({operation: "disconnect"})}).catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !stopped) refreshFrame().catch((failure) => error(failure.message));
  });

  async function heartbeat() {
    while (!stopped) {
      try {
        const data = await json("/api/state");
        connection(true, "本机会话已连接");
        applyState(data.state);
        ui["viewer-title"].textContent = data.title || "查看当前环境";
      } catch (failure) { connection(false, "连接中断 · 控制保持暂停"); error(failure.message); }
      await sleep(2000);
    }
  }
  async function stream() {
    while (!stopped) {
      const started = performance.now();
      if (!queued && !controlBusy && document.visibilityState !== "hidden") {
        try {
          await refreshFrame();
          if (performance.now() - lastPages > 5000) await updatePages();
        } catch (failure) {
          ui["frame-status"].textContent = "无法取得真实页面画面";
          error(`${failure.code ? `${failure.code} · ` : ""}${failure.message}`);
          if (!frame) ui["empty-frame"].hidden = false;
        }
      }
      await sleep(Math.max(100, 400 - (performance.now() - started)));
    }
  }
  if (!token) {
    stopped = true;
    connection(false, "需要会话授权");
    ui["frame-status"].textContent = "未提供本次会话的访问凭据";
    error("请从 CLI 返回的原始本地查看器链接打开。访问凭据不会保存到浏览器或日志。");
    return;
  }
  heartbeat();
  stream();
})();
