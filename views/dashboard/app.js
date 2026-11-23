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
  chartRange: "24h", // 6h | 24h | 7d | 30d | all | custom（每次打开默认 24h，不持久化）
  customRange: null, // { start, end } 自定义绝对区间（毫秒）
  customPanelOpen: false,
  pinned: new Set(), // item.key -> 是否置顶
  moreExpanded: new Set(), // item.key -> 已展开更多详情
  loading: false,
  fetching: false,
  expanded: new Set(),
  details: new Map(), // item.key -> conversation payload
  ui: {
    charts: { usage: true, growth: true },
    compression_marker: { enabled: true, percent: 82 },
    theme_color: "#22c55e",
  },
  autoRefresh: { enabled: true, intervalMinutes: 60 },
  refreshTimer: null,
};

const SORT_OPTIONS = ["updated", "tokens", "messages", "compression"];

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

// 图表时间范围：以当前时间为基准向前截取；custom 使用自定义起止时间
const CHART_RANGES = [
  { value: "6h", seconds: 6 * 3600, label: ["chart_range_6h", "近 6 小时"] },
  { value: "24h", seconds: 24 * 3600, label: ["chart_range_24h", "近 24 小时"] },
  { value: "7d", seconds: 7 * 24 * 3600, label: ["chart_range_7d", "近 7 天"] },
  { value: "30d", seconds: 30 * 24 * 3600, label: ["chart_range_30d", "近 30 天"] },
  { value: "all", seconds: 0, label: ["chart_range_all", "全部"] },
];
let chartClipSeq = 0; // 变化量曲线正负裁剪的唯一 ID

function chartRangeConfig(value) {
  return (
    CHART_RANGES.find((range) => range.value === value) ||
    CHART_RANGES[CHART_RANGES.length - 1]
  );
}

function filterPointsByWindow(points, range) {
  if (range.start == null && range.end == null) {
    return points;
  }
  return points.filter(
    (point) =>
      (range.start == null || point.ts >= range.start) &&
      (range.end == null || point.ts <= range.end),
  );
}

function activeRangeWindow(allPoints, now = Date.now()) {
  if (state.chartRange === "custom" && state.customRange) {
    return { start: state.customRange.start, end: state.customRange.end };
  }
  const range = chartRangeConfig(state.chartRange);
  if (!range.seconds) {
    return { start: null, end: null };
  }
  return { start: now - range.seconds * 1000, end: now };
}

function focusRangeButton(container, value) {
  const button = container.querySelector(
    `.range-button[data-range="${value}"]`,
  );
  if (button) {
    button.focus();
  }
}

