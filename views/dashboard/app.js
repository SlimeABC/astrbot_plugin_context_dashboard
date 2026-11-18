/**
 * astrbot_plugin_context_dashboard —— WebUI 视图
 *
 * 按对话（cid）展示上下文用量与压缩次数，支持搜索、排序与主题切换。
 * 所有需要 Dashboard 身份的操作都通过 window.AstrBotPluginView bridge。
 */

const bridge = window.AstrBotPluginView;

const els = {
  heading: document.getElementById("heading"),
  subtitle: document.getElementById("subtitle"),
  search: document.getElementById("search"),
  sort: document.getElementById("sort"),
  direction: document.getElementById("direction"),
  refresh: document.getElementById("refresh"),
  theme: document.getElementById("theme"),
  stats: document.getElementById("stats"),
  bots: document.getElementById("bots"),
  list: document.getElementById("list"),
  status: document.getElementById("status"),
};

const state = {
  items: [],
  bots: [],
  totals: null,
  query: "",
  bot: "all", // "all" 或 platform_id
  sort: "tokens", // updated | tokens | messages | compression
  direction: "desc", // asc | desc
  themeMode: "auto", // auto | light | dark
  loading: false,
  fetching: false,
  expanded: new Set(),
  details: new Map(), // item.key -> conversation payload
  autoRefresh: { enabled: true, intervalMinutes: 15 },
  refreshTimer: null,
};

const THEME_LABELS = {
  auto: ["theme_auto", "主题：跟随"],
  light: ["theme_light", "主题：浅色"],
  dark: ["theme_dark", "主题：深色"],
};

const SORT_OPTIONS = ["updated", "tokens", "messages", "compression"];
const COMPRESSION_THRESHOLD = 0.82;

const SORT_LABELS = {
  updated: ["sort_updated", "最近更新"],
  tokens: ["sort_tokens", "上下文用量"],
  messages: ["sort_messages", "消息数"],
  compression: ["sort_compression", "压缩次数"],
};

const SORTERS = {
  updated: (a, b) =>
    (a.updated_at || 0) - (b.updated_at || 0) ||
    (a.tokens || 0) - (b.tokens || 0),
  tokens: (a, b) =>
    (a.tokens || 0) - (b.tokens || 0) ||
    (a.updated_at || 0) - (b.updated_at || 0),
  messages: (a, b) =>
    (a.messages || 0) - (b.messages || 0) ||
    (a.updated_at || 0) - (b.updated_at || 0),
  compression: (a, b) =>
    (a.compression_count || 0) - (b.compression_count || 0) ||
    (a.updated_at || 0) - (b.updated_at || 0),
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function t(key, fallback) {
  if (!bridge || typeof bridge.t !== "function") {
    return fallback;
  }
  try {
    return bridge.t(`views.dashboard.${key}`, fallback);
  } catch {
    return fallback;
  }
}

/** 简单占位符替换：tFormat("compression_badge", "压缩 %s 次", 3) */
function tFormat(key, fallback, ...args) {
  let text = t(key, fallback);
  for (const arg of args) {
    text = text.replace("%s", String(arg));
  }
  return text;
}

/** bridge 可能把业务数据包在 {status:"ok", data:...} 中，这里统一拆开。 */
function normalize(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    payload.status === "ok" &&
    "data" in payload
  ) {
    return payload.data;
  }
  return payload;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null && text !== "") {
    node.textContent = String(text);
  }
  return node;
}

function fmtNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1)}M`;
  }
  if (number >= 10_000) {
    return `${Math.round(number / 1000)}k`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(1)}k`;
  }
  return String(Math.round(number));
}

function fmtPercent(ratio) {
  const number = Number(ratio);
  if (!Number.isFinite(number)) {
    return "—";
  }
  return `${(number * 100).toFixed(1)}%`;
}

function fmtTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const pad = (input) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message || "";
  els.status.classList.toggle("is-error", Boolean(isError && message));
}

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