/** 图表主体切换动画：仅用于时间范围切换；展开时由曲线自身生长（用量自底部、变化量自左侧）。 */
function animateChartBody(node, entrance = false) {
  if (!node || entrance || typeof node.animate !== "function") {
    return;
  }
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    return;
  }
  node.getAnimations().forEach((animation) => animation.cancel());
  node.animate(
    [
      { opacity: 0.3, transform: "translateY(5px) scale(0.996)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

/** 展开时让曲线从图表底部向上揭开。 */
function animateCurveReveal(rect, top, bottom, duration = 480) {
  if (!rect) {
    return;
  }
  const total = Math.max(0, bottom - top);
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof requestAnimationFrame !== "function") {
    rect.setAttribute("y", top);
    rect.setAttribute("height", total);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const height = total * eased;
    rect.setAttribute("y", bottom - height);
    rect.setAttribute("height", height);
    if (progress < 1 && rect.isConnected) {
      requestAnimationFrame(tick);
    }
  };
  rect.setAttribute("y", bottom);
  rect.setAttribute("height", 0);
  setTimeout(() => {
    if (rect.isConnected) {
      rect.setAttribute("y", top);
      rect.setAttribute("height", total);
    }
  }, duration + 80);
  requestAnimationFrame(tick);
}

/** 变化量曲线的展开动画：从左向右延伸。 */
function animateCurveRevealHorizontal(rect, left, right, duration = 480) {
  if (!rect) {
    return;
  }
  const total = Math.max(0, right - left);
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof requestAnimationFrame !== "function") {
    rect.setAttribute("x", left);
    rect.setAttribute("width", total);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    rect.setAttribute("x", left);
    rect.setAttribute("width", total * eased);
    if (progress < 1 && rect.isConnected) {
      requestAnimationFrame(tick);
    }
  };
  rect.setAttribute("x", left);
  rect.setAttribute("width", 0);
  setTimeout(() => {
    if (rect.isConnected) {
      rect.setAttribute("x", left);
      rect.setAttribute("width", total);
    }
  }, duration + 80);
  requestAnimationFrame(tick);
}

function toDatetimeLocal(ms) {
  const date = new Date(ms);
  const pad = (input) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDatetimeLocal(value) {
  if (!value) {
    return null;
  }
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** 输入框精确到分钟；结束时间包含整分钟。 */
function normalizeRangeWindow(start, end) {
  return {
    start: Math.floor(start / 60000) * 60000,
    end: Math.floor(end / 60000) * 60000 + 59999,
  };
}

function defaultCustomWindow(allPoints) {
  if (state.customRange) {
    return state.customRange;
  }
  const now = Date.now();
  const range = chartRangeConfig(state.chartRange);
  if (range.seconds) {
    return normalizeRangeWindow(now - range.seconds * 1000, now);
  }
  if (allPoints.length) {
    return normalizeRangeWindow(
      allPoints[0].ts,
      allPoints[allPoints.length - 1].ts,
    );
  }
  return normalizeRangeWindow(now - 24 * 3600 * 1000, now);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function fileStamp(ms) {
  const date = new Date(ms);
  const pad = (input) => String(input).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function safeFileName(value) {
  const text = String(value || "conversation").trim();
  return text.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "conversation";
}

function exportSamplesCsv(conversation, allPoints) {
  const rangeWindow = activeRangeWindow(allPoints);
  const points = filterPointsByWindow(allPoints, rangeWindow);
  if (!points.length) {
    setStatus(
      t("export_empty", "当前时间范围内没有可导出的数据。"),
      true,
    );
    return;
  }

  const indexByTs = new Map(allPoints.map((point, index) => [point.ts, index]));
  const rows = [
    [
      t("csv_time", "时间（本地）"),
      t("csv_tokens", "估算 tokens"),
      t("csv_window", "上下文窗口"),
      t("csv_usage", "占用率(%)"),
      t("csv_delta", "变化量 tokens"),
    ],
  ];

  for (const point of points) {
    const index = indexByTs.get(point.ts) ?? 0;
    const previous = index > 0 ? allPoints[index - 1] : null;
    const usage =
      point.window > 0
        ? ((point.tokens / point.window) * 100).toFixed(2)
        : "";
    rows.push([
      fmtTime(point.ts / 1000),
      point.tokens,
      point.window || "",
      usage,
      previous ? point.tokens - previous.tokens : "",
    ]);
  }

  const csv = rows
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\r\n");
  const title =
    conversation?.title ||
    conversation?.display_name ||
    conversation?.session_id ||
    conversation?.cid ||
    "conversation";
  const rangeTag = rangeWindow.start
    ? `${fileStamp(rangeWindow.start)}-${fileStamp(rangeWindow.end)}`
    : "all";
  const filename = `context-${safeFileName(title)}-${rangeTag}.csv`;

  try {
    const blob = new Blob(["\ufeff", csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(
      tFormat("export_done", "已导出 %s 条采样（CSV）。", points.length),
    );
  } catch {
    setStatus(
      t("export_failed", "导出失败，请检查浏览器下载权限。"),
      true,
    );
  }
}

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

/** 图表 X 轴用短时间：6 小时内只显示时分，否则带月日。 */
function fmtAxisTime(ms, spanMs) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const pad = (input) => String(input).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (spanMs <= 6 * 3600 * 1000) {
    return time;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message || "";
  els.status.classList.toggle("is-error", Boolean(isError && message));
}

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

function applyTheme() {
  let isDark = false;
  try {
    isDark = Boolean(bridge?.getContext?.()?.isDark);
  } catch {
    isDark = false;
  }
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  applyThemeColor();
}

function hexToRgba(hex, alpha) {
  let value = String(hex || "")
    .replace("#", "")
    .trim();
  if (value.length === 3) {
    value = value
      .split("")
      .map((char) => char + char)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    return "";
  }
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function applyThemeColor() {
  const color = state.ui?.theme_color || "#22c55e";
  const root = document.documentElement;
  root.style.setProperty("--accent", color);
  const isDark = root.dataset.theme === "dark";
  const soft = hexToRgba(color, isDark ? 0.18 : 0.12);
  if (soft) {
    root.style.setProperty("--accent-soft", soft);
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderLabels() {
  const title = t("heading", "上下文看板");
  document.title = title;
  els.heading.textContent = title;
  els.subtitle.textContent = t(
    "subtitle",
    "按对话查看上下文占用、用量曲线与压缩情况",
  );
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
  const ordered = state.direction === "desc" ? sorted.reverse() : sorted;
  if (!state.pinned.size) {
    return ordered;
  }
  const pinned = [];
  const rest = [];
  for (const item of ordered) {
    if (state.pinned.has(item.key)) {
      pinned.push(item);
    } else {
      rest.push(item);
    }
  }
  return pinned.concat(rest);
}

function togglePin(item) {
  if (state.pinned.has(item.key)) {
    state.pinned.delete(item.key);
  } else {
    state.pinned.add(item.key);
  }
  persistPreferences();
  renderItems();
  const button = Array.from(els.list.querySelectorAll(".pin-button")).find(
    (node) => node.dataset.pinKey === item.key,
  );
  if (button) {
    button.focus();
  }
}

function pinIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "pin-icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    "M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z",
  );
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

function pinButton(item) {
  const pinned = state.pinned.has(item.key);
  const label = pinned
    ? t("unpin_action", "取消置顶")
    : t("pin_action", "置顶");
  const button = h("button", "pin-button");
  button.append(pinIcon());
  button.type = "button";
  button.dataset.pinKey = item.key;
  button.setAttribute("aria-pressed", pinned ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePin(item);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
    }
  });
  return button;
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
  article.classList.toggle("is-pinned", state.pinned.has(item.key));

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
  titleRow.append(pinButton(item));
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
    const marker = state.ui?.compression_marker || {
      enabled: true,
      percent: 82,
    };
    const thresholdPercent = Math.max(
      1,
      Math.min(100, Number(marker.percent) || 82),
    );
    if (ratio >= thresholdPercent / 100) {
      fill.className = "is-danger";
    } else if (ratio >= 0.5) {
      fill.className = "is-warn";
    }
    bar.append(fill);
    if (marker.enabled !== false) {
      const threshold = h("i", "bar-threshold");
      threshold.style.left = `${thresholdPercent}%`;
      threshold.title = tFormat(
        "compression_threshold_hint",
        "约 %s% 触发上下文压缩（AstrBot 默认行为）",
        thresholdPercent,
      );
      bar.append(threshold);
    }
    usage.append(bar);
    usage.append(h("span", "usage-percent", fmtPercent(ratio)));
    usage.append(
      h(
        "span",
        "usage-detail",
        `${fmtNumber(item.tokens)} / ${fmtNumber(item.context_window)}`,
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
  loadDetail(item, body, { entrance: true });
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
  const rect = body.getBoundingClientRect();
  if (typeof body.animate !== "function") {
    body.hidden = true;
    return;
  }
  const computed = getComputedStyle(body);
  body.style.overflow = "hidden";
  const animation = body.animate(
    [
      {
        height: `${rect.height}px`,
        paddingTop: computed.paddingTop,
        paddingBottom: computed.paddingBottom,
        borderTopWidth: computed.borderTopWidth,
        opacity: 1,
        transform: "none",
      },
      {
        height: "0px",
        paddingTop: "0px",
        paddingBottom: "0px",
        borderTopWidth: "0px",
        opacity: 0,
        transform: "translateY(-4px)",
      },
    ],
    { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
  animation.onfinish = () => {
    body.hidden = true;
    body.style.overflow = "";
    body.style.height = "";
  };
}

async function loadDetail(item, container, options = {}) {
  const key = item.key;

  if (state.details.has(key)) {
    renderDetail(container, state.details.get(key), key, options);
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
    renderDetail(container, payload, key, options);
  } catch (error) {
    const message = error?.message || String(error);
    container.replaceChildren(
      h("p", "hint hint-error", `${t("error", "读取失败")}: ${message}`),
    );
  }
}

function renderDetail(container, payload, key, options = {}) {
  const conversation = payload?.conversation;
  container.replaceChildren();

  if (!conversation) {
    container.append(h("p", "hint", t("detail_empty", "没有可展示的详情")));
    return;
  }

  const chartSection = h("div", "chart-section");
  container.append(chartSection);
  renderCharts(chartSection, conversation, payload?.samples, state.ui, {
    entrance: options.entrance === true,
  });

  const expanded = state.moreExpanded.has(key);
  const more = h("section", "detail-more");
  const toggle = h(
    "button",
    `detail-more-toggle${expanded ? " is-open" : ""}`,
  );
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.title = t("detail_more_hint", "查看上下文概览与上下文策略");

  const label = h(
    "span",
    "detail-more-label",
    expanded
      ? t("detail_more_collapse", "收起更多详情")
      : t("detail_more_expand", "展开更多详情"),
  );
  const chevron = h("span", "detail-more-chevron", "›");
  chevron.setAttribute("aria-hidden", "true");
  toggle.append(label, chevron);

  const body = h("div", "detail-more-body");
  body.hidden = !expanded;
  let rendered = false;
  const renderBody = () => {
    if (rendered) {
      return;
    }
    rendered = true;
    renderSummaryTable(body, conversation);
    renderPolicy(body, conversation.policy);
  };
  if (expanded) {
    renderBody();
  }

  toggle.addEventListener("click", () => {
    const next = !state.moreExpanded.has(key);
    if (next) {
      state.moreExpanded.add(key);
      renderBody();
    } else {
      state.moreExpanded.delete(key);
    }
    body.hidden = !next;
    toggle.classList.toggle("is-open", next);
    toggle.setAttribute("aria-expanded", next ? "true" : "false");
    label.textContent = next
      ? t("detail_more_collapse", "收起更多详情")
      : t("detail_more_expand", "展开更多详情");
  });

  more.append(toggle, body);
  container.append(more);
}

// ---------------------------------------------------------------------------
// 详情表格
// ---------------------------------------------------------------------------

function markerPercent() {
  const marker = state.ui?.compression_marker || { enabled: true, percent: 82 };
  return Math.max(1, Math.min(100, Number(marker.percent) || 82));
}

async function copyText(value) {
  const text = String(value ?? "");
  if (!text) {
    return false;
  }
  try {
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限受限时回退到 execCommand
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied =
      typeof document.execCommand === "function" && document.execCommand("copy");
    area.remove();
    return Boolean(copied);
  } catch {
    return false;
  }
}

function copyButton(
  getValue,
  label = t("detail_copy", "复制"),
  extraClass,
) {
  const button = h(
    "button",
    `copy-button${extraClass ? ` ${extraClass}` : ""}`,
    label,
  );
  button.type = "button";
  button.setAttribute("aria-label", label);
  const initial = String(getValue() ?? "");
  button.disabled = !initial;
  if (!initial) {
    button.title = t("detail_copy_empty", "没有可复制的内容");
  }

  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const text = String(getValue() ?? "");
    if (!text) {
      return;
    }
    const copied = await copyText(text);
    button.textContent = copied
      ? t("detail_copied", "已复制")
      : t("detail_copy_failed", "复制失败");
    button.classList.toggle("is-copied", copied);
    button.classList.toggle("is-error", !copied);
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      button.textContent = label;
      button.classList.remove("is-copied", "is-error");
    }, 1400);
  });

  return button;
}

function buildDataTable(options) {
  const table = h(
    "table",
    `data-table${options.className ? ` ${options.className}` : ""}`,
  );

  const head = h("thead");
  const headRow = h("tr");
  options.columns.forEach((column, index) => {
    const cell = h(
      "th",
      index === options.columns.length - 1 ? "cell-actions" : null,
      column,
    );
    cell.scope = "col";
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  const body = h("tbody");
  for (const row of options.rows) {
    if (row.section) {
      const tr = h("tr", "table-section");
      const cell = h("th", null, row.section);
      cell.colSpan = options.columns.length;
      cell.scope = "colgroup";
      tr.append(cell);
      body.append(tr);
      continue;
    }

    const tr = h("tr");
    const labelCell = h("th", `cell-label${row.mono ? " is-mono" : ""}`);
    labelCell.scope = "row";
    labelCell.append(document.createTextNode(row.label));
    if (row.hint) {
      labelCell.title = row.hint;
    }
    tr.append(labelCell);

    const valueCell = h("td", "cell-value");
    if (row.node) {
      valueCell.append(row.node);
    } else {
      valueCell.textContent = row.value ?? "—";
    }
    tr.append(valueCell);

    const actionCell = h("td", "cell-actions");
    actionCell.append(copyButton(() => row.copy ?? row.value ?? ""));
    tr.append(actionCell);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function renderTableBlock(container, options) {
  const block = h("section", "detail-table-block");
  const toolbar = h("div", "table-toolbar");
  toolbar.append(h("div", "detail-subtitle", options.title));

  if (options.copyAll) {
    const actions = h("div", "table-actions");
    actions.append(
      copyButton(options.copyAll, t("detail_copy_all", "复制全部"), "is-ghost"),
    );
    toolbar.append(actions);
  }
  block.append(toolbar);

  const scroll = h("div", "table-scroll");
  scroll.append(buildDataTable(options));
  block.append(scroll);
  container.append(block);
  return block;
}

function usageTone(ratio) {
  if (ratio >= markerPercent() / 100) {
    return "danger";
  }
  if (ratio >= 0.5) {
    return "warn";
  }
  return "";
}

function metricUsageNode(ratio) {
  const wrap = h("div", "metric-usage");
  const bar = h("div", "bar");
  const fill = h("span");
  fill.style.width = `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
  const tone = usageTone(ratio);
  if (tone) {
    fill.className = `is-${tone}`;
  }
  bar.append(fill);

  const marker = state.ui?.compression_marker || { enabled: true, percent: 82 };
  if (marker.enabled !== false) {
    const thresholdPercent = markerPercent();
    const threshold = h("i", "bar-threshold");
    threshold.style.left = `${thresholdPercent}%`;
    threshold.title = tFormat(
      "compression_threshold_hint",
      "约 %s% 触发上下文压缩（AstrBot 默认行为）",
      thresholdPercent,
    );
    bar.append(threshold);
  }

  const percent = h(
    "span",
    `metric-usage-percent${tone ? ` is-${tone}` : ""}`,
    fmtPercent(ratio),
  );
  wrap.append(bar, percent);
  return wrap;
}

function summaryRows(conversation) {
  const userStat = conversation.role_stats?.user || { messages: 0, chars: 0 };
  const assistantStat = conversation.role_stats?.assistant || {
    messages: 0,
    chars: 0,
  };
  const rawRatio = Number(conversation.usage_ratio);
  const ratio =
    conversation.usage_ratio != null && Number.isFinite(rawRatio)
      ? Math.max(0, Math.min(1, rawRatio))
      : null;
  const window = Number(conversation.context_window) || 0;
  const threshold = markerPercent();

  return [
    { section: t("detail_section_usage", "用量与容量") },
    {
      label: t("est_tokens", "估算 tokens"),
      hint: t(
        "detail_hint_tokens",
        "按历史字符估算的上下文 token 数，用于了解大致用量，不等同于模型计费。",
      ),
      value: fmtNumber(conversation.tokens),
      copy: conversation.tokens ?? "",
    },
    {
      label: t("detail_window", "上下文窗口"),
      hint: t(
        "detail_hint_window",
        "当前模型配置的上下文窗口大小；未读取到时显示「窗口未知」。",
      ),
      value: window ? fmtNumber(window) : t("window_unknown", "窗口未知"),
      copy: window || "",
    },
    {
      label: t("detail_usage", "占用率"),
      hint: tFormat(
        "detail_hint_usage",
        "已用 tokens ÷ 上下文窗口；达到约 %s% 时 AstrBot 会触发压缩。",
        threshold,
      ),
      node: ratio != null ? metricUsageNode(ratio) : null,
      value: ratio != null ? fmtPercent(ratio) : "—",
      copy: ratio != null ? fmtPercent(ratio) : "",
    },
    {
      label: t("detail_remaining", "剩余 tokens"),
      hint: t(
        "detail_hint_remaining",
        "上下文窗口减去已用 tokens 后，还能容纳的估算 token 数。",
      ),
      value:
        conversation.remaining_tokens != null
          ? fmtNumber(conversation.remaining_tokens)
          : "—",
      copy: conversation.remaining_tokens ?? "",
    },
    {
      label: t("stat_compression", "压缩记录"),
      hint: t(
        "detail_hint_compression",
        "从历史记录中检测到的上下文压缩次数，用于判断压缩是否频繁。",
      ),
      value: fmtNumber(conversation.compression_count),
      copy: conversation.compression_count ?? "",
    },
    { section: t("detail_section_messages", "消息构成") },
    {
      label: t("stat_messages", "消息"),
      hint: t("detail_hint_messages", "当前历史包含的消息总条数。"),
      value: fmtNumber(conversation.messages),
      copy: conversation.messages ?? "",
    },
    {
      label: t("role_user", "用户"),
      hint: t("detail_hint_role_user", "用户消息的条数与字符数。"),
      value: tFormat(
        "role_stat_compact",
        "%s 条 / %s 字",
        fmtNumber(userStat.messages),
        fmtNumber(userStat.chars),
      ),
      copy: tFormat(
        "role_stat_compact",
        "%s 条 / %s 字",
        fmtNumber(userStat.messages),
        fmtNumber(userStat.chars),
      ),
    },
    {
      label: t("role_assistant", "助手"),
      hint: t("detail_hint_role_assistant", "助手消息的条数与字符数。"),
      value: tFormat(
        "role_stat_compact",
        "%s 条 / %s 字",
        fmtNumber(assistantStat.messages),
        fmtNumber(assistantStat.chars),
      ),
      copy: tFormat(
        "role_stat_compact",
        "%s 条 / %s 字",
        fmtNumber(assistantStat.messages),
        fmtNumber(assistantStat.chars),
      ),
    },
    {
      label: t("detail_chars", "字符"),
      hint: t(
        "detail_hint_chars",
        "历史消息的总字符数，包含用户与助手消息。",
      ),
      value: fmtNumber(conversation.chars),
      copy: conversation.chars ?? "",
    },
    { section: t("detail_section_session", "会话信息") },
    {
      label: t("detail_session", "会话"),
      hint: t("detail_hint_session", "会话名称（会话 ID）。"),
      value: conversation.display_name
        ? `${conversation.display_name}(${conversation.session_id})`
        : conversation.session_id || "—",
      copy: conversation.session_id || "",
    },
    {
      label: t("detail_model", "模型提供商"),
      hint: t("detail_hint_model", "当前会话使用的模型提供商 ID。"),
      value: conversation.provider_id || "—",
      copy: conversation.provider_id || "",
    },
    {
      label: t("detail_history_size", "历史大小"),
      hint: t(
        "detail_hint_history_size",
        "历史字符串按 UTF-8 计算的大小，反映原始存储占用。",
      ),
      value: fmtBytes(conversation.history_bytes),
      copy: conversation.history_bytes ?? "",
    },
    {
      label: t("detail_created", "创建时间"),
      hint: t("detail_hint_created", "会话首次创建的时间。"),
      value: fmtTime(conversation.created_at),
      copy: fmtTime(conversation.created_at),
    },
    {
      label: t("detail_updated", "更新时间"),
      hint: t("detail_hint_updated", "会话最后一次更新的时间。"),
      value: fmtTime(conversation.updated_at),
      copy: fmtTime(conversation.updated_at),
    },
  ];
}

function renderSummaryTable(container, conversation) {
  const rows = summaryRows(conversation);
  renderTableBlock(container, {
    title: t("detail_overview", "上下文概览"),
    columns: [
      t("detail_col_metric", "指标"),
      t("detail_col_value", "数值"),
      t("detail_col_action", "操作"),
    ],
    rows,
    copyAll: () =>
      rows
        .filter((row) => row.label && !row.section)
        .map(
          (row) =>
            `${row.label}: ${row.copy !== "" ? row.copy : row.value ?? "—"}`,
        )
        .join("\n"),
  });
}

const POLICY_LABELS = {
  max_context_length: ["policy_max_context_length", "压缩前最多保留轮数"],
  dequeue_context_length: ["policy_dequeue_context_length", "轮次超限丢弃轮数"],
  context_window_fallback: ["policy_window_fallback", "窗口兜底值"],
  context_compression_keep_ratio: ["policy_keep_ratio", "压缩保留比例"],
  compression_keep_ratio: ["policy_keep_ratio", "压缩保留比例"],
  context_compression_strategy: ["policy_strategy", "压缩方式"],
  compression_strategy: ["policy_strategy", "压缩方式"],
  context_compression_prompt: ["policy_prompt", "压缩提示词"],
  compression_prompt: ["policy_prompt", "压缩提示词"],
  context_compression_provider_id: ["policy_provider", "压缩模型"],
  compression_provider_id: ["policy_provider", "压缩模型"],
};

function formatPolicyValue(key, value) {
  const lower = String(key).toLowerCase();
  if (lower.includes("ratio")) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= 1) {
      return `${(number * 100).toFixed(0)}%`;
    }
  }
  if (lower.includes("fallback")) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return fmtNumber(number);
    }
  }
  return String(value);
}

function policyValueNode(text) {
  const value = String(text ?? "");
  if (value.length <= 120) {
    return null;
  }
  const wrap = h("div", "policy-value-wrap");
  const clamped = h("span", "value-clamp", value);
  const toggle = h("button", "link-button", t("detail_expand", "展开"));
  toggle.type = "button";
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const expanded = clamped.classList.toggle("is-expanded");
    toggle.textContent = expanded
      ? t("detail_collapse", "收起")
      : t("detail_expand", "展开");
  });
  wrap.append(clamped, toggle);
  return wrap;
}

function renderPolicy(container, policy) {
  if (!policy) {
    return;
  }
  const entries = Array.isArray(policy.entries) ? policy.entries : [];
  if (!entries.length) {
    const block = h("section", "detail-table-block");
    block.append(h("div", "detail-subtitle", t("policy_title", "上下文策略")));
    block.append(
      h(
        "p",
        "hint",
        policy.config_found
          ? t("policy_empty", "配置中未找到上下文策略字段。")
          : t(
              "policy_unavailable",
              "未读取到 AstrBot 配置（当前版本可能不支持）。",
            ),
      ),
    );
    container.append(block);
    return;
  }

  const rows = entries.map((entry) => {
    const meta = POLICY_LABELS[entry.key];
    const display = formatPolicyValue(entry.key, entry.value);
    return {
      label: meta ? t(meta[0], meta[1]) : entry.key,
      mono: !meta,
      hint: entry.path || entry.key,
      value: display,
      copy: display,
      node: policyValueNode(display),
    };
  });

  renderTableBlock(container, {
    title: t("policy_title", "上下文策略"),
    columns: [
      t("policy_col_item", "配置项"),
      t("policy_col_value", "当前值"),
      t("policy_col_action", "操作"),
    ],
    rows,
    className: "policy-table",
    copyAll: () => rows.map((row) => `${row.label}: ${row.copy}`).join("\n"),
  });
}

function renderCharts(container, conversation, samples, ui, options = {}) {
  container.replaceChildren();

  const charts = ui?.charts || {};
  const showUsage = charts.usage !== false;
  const showGrowth = charts.growth !== false;
  if (!showUsage && !showGrowth) {
    return;
  }

  const allPoints = (Array.isArray(samples) ? samples : [])
    .filter(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(Number(point[0])) &&
        Number.isFinite(Number(point[1])),
    )
    .map(([ts, tokens, windowValue]) => ({
      ts: Number(ts) * 1000,
      tokens: Number(tokens),
      window: Number(windowValue) || 0,
    }))
    .sort((a, b) => a.ts - b.ts);

  if (!allPoints.length) {
    container.append(
      h(
        "p",
        "hint",
        t(
          "chart_not_enough",
          "暂无采样数据。插件运行并刷新后，这里会显示已采集的曲线。",
        ),
      ),
    );
    return;
  }

  const now = Date.now();
  const rangeWindow = activeRangeWindow(allPoints, now);
  const points = filterPointsByWindow(allPoints, rangeWindow);
  const rerender = () => {
    renderCharts(container, conversation, samples, ui);
  };
  const zoomToRange = (startTs, endTs) => {
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
      return;
    }
    if (endTs - startTs < 60 * 1000) {
      return;
    }
    state.customRange = normalizeRangeWindow(startTs, endTs);
    state.chartRange = "custom";
    state.customPanelOpen = true;
    rerender();
  };

  const toolbar = h("div", "chart-toolbar");
  toolbar.append(
    h("span", "chart-toolbar-title", t("chart_range_label", "时间范围")),
  );

  const switchGroup = h("div", "range-switch");
  switchGroup.setAttribute("role", "group");
  switchGroup.setAttribute("aria-label", t("chart_range_label", "时间范围"));
  for (const option of CHART_RANGES) {
    const [key, fallback] = option.label;
    const active = option.value === state.chartRange;
    const count =
      option.seconds === 0
        ? allPoints.length
        : filterPointsByWindow(allPoints, {
            start: now - option.seconds * 1000,
            end: now,
          }).length;
    const button = h("button", "range-button", t(key, fallback));
    button.type = "button";
    button.dataset.range = option.value;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.title = count
      ? tFormat("chart_sample_count", "%s 个采样", count)
      : t("chart_range_no_data", "该时间范围内没有采样");
    button.addEventListener("click", () => {
      if (state.chartRange === option.value) {
        return;
      }
      state.chartRange = option.value;
      state.customPanelOpen = false;
      rerender();
      focusRangeButton(container, option.value);
    });
    switchGroup.append(button);
  }

  const customActive = state.chartRange === "custom";
  const customButton = h(
    "button",
    "range-button",
    t("chart_range_custom", "自定义"),
  );
  customButton.type = "button";
  customButton.dataset.range = "custom";
  customButton.setAttribute("aria-pressed", customActive ? "true" : "false");
  customButton.title = customActive
    ? tFormat("chart_sample_count", "%s 个采样", points.length)
    : t("chart_range_custom_hint", "选择开始与结束时间");
  customButton.addEventListener("click", () => {
    if (state.chartRange === "custom" && state.customPanelOpen) {
      state.customPanelOpen = false;
      rerender();
      focusRangeButton(container, "custom");
      return;
    }
    if (!state.customRange) {
      state.customRange = defaultCustomWindow(allPoints);
    }
    state.chartRange = "custom";
    state.customPanelOpen = true;
    rerender();
    focusRangeButton(container, "custom");
  });
  switchGroup.append(customButton);
  toolbar.append(switchGroup);

  const actions = h("div", "chart-toolbar-actions");
  actions.append(
    h(
      "span",
      "chart-range-meta",
      tFormat(
        "chart_sample_count_filtered",
        "%s / %s 个采样",
        points.length,
        allPoints.length,
      ),
    ),
  );

  const exportButton = h(
    "button",
    "export-button",
    t("export_csv", "导出 CSV"),
  );
  exportButton.type = "button";
  exportButton.disabled = !points.length;
  exportButton.title = points.length
    ? tFormat("export_hint", "导出当前时间范围内的 %s 条采样", points.length)
    : t("export_empty", "当前时间范围内没有可导出的数据。");
  exportButton.addEventListener("click", () => {
    exportSamplesCsv(conversation, allPoints);
  });
  actions.append(exportButton);
  toolbar.append(actions);
  container.append(toolbar);
  container.append(buildCustomPanel(allPoints, rerender));

  const chartBody = h("div", "chart-body");
  container.append(chartBody);

  if (!points.length) {
    const empty = h("div", "chart-empty");
    empty.append(
      h(
        "p",
        "hint",
        t(
          "chart_range_empty",
          "该时间范围内没有采样数据，试试扩大范围。",
        ),
      ),
    );
    const reset = h(
      "button",
      "ghost-button",
      t("chart_range_reset", "查看全部"),
    );
    reset.type = "button";
    reset.addEventListener("click", () => {
      state.chartRange = "all";
      state.customPanelOpen = false;
      rerender();
      focusRangeButton(container, "all");
    });
    empty.append(reset);
    chartBody.append(empty);
    animateChartBody(chartBody, options.entrance === true);
    return;
  }

  chartBody.append(
    h(
      "p",
      "chart-note",
      t(
        "chart_curve_note",
        "*横向拖动可放大到所选时间段",
      ),
    ),
  );

  const marker = ui?.compression_marker;
  if (showUsage) {
    chartBody.append(
      h("div", "detail-subtitle", t("chart_usage", "上下文用量曲线")),
    );
    chartBody.append(
      buildChart(points, {
        mode: "usage",
        allPoints,
        onZoom: zoomToRange,
        entrance: options.entrance === true,
        markerPercent:
          marker && marker.enabled !== false ? Number(marker.percent) : null,
        window: Number(conversation?.context_window) || 0,
      }),
    );
  }
  if (showGrowth) {
    chartBody.append(
      h("div", "detail-subtitle", t("chart_growth", "上下文变化量曲线")),
    );
    chartBody.append(
      buildChart(points, {
        mode: "growth",
        allPoints,
        onZoom: zoomToRange,
        entrance: options.entrance === true,
      }),
    );
  }
  animateChartBody(chartBody, options.entrance === true);
}

/** 单调三次插值：曲线经过每个节点，并避免节点间过冲。 */
function buildMonotonePath(series, x, y) {
  if (!series.length) {
    return "";
  }
  if (series.length === 1) {
    return `M${x(series[0].ts).toFixed(2)},${y(series[0].value).toFixed(2)}`;
  }

  const xs = series.map((entry) => x(entry.ts));
  const ys = series.map((entry) => y(entry.value));
  const widths = [];
  const secants = [];
  for (let index = 0; index < series.length - 1; index += 1) {
    const width = xs[index + 1] - xs[index];
    widths.push(width);
    secants.push(width === 0 ? 0 : (ys[index + 1] - ys[index]) / width);
  }

  const slopes = new Array(series.length).fill(0);
  slopes[0] = secants[0];
  slopes[series.length - 1] = secants[secants.length - 1];
  for (let index = 1; index < series.length - 1; index += 1) {
    const before = secants[index - 1];
    const after = secants[index];
    if (before * after <= 0) {
      slopes[index] = 0;
      continue;
    }
    const average = (before + after) / 2;
    const limit = 3 * Math.min(Math.abs(before), Math.abs(after));
    slopes[index] = Math.sign(average) * Math.min(Math.abs(average), limit);
  }

  let path = `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  for (let index = 0; index < series.length - 1; index += 1) {
    const width = widths[index];
    const x1 = xs[index] + width / 3;
    const y1 = ys[index] + (slopes[index] * width) / 3;
    const x2 = xs[index + 1] - width / 3;
    const y2 = ys[index + 1] - (slopes[index + 1] * width) / 3;
    path += ` C${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(
      2,
    )},${y2.toFixed(2)} ${xs[index + 1].toFixed(2)},${ys[
      index + 1
    ].toFixed(2)}`;
  }
  return path;
}

function buildCustomPanel(allPoints, rerender) {
  const rangeWindow = state.customRange || defaultCustomWindow(allPoints);
  const panel = h("div", "range-custom");
  panel.hidden = !state.customPanelOpen;

  const startField = h("label", "range-custom-field");
  startField.append(h("span", null, t("range_custom_start", "开始")));
  const startInput = document.createElement("input");
  startInput.type = "datetime-local";
  startInput.step = "60";
  startInput.className = "range-input";
  startInput.value = toDatetimeLocal(rangeWindow.start);
  startField.append(startInput);

  const separator = h("span", "range-custom-sep", "→");

  const endField = h("label", "range-custom-field");
  endField.append(h("span", null, t("range_custom_end", "结束")));
  const endInput = document.createElement("input");
  endInput.type = "datetime-local";
  endInput.step = "60";
  endInput.className = "range-input";
  endInput.value = toDatetimeLocal(rangeWindow.end);
  endField.append(endInput);

  const apply = h(
    "button",
    "ghost-button",
    t("range_custom_apply", "应用"),
  );
  apply.type = "button";

  const error = h("span", "range-custom-error");
  error.setAttribute("role", "alert");

  apply.addEventListener("click", () => {
    const start = parseDatetimeLocal(startInput.value);
    const end = parseDatetimeLocal(endInput.value);
    if (start == null || end == null || start > end) {
      error.textContent = t(
        "range_custom_invalid",
        "请选择有效的开始和结束时间（开始不能晚于结束）。",
      );
      return;
    }
    error.textContent = "";
    state.customRange = normalizeRangeWindow(start, end);
    state.chartRange = "custom";
    state.customPanelOpen = true;
    rerender();
  });

  panel.append(startField, separator, endField, apply, error);
  return panel;
}

function buildChart(points, options = {}) {
  const mode = options.mode || "usage";
  const width = 600;
  const height = 150;
  const pad = 10;
  const ns = "http://www.w3.org/2000/svg";

  const source =
    Array.isArray(options.allPoints) && options.allPoints.length
      ? options.allPoints
      : points;
  const sourceIndex = new Map(source.map((point, index) => [point.ts, index]));
  const series = points.map((point, index) => {
    if (mode === "growth") {
      const found = sourceIndex.get(point.ts);
      const currentIndex = found === undefined ? index : found;
      const previous = currentIndex > 0 ? source[currentIndex - 1] : point;
      return {
        ts: point.ts,
        value: point.tokens - previous.tokens,
        window: point.window,
      };
    }
    return { ts: point.ts, value: point.tokens, window: point.window };
  });

  const values = series.map((entry) => entry.value);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(1, ...values);
  const valueSpan = maxValue - minValue || 1;
  const minTs = series[0].ts;
  const maxTs = series[series.length - 1].ts;
  const timeSpan = maxTs - minTs || 1;
  const capacity = series.reduce(
    (value, entry) => (entry.window > 0 ? entry.window : value),
    0,
  );

  const x = (ts) =>
    series.length === 1
      ? width / 2
      : pad + ((ts - minTs) / timeSpan) * (width - pad * 2);
  const y = (value) =>
    height - pad - ((value - minValue) / valueSpan) * (height - pad * 2);

  const chartTitle =
    mode === "growth"
      ? t("chart_growth", "上下文变化量曲线")
      : t("chart_usage", "上下文用量曲线");

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "chart");
  svg.setAttribute(
    "aria-label",
    `${chartTitle}，${fmtTime(minTs / 1000)} 至 ${fmtTime(maxTs / 1000)}`,
  );

  const line = (x1, y1, x2, y2, className) => {
    const node = document.createElementNS(ns, "line");
    node.setAttribute("x1", x1);
    node.setAttribute("y1", y1);
    node.setAttribute("x2", x2);
    node.setAttribute("y2", y2);
    if (className) {
      node.setAttribute("class", className);
    }
    svg.append(node);
  };

  line(pad, height - pad, width - pad, height - pad, "chart-axis");
  const midValue = minValue + (maxValue - minValue) / 2;
  line(pad, y(midValue), width - pad, y(midValue), "chart-grid");

  // 平滑单调曲线：经过每个节点，同时避免节点间过冲
  const curveLineData = buildMonotonePath(series, x, y);

  const wantsReveal = options.entrance === true;
  let revealRect = null;
  let revealClipValue = null;
  if (wantsReveal) {
    const revealId = `chart-reveal-${(chartClipSeq += 1)}`;
    const defs = document.createElementNS(ns, "defs");
    const revealClip = document.createElementNS(ns, "clipPath");
    revealClip.setAttribute("id", revealId);
    revealRect = document.createElementNS(ns, "rect");
    if (mode === "growth") {
      revealRect.setAttribute("x", pad - 1);
      revealRect.setAttribute("y", pad - 1);
      revealRect.setAttribute("width", 0);
      revealRect.setAttribute("height", height - pad * 2 + 2);
    } else {
      revealRect.setAttribute("x", 0);
      revealRect.setAttribute("width", width);
      revealRect.setAttribute("y", height - pad + 1);
      revealRect.setAttribute("height", 0);
    }
    revealClip.append(revealRect);
    defs.append(revealClip);
    svg.append(defs);
    revealClipValue = `url(#${revealId})`;
  }

  const areaGroup = document.createElementNS(ns, "g");
  const curveGroup = document.createElementNS(ns, "g");
  if (revealClipValue) {
    areaGroup.setAttribute("clip-path", revealClipValue);
    curveGroup.setAttribute("clip-path", revealClipValue);
  }

  if (mode === "usage" && series.length > 1) {
    const area = document.createElementNS(ns, "path");
    area.setAttribute(
      "d",
      `${curveLineData} L${x(series[series.length - 1].ts).toFixed(1)},${(
        height - pad
      ).toFixed(1)} L${x(series[0].ts).toFixed(1)},${(height - pad).toFixed(
        1,
      )} Z`,
    );
    area.setAttribute("class", "chart-area");
    areaGroup.append(area);
    svg.append(areaGroup);
  }

  if (mode === "growth") {
    const zeroY = y(0);
    line(pad, zeroY, width - pad, zeroY, "chart-zero");
  } else if (capacity > 0 && capacity <= maxValue * 1.2) {
    const capacityY = y(capacity);
    line(pad, capacityY, width - pad, capacityY, "chart-capacity");
  }

  if (mode === "usage" && options.markerPercent && options.window > 0) {
    const threshold = (options.window * Number(options.markerPercent)) / 100;
    if (threshold <= maxValue) {
      const thresholdY = y(threshold);
      line(pad, thresholdY, width - pad, thresholdY, "chart-threshold");
    }
  }

  if (mode === "growth") {
    const zeroY = y(0);
    const clipId = `chart-clip-${(chartClipSeq += 1)}`;
    const defs = document.createElementNS(ns, "defs");

    const positiveClip = document.createElementNS(ns, "clipPath");
    positiveClip.setAttribute("id", `${clipId}-pos`);
    const positiveRect = document.createElementNS(ns, "rect");
    positiveRect.setAttribute("x", 0);
    positiveRect.setAttribute("y", 0);
    positiveRect.setAttribute("width", width);
    positiveRect.setAttribute("height", Math.max(0, zeroY));
    positiveClip.append(positiveRect);

    const negativeClipOffset = 1;
    const negativeClip = document.createElementNS(ns, "clipPath");
    negativeClip.setAttribute("id", `${clipId}-neg`);
    const negativeRect = document.createElementNS(ns, "rect");
    negativeRect.setAttribute("x", 0);
    negativeRect.setAttribute("y", zeroY + negativeClipOffset);
    negativeRect.setAttribute("width", width);
    negativeRect.setAttribute(
      "height",
      Math.max(0, height - zeroY - negativeClipOffset),
    );
    negativeClip.append(negativeRect);

    defs.append(positiveClip, negativeClip);
    svg.append(defs);

    const positivePath = document.createElementNS(ns, "path");
    positivePath.setAttribute("d", curveLineData);
    positivePath.setAttribute("class", "chart-line");
    positivePath.setAttribute("clip-path", `url(#${clipId}-pos)`);
    curveGroup.append(positivePath);

    const negativePath = document.createElementNS(ns, "path");
    negativePath.setAttribute("d", curveLineData);
    negativePath.setAttribute("class", "chart-line-negative");
    negativePath.setAttribute("clip-path", `url(#${clipId}-neg)`);
    curveGroup.append(negativePath);
  } else {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", curveLineData);
    path.setAttribute("class", "chart-line");
    curveGroup.append(path);
  }
  svg.append(curveGroup);
  if (revealRect) {
    if (mode === "growth") {
      animateCurveRevealHorizontal(
        revealRect,
        pad - 1,
        width - pad + 1,
      );
    } else {
      animateCurveReveal(revealRect, pad - 1, height - pad + 1);
    }
  }

  const last = series[series.length - 1];
  const meta = h("div", "chart-meta");
  if (mode === "growth") {
    meta.append(
      h(
        "span",
        null,
        tFormat(
          "chart_last_growth",
          "最近变化量 %s tokens",
          signedNumber(last.value),
        ),
      ),
    );
  } else if (capacity > 0) {
    meta.append(
      h(
        "span",
        null,
        tFormat(
          "chart_last_value_capacity",
          "最近 %s / %s tokens",
          fmtNumber(last.value),
          fmtNumber(capacity),
        ),
      ),
    );
  } else {
    meta.append(
      h(
        "span",
        null,
        tFormat("chart_last_value", "最近 %s tokens", fmtNumber(last.value)),
      ),
    );
  }

  if (mode === "growth" && series.length > 1) {
    const legend = h("span", "chart-legend");
    legend.append(
      h("span", "chart-legend-item", t("chart_growth_positive", "增长")),
    );
    legend.append(
      h(
        "span",
        "chart-legend-item is-negative",
        t("chart_growth_negative", "下降"),
      ),
    );
    meta.append(legend);
  }

  const axisNumber = (value) => {
    const number = Number(value) || 0;
    const abs = Math.abs(number);
    if (abs >= 1000) {
      return fmtNumber(number);
    }
    if (abs >= 10) {
      return String(Math.round(number));
    }
    if (abs >= 1) {
      return number.toFixed(1).replace(/\.0$/, "");
    }
    return number.toFixed(2).replace(/\.?0+$/, "");
  };
  const axisLabel = (value) =>
    mode === "growth" && value > 0
      ? `+${axisNumber(value)}`
      : axisNumber(value);

  const yAxis = h("div", "chart-y-axis");
  yAxis.setAttribute("aria-hidden", "true");
  yAxis.append(
    h("span", null, axisLabel(maxValue)),
    h("span", null, axisLabel(midValue)),
    h("span", null, axisLabel(minValue)),
  );

  const xAxis = h("div", "chart-x-axis");
  xAxis.setAttribute("aria-hidden", "true");
  if (series.length === 1) {
    xAxis.classList.add("is-single");
    xAxis.append(h("span", null, fmtAxisTime(minTs, timeSpan)));
  } else {
    const midTs = minTs + (maxTs - minTs) / 2;
    xAxis.append(
      h("span", null, fmtAxisTime(minTs, timeSpan)),
      h("span", "is-center", fmtAxisTime(midTs, timeSpan)),
      h("span", null, fmtAxisTime(maxTs, timeSpan)),
    );
  }

  const tooltip = h("div", "chart-tooltip");
  tooltip.hidden = true;

  const brush = document.createElementNS(ns, "rect");
  brush.setAttribute("y", pad);
  brush.setAttribute("height", height - pad * 2);
  brush.setAttribute("class", "chart-brush");
  brush.style.display = "none";
  svg.append(brush);

  const overlay = document.createElementNS(ns, "rect");
  overlay.setAttribute("x", 0);
  overlay.setAttribute("y", 0);
  overlay.setAttribute("width", width);
  overlay.setAttribute("height", height);
  overlay.setAttribute("class", "chart-hover-area");
  svg.append(overlay);

  const hoverLine = document.createElementNS(ns, "line");
  hoverLine.setAttribute("class", "chart-hover-line");
  hoverLine.style.display = "none";
  svg.append(hoverLine);

  const hideTooltip = () => {
    tooltip.hidden = true;
    hoverLine.style.display = "none";
  };

  const plotWidth = width - pad * 2;
  const eventViewX = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) {
      return null;
    }
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    return pad + ratio * plotWidth;
  };
  const viewXToTs = (viewX) => {
    if (series.length < 2) {
      return series[0].ts;
    }
    const ratio = Math.max(0, Math.min(1, (viewX - pad) / plotWidth));
    return minTs + ratio * timeSpan;
  };
  let dragStartX = null;
  let dragCurrentX = null;
  let dragPointerId = null;
  let dragging = false;
  const clearDrag = () => {
    dragStartX = null;
    dragCurrentX = null;
    dragPointerId = null;
    dragging = false;
    brush.style.display = "none";
  };

  overlay.addEventListener("pointermove", (event) => {
    if (dragStartX != null) {
      const currentX = eventViewX(event);
      if (currentX != null) {
        dragCurrentX = currentX;
        if (!dragging && Math.abs(currentX - dragStartX) >= 6) {
          dragging = true;
          tooltip.hidden = true;
          hoverLine.style.display = "none";
        }
        if (dragging) {
          const left = Math.min(dragStartX, currentX);
          const right = Math.max(dragStartX, currentX);
          brush.setAttribute("x", left.toFixed(1));
          brush.setAttribute("width", (right - left).toFixed(1));
          brush.style.display = "";
          event.preventDefault();
          return;
        }
      }
    }
    const rect = svg.getBoundingClientRect();
    if (!rect.width) {
      return;
    }
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    const viewX = ratio * width;
    let nearest = series[0];
    for (const entry of series) {
      if (
        Math.abs(x(entry.ts) - viewX) <
        Math.abs(x(nearest.ts) - viewX)
      ) {
        nearest = entry;
      }
    }

    const position = x(nearest.ts) / width;
    tooltip.style.left = `${(position * 100).toFixed(2)}%`;
    tooltip.classList.toggle("is-left", position < 0.15);
    tooltip.classList.toggle("is-right", position > 0.85);

    const parts = [
      h("span", "chart-tooltip-time", fmtTime(nearest.ts / 1000)),
    ];
    if (mode === "growth") {
      parts.push(
        h(
          "span",
          null,
          tFormat(
            "chart_tooltip_growth",
            "变化量 %s tokens",
            signedNumber(nearest.value),
          ),
        ),
      );
    } else if (nearest.window > 0) {
      parts.push(
        h(
          "span",
          null,
          tFormat(
            "chart_tooltip_usage_capacity",
            "已用 %s / %s tokens",
            fmtNumber(nearest.value),
            fmtNumber(nearest.window),
          ),
        ),
      );
    } else {
      parts.push(
        h(
          "span",
          null,
          tFormat(
            "chart_tooltip_usage",
            "已用 %s tokens",
            fmtNumber(nearest.value),
          ),
        ),
      );
    }
    tooltip.replaceChildren(...parts);
    tooltip.hidden = false;

    hoverLine.setAttribute("x1", x(nearest.ts));
    hoverLine.setAttribute("x2", x(nearest.ts));
    hoverLine.setAttribute("y1", pad);
    hoverLine.setAttribute("y2", height - pad);
    hoverLine.style.display = "";
  });
  overlay.addEventListener("pointerleave", hideTooltip);

  overlay.addEventListener("pointerdown", (event) => {
    if (series.length < 2) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const startX = eventViewX(event);
    if (startX == null) {
      return;
    }
    dragStartX = startX;
    dragCurrentX = startX;
    dragPointerId = event.pointerId;
    dragging = false;
    tooltip.hidden = true;
    hoverLine.style.display = "none";
    brush.style.display = "none";
    if (typeof overlay.setPointerCapture === "function") {
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        // 合成事件或部分浏览器不支持指针捕获
      }
    }
  });

  overlay.addEventListener("pointerup", (event) => {
    if (dragStartX == null) {
      return;
    }
    const endX = eventViewX(event) ?? dragCurrentX ?? dragStartX;
    const startX = dragStartX;
    const wasDragging = dragging;
    const pointerId = dragPointerId;
    clearDrag();
    if (
      pointerId != null &&
      typeof overlay.releasePointerCapture === "function"
    ) {
      try {
        overlay.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
    }
    if (!wasDragging) {
      return;
    }
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    if (right - left < 6) {
      return;
    }
    const startTs = viewXToTs(left);
    const endTs = viewXToTs(right);
    if (endTs - startTs < 60 * 1000) {
      return;
    }
    if (typeof options.onZoom === "function") {
      options.onZoom(startTs, endTs);
    }
  });

  overlay.addEventListener("pointercancel", () => {
    clearDrag();
    hideTooltip();
  });

  const canvas = h("div", "chart-canvas");
  canvas.append(svg);
  canvas.append(tooltip);

  const plot = h("div", "chart-plot");
  plot.append(yAxis, canvas);

  const wrapper = h("div", "chart-wrap");
  wrapper.append(plot);
  wrapper.append(xAxis);
  wrapper.append(meta);
  return wrapper;
}

function signedNumber(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${fmtNumber(number)}`;
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
      if (Array.isArray(payload.pinned)) {
        state.pinned = new Set(
          payload.pinned
            .filter((key) => typeof key === "string" && key.trim())
            .slice(0, 200),
        );
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
        pinned: Array.from(state.pinned),
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
    state.ui = payload?.ui || state.ui;
    applyThemeColor();
    if (!silent) {
      state.expanded.clear();
    }
    state.details.clear();
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
  const intervalMinutes = Math.max(1, Number(config?.interval_minutes) || 60);
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