function applyTheme() {
  let theme = state.themeMode;
  if (theme === "auto") {
    let isDark = false;
    try {
      isDark = Boolean(bridge?.getContext?.()?.isDark);
    } catch {
      isDark = false;
    }
    theme = isDark ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
}

function renderThemeLabel() {
  const [key, fallback] = THEME_LABELS[state.themeMode] || THEME_LABELS.auto;
  els.theme.textContent = t(key, fallback);
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderLabels() {
  const title = t("heading", "上下文看板");
  document.title = title;
  els.heading.textContent = title;
  els.subtitle.textContent = t("subtitle", "每个对话的上下文用量与压缩次数");
  els.search.placeholder = t(
    "search_placeholder",
    "搜索对话、标题、会话或 ID…",
  );
  els.search.setAttribute(
    "aria-label",
    t("search_placeholder", "搜索对话"),
  );
  els.sort.setAttribute("aria-label", t("sort_label", "排序方式"));
  els.direction.textContent = state.direction === "asc" ? "↑" : "↓";
  const directionLabel = t(
    state.direction === "asc" ? "sort_asc" : "sort_desc",
    state.direction === "asc" ? "升序" : "降序",
  );
  els.direction.title = directionLabel;
  els.direction.setAttribute(
    "aria-label",
    `${t("sort_direction_label", "排序方向")}：${directionLabel}`,
  );
  els.refresh.textContent = t("refresh", "刷新");
  els.refresh.disabled = state.loading;
  els.refresh.classList.toggle("is-loading", state.loading);
  renderSortOptions();
  renderBotFilter();
  renderThemeLabel();
}

function botLabel(bot) {
  if (!bot || !bot.platform_id) {
    return t("bot_unknown", "未知机器人");
  }
  if (bot.name && bot.name !== bot.platform_id) {
    return `${bot.name} (${bot.platform_id})`;
  }
  return bot.platform_id;
}

function botButton(value, label, count, active) {
  const button = h("button", `bot-filter${active ? " is-active" : ""}`);
  button.type = "button";
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.append(document.createTextNode(label));
  button.append(h("span", "bot-count", String(count)));
  button.addEventListener("click", () => {
    state.bot = value;
    renderBotFilter();
    renderItems();
  });
  return button;
}

function renderBotFilter() {
  els.bots.replaceChildren();

  if (!state.bots.length) {
    els.bots.hidden = true;
    return;
  }

  els.bots.hidden = false;
  els.bots.setAttribute(
    "aria-label",
    t("bot_filter_label", "按机器人筛选"),
  );

  els.bots.append(
    botButton(
      "all",
      t("bot_all", "全部"),
      state.items.length,
      state.bot === "all",
    ),
  );
  for (const bot of state.bots) {
    els.bots.append(
      botButton(
        bot.platform_id,
        botLabel(bot),
        Number(bot.conversations) || 0,
        state.bot === bot.platform_id,
      ),
    );
  }
}

function renderSortOptions() {
  els.sort.replaceChildren();
  for (const value of SORT_OPTIONS) {
    const [key, fallback] = SORT_LABELS[value];
    const option = document.createElement("option");
    option.value = value;
    option.textContent = t(key, fallback);
    els.sort.append(option);
  }
  els.sort.value = state.sort;
}

function renderStats() {
  const totals = state.totals || {};
  const cards = [
    [t("stat_sessions", "会话"), fmtNumber(totals.sessions || 0)],
    [t("stat_conversations", "对话"), fmtNumber(totals.conversations || 0)],
    [t("stat_messages", "消息"), fmtNumber(totals.messages || 0)],
    [t("stat_tokens", "估算 tokens"), fmtNumber(totals.tokens || 0)],
    [
      t("stat_compression", "压缩记录"),
      fmtNumber(totals.compression_count || 0),
    ],
  ];

  els.stats.replaceChildren();
  for (const [label, value] of cards) {
    const card = h("div", "stat");
    card.append(h("span", "stat-value", value));
    card.append(h("span", "stat-label", label));
    els.stats.append(card);
  }
}

function visibleItems() {
  const query = state.query.trim().toLowerCase();
  const base =
    state.bot === "all"
      ? state.items
      : state.items.filter((item) => item.platform_id === state.bot);
  const matched = query
    ? base.filter((item) => {
        const haystack = [
          item.title,
          item.cid,
          item.session_id,
          item.session_raw,
          item.platform_id,
          item.umo,
          item.message_type,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : base.slice();

  const sorter = SORTERS[state.sort] || SORTERS.tokens;
  const sorted = matched.sort(sorter);
  return state.direction === "desc" ? sorted.reverse() : sorted;
}

function renderItems() {
  els.list.replaceChildren();
  const items = visibleItems();

  if (!items.length) {
    const empty = h("div", "empty");
    empty.append(
      h(
        "p",
        null,
        state.items.length
          ? t("no_match", "没有匹配的对话")
          : t("empty", "暂无对话记录"),
      ),
    );
    empty.append(
      h(
        "p",
        "hint",
        state.items.length
          ? t("no_match_hint", "换个关键词试试。")
          : t("empty_hint", "AstrBot 产生对话后，这里会显示各对话的上下文用量。"),
      ),
    );
    els.list.append(empty);
    return;
  }

  items.forEach((item, index) => {
    const node = renderItem(item);
    // 列表项错峰入场，最多延迟 12 项
    node.style.animationDelay = `${Math.min(index, 12) * 24}ms`;
    els.list.append(node);
  });
}

function renderItem(item) {
  const article = h("article", "session");
  const expanded = state.expanded.has(item.key);

  const head = h("div", "session-head");
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", expanded ? "true" : "false");

  const main = h("div", "session-main");
  const displayLabel = item.display_name
    ? `${item.display_name}(${item.session_id})`
    : "";
  const titleRow = h("div", "session-title-row");
  titleRow.append(
    h(
      "span",
      "session-title",
      item.title && item.title !== item.session_id
        ? item.title
        : displayLabel ||
            item.title ||
            item.cid ||
            t("untitled_conversation", "未命名对话"),
    ),
  );

  const compressionCount = Number(item.compression_count) || 0;
  if (compressionCount > 0) {
    titleRow.append(
      h(
        "span",
        "badge badge-warn",
        tFormat("compression_badge", "压缩 %s 次", compressionCount),
      ),
    );
  } else {
    titleRow.append(h("span", "badge", t("no_compression", "无压缩记录")));
  }
  main.append(titleRow);

  const metaBits = [
    item.platform_id || t("unknown_platform", "未知平台"),
    item.message_type,
    displayLabel || item.session_id,
  ].filter(Boolean);
  if (item.cid) {
    metaBits.push(`cid ${String(item.cid).slice(0, 8)}`);
  }
  main.append(h("div", "session-meta", metaBits.join(" · ")));

  const userStat = item.role_stats?.user || { messages: 0, chars: 0 };
  const assistantStat = item.role_stats?.assistant || {
    messages: 0,
    chars: 0,
  };
  const stats = h("div", "session-stats");
  stats.append(
    h(
      "span",
      null,
      `${t("stat_messages", "消息")} ${fmtNumber(item.messages)}`,
    ),
    h(
      "span",
      null,
      tFormat(
        "role_stat_user",
        "用户 %s 条 · %s 字",
        fmtNumber(userStat.messages),
        fmtNumber(userStat.chars),
      ),
    ),
    h(
      "span",
      null,
      tFormat(
        "role_stat_assistant",
        "助手 %s 条 · %s 字",
        fmtNumber(assistantStat.messages),
        fmtNumber(assistantStat.chars),
      ),
    ),
  );
  main.append(stats);

  const usage = h("div", "usage");
  if (Number.isFinite(Number(item.usage_ratio)) && item.context_window) {
    const ratio = Math.max(0, Math.min(1, Number(item.usage_ratio)));
    const bar = h("div", "bar");
    const fill = h("span");
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    if (ratio >= COMPRESSION_THRESHOLD) {
      fill.className = "is-danger";
    } else if (ratio >= 0.5) {
      fill.className = "is-warn";
    }
    const threshold = h("i", "bar-threshold");
    threshold.title = t(
      "compression_threshold_hint",
      "约 82% 触发上下文压缩（AstrBot 默认行为）",
    );
    bar.append(fill);
    bar.append(threshold);
    usage.append(bar);
    usage.append(
      h(
        "span",
        "usage-text",
        `${fmtPercent(ratio)} / ${fmtNumber(item.context_window)}`,
      ),
    );
  } else {
    usage.append(h("span", "usage-text", t("window_unknown", "窗口未知")));
  }
  main.append(usage);
  head.append(main);

  const metric = h("div", "session-metric");
  metric.append(h("span", "metric-value", fmtNumber(item.tokens)));
  metric.append(h("span", "metric-label", t("est_tokens", "估算 tokens")));
  head.append(metric);

  const side = h("div", "session-side");
  side.append(h("time", "session-time", fmtTime(item.updated_at)));
  side.append(h("span", "chevron", "›"));
  head.append(side);

  const body = h("div", "session-body");
  body.hidden = true;

  head.addEventListener("click", () => {
    toggleItem(item, article, body, head);
  });
  head.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      head.click();
    }
  });

  article.append(head);
  article.append(body);

  if (expanded) {
    article.classList.add("open");
    body.hidden = false;
    loadDetail(item, body);
  }

  return article;
}

// ---------------------------------------------------------------------------
// 上下文详情
// ---------------------------------------------------------------------------

function fmtBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return "—";
  }
  if (number >= 1024 * 1024) {
    return `${(number / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (number >= 1024) {
    return `${(number / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(number)} B`;
}

function toggleItem(item, article, body, head) {
  const key = item.key;
  stopBodyAnimations(body);

  if (state.expanded.has(key)) {
    state.expanded.delete(key);
    head.setAttribute("aria-expanded", "false");
    article.classList.remove("open");
    collapseBody(body);
    return;
  }

  state.expanded.add(key);
  head.setAttribute("aria-expanded", "true");
  article.classList.add("open");
  expandBody(body);
  loadDetail(item, body);
}

function stopBodyAnimations(body) {
  if (typeof body.getAnimations === "function") {
    body.getAnimations().forEach((animation) => animation.cancel());
  }
  body.style.overflow = "";
  body.style.height = "";
}

function expandBody(body) {
  body.hidden = false;
  if (typeof body.animate !== "function") {
    return;
  }
  body.animate(
    [
      { opacity: 0, transform: "translateY(-6px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

function collapseBody(body) {
  const height = body.getBoundingClientRect().height;
  if (typeof body.animate !== "function") {
    body.hidden = true;
    return;
  }
  body.style.overflow = "hidden";
  const animation = body.animate(
    [
      { height: `${height}px`, opacity: 1, transform: "none" },
      { height: "0px", opacity: 0, transform: "translateY(-4px)" },
    ],
    { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
  animation.onfinish = () => {
    body.hidden = true;
    body.style.overflow = "";
    body.style.height = "";
  };
}

async function loadDetail(item, container) {
  const key = item.key;

  if (state.details.has(key)) {
    renderDetail(container, state.details.get(key));
    return;
  }

  container.replaceChildren(
    h("p", "hint", t("detail_loading", "正在读取上下文详情…")),
  );

  try {
    const payload = normalize(
      await bridge.apiGet("conversation", {
        platform: item.platform_id || "",
        session: item.session_raw || "",
        cid: item.cid || "",
      }),
    );
    state.details.set(key, payload);
    renderDetail(container, payload);
  } catch (error) {
    const message = error?.message || String(error);
    container.replaceChildren(
      h("p", "hint hint-error", `${t("error", "读取失败")}: ${message}`),
    );
  }
}

function renderDetail(container, payload) {
  const conversation = payload?.conversation;
  container.replaceChildren();

  if (!conversation) {
    container.append(h("p", "hint", t("detail_empty", "没有可展示的详情")));
    return;
  }

  const userStat = conversation.role_stats?.user || { messages: 0, chars: 0 };
  const assistantStat = conversation.role_stats?.assistant || {
    messages: 0,
    chars: 0,
  };

  const grid = h("div", "detail-grid");
  const appendCell = (label, value) => {
    const cell = h("div", "detail-cell");
    cell.append(h("span", "detail-label", label));
    cell.append(h("span", "detail-value", value));
    grid.append(cell);
  };

  appendCell(t("stat_messages", "消息"), fmtNumber(conversation.messages));
  appendCell(t("est_tokens", "估算 tokens"), fmtNumber(conversation.tokens));
  appendCell(t("detail_chars", "字符"), fmtNumber(conversation.chars));
  appendCell(
    t("role_user", "用户"),
    tFormat(
      "role_stat_compact",
      "%s 条 / %s 字",
      fmtNumber(userStat.messages),
      fmtNumber(userStat.chars),
    ),
  );
  appendCell(
    t("role_assistant", "助手"),
    tFormat(
      "role_stat_compact",
      "%s 条 / %s 字",
      fmtNumber(assistantStat.messages),
      fmtNumber(assistantStat.chars),
    ),
  );
  appendCell(
    t("detail_window", "上下文窗口"),
    conversation.context_window
      ? fmtNumber(conversation.context_window)
      : t("window_unknown", "窗口未知"),
  );
  appendCell(
    t("detail_usage", "占用率"),
    conversation.usage_ratio != null
      ? fmtPercent(conversation.usage_ratio)
      : "—",
  );
  appendCell(
    t("detail_remaining", "剩余 tokens"),
    conversation.remaining_tokens != null
      ? fmtNumber(conversation.remaining_tokens)
      : "—",
  );
  appendCell(
    t("stat_compression", "压缩记录"),
    fmtNumber(conversation.compression_count),
  );
  appendCell(
    t("detail_session", "会话"),
    conversation.display_name
      ? `${conversation.display_name}(${conversation.session_id})`
      : conversation.session_id || "—",
  );
  appendCell(
    t("detail_model", "模型提供商"),
    conversation.provider_id || "—",
  );
  appendCell(
    t("detail_history_size", "历史大小"),
    fmtBytes(conversation.history_bytes),
  );
  appendCell(t("detail_created", "创建时间"), fmtTime(conversation.created_at));
  appendCell(t("detail_updated", "更新时间"), fmtTime(conversation.updated_at));
  container.append(grid);
}

// ---------------------------------------------------------------------------
// 偏好持久化
// ---------------------------------------------------------------------------

const SORT_VALUES = ["updated", "tokens", "messages", "compression"];
const DIRECTION_VALUES = ["asc", "desc"];

async function loadPreferences() {
  if (!bridge) {
    return;
  }
  try {
    const payload = normalize(await bridge.apiGet("preferences", {}));
    if (payload && typeof payload === "object") {
      if (SORT_VALUES.includes(payload.sort)) {
        state.sort = payload.sort;
      }
      if (DIRECTION_VALUES.includes(payload.direction)) {
        state.direction = payload.direction;
      }
    }
  } catch {
    // 读取失败时使用默认偏好
  }
}

let persistTimer = null;

function persistPreferences() {
  if (!bridge || typeof bridge.apiPost !== "function") {
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      await bridge.apiPost("preferences", {
        sort: state.sort,
        direction: state.direction,
      });
    } catch {
      // 保存失败不影响使用
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function load(options = {}) {
  const silent = Boolean(options.silent);
  const force = Boolean(options.force);

  if (!bridge) {
    setStatus(
      "AstrBotPluginView bridge 未注入，请在 AstrBot WebUI 中打开此页面。",
      true,
    );
    return;
  }
  if (state.fetching) {
    return;
  }
  state.fetching = true;

  if (!silent) {
    state.loading = true;
    renderLabels();
    setStatus(t("loading", "正在读取对话…"));
  }

  try {
    const payload = normalize(
      await bridge.apiGet("sessions", force ? { refresh: 1 } : {}),
    );
    const cached = Boolean(payload?.cached);
    state.items = Array.isArray(payload?.items) ? payload.items : [];
    state.bots = Array.isArray(payload?.bots) ? payload.bots : [];
    state.totals = payload?.totals || null;
    if (!silent) {
      state.expanded.clear();
      state.details.clear();
    }
    if (
      state.bot !== "all" &&
      !state.bots.some((bot) => bot.platform_id === state.bot)
    ) {
      state.bot = "all";
    }
    setupAutoRefresh(payload?.refresh);
    render();
    if (cached) {
      setStatus(t("loading_cached", "已显示缓存，正在后台更新…"));
      setTimeout(() => {
        if (!state.fetching) {
          load({ silent: true, force: true });
        }
      }, 50);
    } else {
      setStatus(
        payload?.truncated
          ? t("truncated", "对话过多，仅展示最近的一部分。")
          : "",
      );
    }
  } catch (error) {
    if (!silent) {
      const message = error?.message || String(error);
      setStatus(`${t("error", "读取失败")}: ${message}`, true);
      state.items = [];
      state.bots = [];
      state.bot = "all";
      state.totals = null;
      render();
    }
  } finally {
    state.fetching = false;
    if (!silent) {
      state.loading = false;
      renderLabels();
    }
  }
}

function setupAutoRefresh(config) {
  const enabled = config?.enabled !== false;
  const intervalMinutes = Math.max(1, Number(config?.interval_minutes) || 15);
  state.autoRefresh = { enabled, intervalMinutes };

  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  if (!enabled) {
    return;
  }

  state.refreshTimer = setInterval(
    () => {
      if (document.visibilityState === "visible" && !state.fetching) {
        load({ silent: true, force: true });
      }
    },
    intervalMinutes * 60 * 1000,
  );
}

function render() {
  renderLabels();
  renderStats();
  renderItems();
}

// ---------------------------------------------------------------------------
// 事件与启动
// ---------------------------------------------------------------------------

function bindEvents() {
  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    renderItems();
  });

  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    renderItems();
    persistPreferences();
  });

  els.direction.addEventListener("click", () => {
    state.direction = state.direction === "desc" ? "asc" : "desc";
    renderLabels();
    renderItems();
    persistPreferences();
  });

  els.refresh.addEventListener("click", () => {
    if (!state.loading) {
      load({ force: true });
    }
  });

  els.theme.addEventListener("click", () => {
    state.themeMode =
      state.themeMode === "auto"
        ? "light"
        : state.themeMode === "light"
          ? "dark"
          : "auto";
    applyTheme();
    renderThemeLabel();
  });
}

async function init() {
  applyTheme();
  renderLabels();
  bindEvents();

  if (!bridge) {
    setStatus(
      "AstrBotPluginView bridge 未注入，请在 AstrBot WebUI 中打开此页面。",
      true,
    );
    return;
  }

  try {
    await bridge.ready();
  } catch (error) {
    setStatus(
      `${t("bridge_error", "初始化失败")}: ${error?.message || error}`,
      true,
    );
    return;
  }

  applyTheme();

  await loadPreferences();
  renderLabels();

  if (typeof bridge.onContext === "function") {
    bridge.onContext(() => {
      applyTheme();
      renderLabels();
    });
  }

  await load();
}

init();
