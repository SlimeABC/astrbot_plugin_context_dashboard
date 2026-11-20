"""astrbot_plugin_context_dashboard（上下文看板）

在 AstrBot WebUI 中以插件可视化视图展示每个会话的上下文用量与压缩次数；
也可以在对话中唤醒机器人后发送 context，直接回复当前对话的上下文占用率。

数据来源：`Context.conversation_manager` 返回的对话记录。
插件不做任何写操作，只读取历史并做统计。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import time
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.api.web import error_response, json_response, request

try:  # 兼容未导出 AstrBotConfig 的旧版本
    from astrbot.api import AstrBotConfig
except ImportError:  # pragma: no cover
    AstrBotConfig = dict

PLUGIN_NAME = "astrbot_plugin_context_dashboard"
PLUGIN_VERSION = "1.1.0"

MAX_CONVERSATIONS = 500  # 单次扫描的最大对话数
MAX_WINDOW_LOOKUPS = 200  # 最多为多少个对话探测模型上下文窗口
MAX_NAME_LOOKUPS = 40  # 单次请求最多查询多少个会话的昵称
NAME_LOOKUP_TIMEOUT = 1.5  # 单个昵称查询的超时时间（秒）
SESSIONS_CACHE_TTL = 900  # 列表结果内存缓存秒数（手动刷新会绕过）
SNAPSHOT_KEY = "sessions_snapshot"  # 持久化快照的 KV key
SAMPLES_KEY = "context_samples"  # 上下文用量采样数据的 KV key
MAX_SAMPLE_SERIES = 100  # 最多保留多少个对话的采样
DEFAULT_SAMPLE_DAYS = 30  # 采样默认保留天数
DEFAULT_THEME_COLOR = "#22c55e"  # 默认主题色（绿色）
_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

# 对话内查询：唤醒后发送 context（不区分大小写，可带 / 前缀）
_CONTEXT_QUERY_RE = re.compile(r"^\s*/?\s*context\s*$", re.IGNORECASE)

# WebUI 偏好（按 Dashboard 用户保存在插件 KV 中）
PREFERENCE_DEFAULTS = {"sort": "tokens", "direction": "desc"}
_SORT_VALUES = {"updated", "tokens", "messages", "compression"}
_DIRECTION_VALUES = {"asc", "desc"}

# 中日韩等表意文字：token 密度远高于拉丁字母
_CJK_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]"
)

# 上下文中可能出现的压缩/摘要标记（尽力而为的启发式检测）
_COMPRESSION_HINT_RE = re.compile(
    r"(上下文压缩|上下文摘要|压缩摘要|压缩后的上下文|"
    r"context compressed|compressed context|conversation summar|summarized context)",
    re.IGNORECASE,
)

_COMPRESSION_KEYS = (
    "compress",
    "compressed",
    "compression",
    "summary",
    "context_summary",
    "compressed_at",
)

# 历史元信息中可能直接记录压缩次数的字段
_COMPRESSION_COUNT_KEYS = (
    "compress_count",
    "compression_count",
    "compressed_count",
    "compression_times",
)


# ---------------------------------------------------------------------------
# 纯函数：历史解析与统计（便于离线测试）
# ---------------------------------------------------------------------------


def estimate_tokens(text: str) -> int:
    """粗略估算文本的 token 数。

    中文约 0.7 token/字，其他字符约 4 字符/token。仅用于展示量级，
    不做精确计费。
    """
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    other = max(len(text) - cjk, 0)
    return int(cjk * 0.7 + other / 4) + 1


def content_to_text(content: Any) -> str:
    """把消息 content 归一化成纯文本。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, bool):
        return str(content).lower()
    if isinstance(content, (int, float)):
        return str(content)
    if isinstance(content, list):
        chunks: list[str] = []
        for part in content:
            if isinstance(part, str):
                chunks.append(part)
                continue
            if not isinstance(part, dict):
                continue
            part_type = str(part.get("type") or "").lower()
            if part_type in ("image_url", "image"):
                chunks.append("[图片]")
                continue
            if part_type in ("audio", "input_audio", "record"):
                chunks.append("[音频]")
                continue
            if part_type in ("file", "document"):
                chunks.append("[文件]")
                continue
            for key in ("text", "content", "thinking", "input"):
                value = part.get(key)
                if isinstance(value, str) and value:
                    chunks.append(value)
                    break
            else:
                arguments = part.get("arguments")
                if isinstance(arguments, str):
                    chunks.append(arguments)
        return "\n".join(chunk for chunk in chunks if chunk)
    if isinstance(content, dict):
        for key in ("text", "content"):
            value = content.get(key)
            if isinstance(value, str):
                return value
        try:
            return json.dumps(content, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(content)
    return str(content)


def coerce_timestamp(value: Any) -> float:
    """把各种时间表示统一成秒级 Unix 时间戳；无法识别时返回 0。"""
    if value is None or isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            number = float(text)
        except ValueError:
            try:
                from datetime import datetime

                return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return 0.0
    else:
        timestamp = getattr(value, "timestamp", None)
        if callable(timestamp):
            try:
                return float(timestamp())
            except (TypeError, ValueError):
                return 0.0
        return 0.0
    if number > 1e12:  # 毫秒
        number /= 1000.0
    return number


def parse_history(raw: Any) -> tuple[list[dict], dict]:
    """解析对话历史，返回 (消息列表, 元信息)。

    AstrBot 的 Conversation.history 一般是 JSON 字符串，可能是消息数组，
    也可能是带 messages/history 字段的对象。这里对两种形态都做兼容。
    """
    data: Any = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return [], {}
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return [], {}

    metadata: dict[str, Any] = {}
    if isinstance(data, dict):
        for key, value in data.items():
            lowered = str(key).lower()
            if any(hint in lowered for hint in _COMPRESSION_KEYS):
                metadata[key] = value
        messages: list = []
        for key in ("messages", "history", "contexts"):
            candidate = data.get(key)
            if isinstance(candidate, list):
                messages = candidate
                break
        data = messages

    if not isinstance(data, list):
        return [], metadata
    return [item for item in data if isinstance(item, dict)], metadata


def analyze_message(message: dict) -> dict:
    """统计单条消息的文本、估算 token 与附件信息。"""
    role = str(message.get("role") or message.get("type") or "unknown").strip().lower()
    text = content_to_text(message.get("content"))
    if not text and message.get("content") is None:
        text = content_to_text(message.get("message"))

    raw_content = message.get("content")
    images = 0
    if isinstance(raw_content, list):
        images = sum(
            1
            for part in raw_content
            if isinstance(part, dict)
            and str(part.get("type") or "").lower() in ("image_url", "image")
        )

    tool_calls = message.get("tool_calls")
    tool_count = len(tool_calls) if isinstance(tool_calls, list) else 0

    return {
        "role": role,
        "text": text,
        "tokens": estimate_tokens(text),
        "chars": len(text),
        "images": images,
        "tool_calls": tool_count,
        "timestamp": coerce_timestamp(
            message.get("timestamp")
            or message.get("created_at")
            or message.get("time")
        ),
    }


def resolve_compression_count(hits: int, metadata: dict) -> int:
    """估算一次对话经历过的压缩次数。

    优先使用历史元信息中的计数字段，其次是压缩记录列表的长度，
    再次是历史中出现的压缩摘要标记数量；最后把压缩时间戳或摘要
    字段视为至少压缩过一次。
    """
    lowered = {str(key).lower(): value for key, value in metadata.items()}

    for key in _COMPRESSION_COUNT_KEYS:
        value = lowered.get(key)
        if isinstance(value, (int, float)) and value >= 0:
            return int(value)

    for key, value in lowered.items():
        if key.endswith(("_records", "_history")) and isinstance(value, list):
            return len(value)

    if hits:
        return hits

    for key in ("compressed_at", "last_compressed_at", "summary", "context_summary"):
        if lowered.get(key):
            return 1
    return 0


def summarize_history(raw: Any) -> tuple[dict, list[dict]]:
    """汇总历史用量与压缩次数。"""
    messages, metadata = parse_history(raw)
    analyzed = [analyze_message(message) for message in messages]

    roles: dict[str, int] = {}
    role_stats: dict[str, dict] = {}
    for item in analyzed:
        roles[item["role"]] = roles.get(item["role"], 0) + 1
        stat = role_stats.setdefault(item["role"], {"messages": 0, "chars": 0})
        stat["messages"] += 1
        stat["chars"] += item["chars"]

    timestamps = [item["timestamp"] for item in analyzed if item["timestamp"]]
    hits = sum(
        1 for item in analyzed if _COMPRESSION_HINT_RE.search(item["text"])
    )
    compression_count = resolve_compression_count(hits, metadata)

    summary = {
        "messages": len(analyzed),
        "tokens": sum(item["tokens"] for item in analyzed),
        "chars": sum(item["chars"] for item in analyzed),
        "roles": roles,
        "role_stats": role_stats,
        "images": sum(item["images"] for item in analyzed),
        "tool_calls": sum(item["tool_calls"] for item in analyzed),
        "first_at": min(timestamps) if timestamps else 0,
        "last_at": max(timestamps) if timestamps else 0,
        "compression_count": compression_count,
    }
    return summary, analyzed


def is_context_query(text: str) -> bool:
    """判断消息是否为上下文查询：context（不区分大小写，可带 / 前缀）。"""
    return bool(_CONTEXT_QUERY_RE.match(text or ""))


def format_token_count(value: int) -> str:
    """把 token 数格式化成紧凑的 1.2k / 3.4M 形式。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return "0"
    if number >= 1_000_000:
        return f"{number / 1_000_000:.1f}M"
    if number >= 10_000:
        return f"{round(number / 1000)}k"
    if number >= 1000:
        return f"{number / 1000:.1f}k"
    return str(number)


def build_progress_bar(ratio: float, width: int = 20) -> str:
    """生成纯文本进度条。"""
    try:
        value = float(ratio)
    except (TypeError, ValueError):
        value = 0.0
    value = max(0.0, min(1.0, value))
    filled = round(value * width)
    if value > 0 and filled == 0:
        filled = 1
    return "█" * filled + "░" * (width - filled)


def format_context_reply(tokens: int, window: int | None, messages: int) -> str:
    """构造上下文占用率的文本回复（进度条 + 百分比）。"""
    if window and window > 0:
        ratio = tokens / window
        return (
            f"上下文占用：{ratio * 100:.1f}%\n"
            f"{build_progress_bar(ratio)} "
            f"{format_token_count(tokens)} / {format_token_count(window)}"
        )
    return (
        "上下文占用：未知（无法读取模型上下文窗口）\n"
        f"估算 {format_token_count(tokens)} tokens · {messages} 条消息"
    )


def find_context_window(value: Any, depth: int = 0) -> int | None:
    """递归查找提供商配置中的上下文窗口大小。

    AstrBot 的窗口配置可能位于 provider_config 顶层，也可能嵌套在
    model_config / model_configs 等结构里，这里做深度有限的搜索。
    """
    if depth > 4:
        return None
    if isinstance(value, dict):
        for key in ("max_context_tokens", "context_window", "max_tokens"):
            raw = value.get(key)
            if isinstance(raw, (int, float)) and int(raw) > 0:
                return int(raw)
        for key in ("model_config", "model_configs", "model_settings"):
            found = find_context_window(value.get(key), depth + 1)
            if found:
                return found
    elif isinstance(value, (list, tuple)):
        for item in value:
            found = find_context_window(item, depth + 1)
            if found:
                return found
    return None


def sanitize_preferences(value: Any) -> dict:
    """校验并规范化 WebUI 偏好。"""
    prefs = dict(PREFERENCE_DEFAULTS)
    if isinstance(value, dict):
        sort = value.get("sort")
        direction = value.get("direction")
        if sort in _SORT_VALUES:
            prefs["sort"] = sort
        if direction in _DIRECTION_VALUES:
            prefs["direction"] = direction
    return prefs


def flatten_config(value: Any) -> dict:
    """把分组配置展平成键值表，兼容旧版扁平配置。"""
    result: dict = {}
    if not isinstance(value, dict):
        return result
    for key, item in value.items():
        if isinstance(item, dict):
            result.update(flatten_config(item))
        else:
            result[str(key)] = item
    return result


def sanitize_color(value: Any, default: str = DEFAULT_THEME_COLOR) -> str:
    """校验 HTML 颜色代码，支持 #RGB 和 #RRGGBB。"""
    if isinstance(value, str):
        color = value.strip()
        if _COLOR_RE.match(color):
            if len(color) == 4:
                color = "#" + "".join(ch * 2 for ch in color[1:])
            return color.lower()
    return default


def walk_config(value: Any, prefix: str = ""):
    """遍历配置字典，产出 (路径, 键, 值)。"""
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(item, dict):
            yield from walk_config(item, path)
        else:
            yield path, str(key), item


def split_umo(value: str) -> tuple[str, str]:
    """从 unified_msg_origin 中拆出 (消息类型, 会话 ID)。"""
    parts = (value or "").split(":")
    if len(parts) >= 3:
        return ":".join(parts[1:-1]), parts[-1]
    return "", value


async def maybe_await(value: Any) -> Any:
    """兼容同步/异步的对话管理器实现。"""
    if inspect.isawaitable(value):
        return await value
    return value


# ---------------------------------------------------------------------------
# 插件主体
# ---------------------------------------------------------------------------


class ContextDashboard(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config = config or {}
        self._settings = flatten_config(self.config)
        self._window_cache: dict[str, int | None] = {}
        self._name_cache: dict[str, str] = {}
        self._name_cache_loaded = False
        self._name_cache_dirty = False
        self._sessions_cache: dict[str, tuple[float, dict]] = {}
        self._snapshot_loaded = False
        self._snapshot: dict | None = None
        self._samples_loaded = False
        self._samples: dict[str, list] = {}
        self._samples_lock: asyncio.Lock | None = None
        self._sample_task: asyncio.Task | None = None
        self._config_cache: dict[str, dict] = {}
        self._config_warning_logged = False

        context.register_web_api(
            f"/{PLUGIN_NAME}/sessions",
            self.api_sessions,
            ["GET"],
            "会话上下文用量列表",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/conversation",
            self.api_conversation,
            ["GET"],
            "单个对话的上下文详情",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/preferences",
            self.api_preferences,
            ["GET", "POST"],
            "WebUI 偏好设置",
        )
        logger.info(f"{PLUGIN_NAME} v{PLUGIN_VERSION} 已加载")
        self._start_sampler()

    # -- 定时采样 ---------------------------------------------------------

    def _start_sampler(self) -> None:
        """按小时在后台采样，保证曲线数据不依赖 WebUI 是否打开。"""
        if not self._config_enabled("enable_history_sampling", True):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._sample_task is None:
            self._sample_task = loop.create_task(self._sample_loop())

    async def _sample_loop(self) -> None:
        while True:
            now = time.time()
            # 对齐到下一个整点后 5 秒
            await asyncio.sleep(3600 - (now % 3600) + 5)
            try:
                await self._sample_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.error(f"[{PLUGIN_NAME}] 定时采样失败: {exc!r}")

    async def _sample_once(self) -> None:
        if not self._config_enabled("enable_history_sampling", True):
            return
        conversations = await self._load_conversations()
        items = self._build_conversations(conversations)
        await self._attach_context_windows(items)
        await self._record_samples(items)

    # -- 对话内查询 -------------------------------------------------------

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def record_sender_name(self, event: AstrMessageEvent):
        """记录私聊发送者昵称，供 WebUI 以「[昵称](ID)」形式展示。"""
        try:
            checker = getattr(event, "is_private_chat", None)
            if not callable(checker) or not checker():
                return
            umo = str(getattr(event, "unified_msg_origin", "") or "")
            if not umo:
                return
            getter = getattr(event, "get_sender_name", None)
            if callable(getter):
                name = str(getter() or "").strip()
                if name:
                    self._name_cache[f"sender:{umo}"] = name
        except Exception:  # noqa: BLE001
            return

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def context_status(self, event: AstrMessageEvent):
        """唤醒后发送 context，直接回复当前会话的上下文占用率。"""
        if not self._config_enabled("enable_chat_command", True):
            return
        if not is_context_query(getattr(event, "message_str", "")):
            return
        if not self._is_woken(event):
            return

        try:
            reply = await self._build_context_status(event)
        except Exception as exc:  # noqa: BLE001 - 查询失败不应打断消息管道
            logger.error(f"[{PLUGIN_NAME}] 读取上下文占用失败: {exc!r}")
            reply = "读取上下文占用失败，请稍后再试。"

        yield event.plain_result(reply)
        event.stop_event()

    async def _build_context_status(self, event: AstrMessageEvent) -> str:
        manager = getattr(self.context, "conversation_manager", None)
        if manager is None:
            return "当前 AstrBot 版本不支持读取对话上下文。"

        umo = str(getattr(event, "unified_msg_origin", "") or "")
        cid = None
        get_cid = getattr(manager, "get_curr_conversation_id", None)
        if umo and callable(get_cid):
            cid = await maybe_await(get_cid(umo))
        if not cid:
            return "当前还没有对话记录，先和机器人聊几句再试试吧。"

        conversation = None
        get_conversation = getattr(manager, "get_conversation", None)
        if callable(get_conversation):
            try:
                conversation = await maybe_await(get_conversation(umo, cid))
            except TypeError:
                conversation = await maybe_await(
                    get_conversation(umo, cid, False)
                )
        if conversation is None:
            return "当前还没有对话记录，先和机器人聊几句再试试吧。"

        summary, _ = summarize_history(getattr(conversation, "history", ""))
        window = await self._lookup_context_window(umo)
        return format_context_reply(summary["tokens"], window, summary["messages"])

    def _config_enabled(self, key: str, default: bool = True) -> bool:
        """读取布尔配置项，兼容分组/扁平配置。"""
        try:
            if key in self._settings:
                value = self._settings[key]
            else:
                value = self.config.get(key, default) if self.config else default
        except Exception:  # noqa: BLE001
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)

    def _config_int(
        self, key: str, default: int, minimum: int = 1, maximum: int = 1440
    ) -> int:
        """读取整数配置项并限制范围，兼容分组/扁平配置。"""
        try:
            if key in self._settings:
                value = self._settings[key]
            else:
                value = self.config.get(key, default) if self.config else default
        except Exception:  # noqa: BLE001
            return default
        try:
            number = int(value)
        except (TypeError, ValueError):
            return default
        return max(minimum, min(number, maximum))

    def _ui_config(self) -> dict:
        """返回 WebUI 的图表与压缩标记配置。"""
        return {
            "charts": {
                "usage": self._config_enabled("show_usage_chart", True),
                "growth": self._config_enabled("show_growth_chart", True),
            },
            "compression_marker": {
                "enabled": self._config_enabled(
                    "show_compression_marker", True
                ),
                "percent": self._config_int(
                    "compression_marker_percent", 82, 1, 100
                ),
            },
            "theme_color": sanitize_color(
                self._settings.get("theme_color", DEFAULT_THEME_COLOR)
            ),
        }

    def _sample_retention(self) -> int:
        """采样保留时长（秒）；0 表示永久保留。"""
        days = self._config_int(
            "history_retention_days", DEFAULT_SAMPLE_DAYS, 0, 365
        )
        return days * 86400

    def _refresh_config(self) -> dict:
        """自动刷新策略：启用每小时统计时至少每小时刷新一次。"""
        sampling = self._config_enabled("enable_history_sampling", True)
        enabled = self._config_enabled("auto_refresh_enabled", True) or sampling
        interval = self._config_int("auto_refresh_interval", 60, 1, 120)
        if sampling:
            interval = min(interval, 60)
        return {"enabled": enabled, "interval_minutes": interval}

    @staticmethod
    def _is_woken(event: AstrMessageEvent) -> bool:
        """确认消息已被唤醒；属性缺失时交由 AstrBot 管道判断。"""
        flag = getattr(event, "is_at_or_wake_command", None)
        if flag is None:
            return True
        if flag:
            return True
        checker = getattr(event, "is_private_chat", None)
        if callable(checker):
            try:
                return bool(checker())
            except Exception:  # noqa: BLE001
                return False
        return False

    # -- Web API ---------------------------------------------------------

    async def api_sessions(self):
        """返回按对话（cid）拆分的上下文用量列表。"""
        query = str(request.query.get("query") or "").strip().lower()
        limit = self._read_limit()
        force = str(request.query.get("refresh") or "").strip().lower() in (
            "1",
            "true",
            "yes",
        )
        cache_key = f"{query}|{limit}"
        now = time.time()
        if not force:
            cached = self._sessions_cache.get(cache_key)
            if cached is not None and now - cached[0] < SESSIONS_CACHE_TTL:
                return json_response(cached[1])

            # 插件重启后先用持久化快照秒开，前端会在后台静默刷新
            if not query and limit == 200:
                snapshot = await self._load_snapshot()
                if snapshot:
                    response = dict(snapshot)
                    response["cached"] = True
                    return json_response(response)

        try:
            conversations = await self._load_conversations()
            items = self._build_conversations(conversations)
            await self._attach_context_windows(items)
            if self._config_enabled("enable_history_sampling", True):
                await self._record_samples(items)
            await self._attach_display_names(items)
            bots = self._build_bot_list(items)

            if query:
                items = [
                    item
                    for item in items
                    if query in item.get("search_text", "")
                ]
            for item in items:
                item.pop("search_text", None)

            totals = {
                "sessions": len(
                    {
                        (item["platform_id"], item["session_raw"])
                        for item in items
                    }
                ),
                "conversations": len(items),
                "messages": sum(item["messages"] for item in items),
                "tokens": sum(item["tokens"] for item in items),
                "compression_count": sum(
                    item["compression_count"] for item in items
                ),
            }
            payload = {
                "plugin": {"name": PLUGIN_NAME, "version": PLUGIN_VERSION},
                "generated_at": int(time.time()),
                "refresh": self._refresh_config(),
                "ui": self._ui_config(),
                "totals": totals,
                "bots": bots,
                "items": items[:limit],
                "truncated": len(items) > limit,
            }
            self._sessions_cache[cache_key] = (time.time(), payload)
            if not query and limit == 200:
                await self._save_snapshot(payload)
            return json_response(payload)
        except Exception as exc:  # noqa: BLE001 - 插件不应让异常逃逸
            logger.error(f"[{PLUGIN_NAME}] 读取会话列表失败: {exc!r}")
            return error_response(f"读取会话失败: {exc}", status_code=500)

    async def api_conversation(self):
        """返回单个对话的上下文详情与最近消息。"""
        platform_id = str(request.query.get("platform") or "").strip()
        session_raw = str(request.query.get("session") or "").strip()
        cid = str(request.query.get("cid") or "").strip()
        if not cid and not session_raw:
            return error_response("缺少对话标识", status_code=400)

        try:
            conversation = await self._find_conversation(
                platform_id, session_raw, cid
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[{PLUGIN_NAME}] 读取对话详情失败: {exc!r}")
            return error_response(f"读取对话失败: {exc}", status_code=500)
        if conversation is None:
            return error_response("未找到该对话", status_code=404)

        history = getattr(conversation, "history", "")
        summary, _ = summarize_history(history)
        umo = session_raw or str(getattr(conversation, "user_id", "") or "")
        window = await self._lookup_context_window(umo) if umo else None
        provider_id = await self._lookup_provider_id(umo) if umo else None

        message_type, session_id = split_umo(umo)
        title = str(getattr(conversation, "title", "") or "").strip()
        conversation_cid = cid or str(getattr(conversation, "cid", "") or "")
        display_name = await self._lookup_display_name(
            {
                "umo": umo,
                "platform_id": platform_id
                or str(getattr(conversation, "platform_id", "") or ""),
                "message_type": message_type,
                "session_id": session_id,
            }
        )
        await self._flush_name_cache()
        policy = await self._context_policy(umo)

        payload = {
            "key": f"{platform_id}:{conversation_cid}",
            "platform_id": platform_id
            or str(getattr(conversation, "platform_id", "") or ""),
            "session_id": session_id or umo,
            "session_raw": umo,
            "message_type": message_type,
            "cid": conversation_cid,
            "title": title or session_id or conversation_cid,
            "display_name": display_name,
            "policy": policy,
            "created_at": int(
                coerce_timestamp(getattr(conversation, "created_at", 0))
            ),
            "updated_at": int(
                coerce_timestamp(getattr(conversation, "updated_at", 0))
            ),
            "messages": summary["messages"],
            "tokens": summary["tokens"],
            "chars": summary["chars"],
            "roles": summary["roles"],
            "role_stats": summary["role_stats"],
            "images": summary["images"],
            "tool_calls": summary["tool_calls"],
            "compression_count": summary["compression_count"],
            "first_at": int(summary["first_at"]),
            "last_at": int(summary["last_at"]),
            "context_window": window,
            "usage_ratio": (
                round(summary["tokens"] / window, 4) if window else None
            ),
            "remaining_tokens": (
                max(window - summary["tokens"], 0) if window else None
            ),
            "provider_id": str(provider_id) if provider_id else "",
            "history_bytes": (
                len(history.encode("utf-8"))
                if isinstance(history, str)
                else 0
            ),
        }

        return json_response(
            {
                "conversation": payload,
                "samples": await self._get_samples(
                    payload["platform_id"], payload["cid"]
                ),
            }
        )

    async def api_preferences(self):
        """读取/保存当前 Dashboard 用户的 WebUI 偏好。"""
        username = str(getattr(request, "username", "") or "default")

        if str(getattr(request, "method", "") or "").upper() == "POST":
            payload = await request.json(default={})
            prefs = sanitize_preferences(payload)
            await self._save_preferences(username, prefs)
            return json_response({"saved": True, **prefs})

        return json_response(await self._load_preferences(username))

    def _preferences_key(self, username: str) -> str:
        return f"ui_preferences_{username or 'default'}"

    async def _load_preferences(self, username: str) -> dict:
        getter = getattr(self, "get_kv_data", None)
        if callable(getter):
            try:
                value = await maybe_await(
                    getter(
                        self._preferences_key(username),
                        dict(PREFERENCE_DEFAULTS),
                    )
                )
                return sanitize_preferences(value)
            except Exception as exc:  # noqa: BLE001
                logger.error(f"[{PLUGIN_NAME}] 读取 UI 偏好失败: {exc!r}")
        return dict(PREFERENCE_DEFAULTS)

    async def _save_preferences(self, username: str, prefs: dict) -> None:
        setter = getattr(self, "put_kv_data", None)
        if not callable(setter):
            return
        try:
            await maybe_await(
                setter(self._preferences_key(username), dict(prefs))
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[{PLUGIN_NAME}] 保存 UI 偏好失败: {exc!r}")

    # -- 数据读取 ---------------------------------------------------------

    async def _find_conversation(
        self, platform_id: str, session_raw: str, cid: str
    ) -> Any | None:
        """优先按 UMO + cid 直接取对话，失败时回退到全量扫描。"""
        manager = getattr(self.context, "conversation_manager", None)
        if manager is None:
            return None

        getter = getattr(manager, "get_conversation", None)
        if callable(getter) and session_raw and cid:
            found = None
            try:
                found = await maybe_await(getter(session_raw, cid))
            except TypeError:
                try:
                    found = await maybe_await(getter(session_raw, cid, False))
                except Exception:  # noqa: BLE001
                    found = None
            except Exception:  # noqa: BLE001
                found = None
            if found is not None:
                return found

        for conversation in await self._load_conversations():
            if platform_id and str(
                getattr(conversation, "platform_id", "") or ""
            ) != platform_id:
                continue
            if cid and str(getattr(conversation, "cid", "") or "") != cid:
                continue
            if session_raw and str(
                getattr(conversation, "user_id", "") or ""
            ) != session_raw:
                continue
            return conversation
        return None

    async def _load_conversations(self) -> list[Any]:
        manager = getattr(self.context, "conversation_manager", None)
        if manager is None:
            raise RuntimeError("当前 AstrBot 版本未提供 conversation_manager")

        getter = getattr(manager, "get_conversations", None)
        if not callable(getter):
            raise RuntimeError("conversation_manager 不支持 get_conversations")

        conversations: list[Any] = []
        try:
            conversations = list(await maybe_await(getter()) or [])
        except TypeError:
            # 部分实现要求显式传入筛选参数
            conversations = []

        if not conversations:
            merged: dict[str, Any] = {}
            for platform_id in self._platform_ids():
                part = await self._get_conversations_for_platform(
                    getter, platform_id
                )
                for conversation in part or []:
                    key = "|".join(
                        [
                            str(getattr(conversation, "platform_id", "") or ""),
                            str(getattr(conversation, "cid", "") or ""),
                        ]
                    )
                    merged[key] = conversation
            conversations = list(merged.values())

        conversations.sort(
            key=lambda conversation: coerce_timestamp(
                getattr(conversation, "updated_at", 0)
            ),
            reverse=True,
        )
        return conversations[:MAX_CONVERSATIONS]

    @staticmethod
    async def _get_conversations_for_platform(getter, platform_id: str) -> list[Any]:
        """兼容不同签名：优先关键字，失败后退回位置参数。"""
        try:
            return list(await maybe_await(getter(platform_id=platform_id)) or [])
        except TypeError:
            pass
        except Exception:  # noqa: BLE001 - 单个平台失败不影响其他平台
            return []
        try:
            return list(await maybe_await(getter(None, platform_id)) or [])
        except Exception:  # noqa: BLE001
            return []

    def _platform_meta(self) -> dict[str, dict]:
        """收集已加载平台实例（机器人）的 ID、名称与类型。"""
        result: dict[str, dict] = {}
        try:
            instances = self.context.platform_manager.get_insts()
        except Exception:  # noqa: BLE001
            return result

        for instance in instances or []:
            meta = None
            meta_getter = getattr(instance, "meta", None)
            if callable(meta_getter):
                try:
                    meta = meta_getter()
                except Exception:  # noqa: BLE001
                    meta = None

            config = getattr(instance, "config", None)
            if not isinstance(config, dict):
                config = {}

            platform_id = (
                self._read_meta(meta, "id")
                or getattr(instance, "platform_id", None)
                or getattr(instance, "id", None)
                or config.get("id")
            )
            if not isinstance(platform_id, str) or not platform_id:
                continue

            name = (
                self._read_meta(meta, "name")
                or config.get("name")
                or platform_id
            )
            platform_type = (
                self._read_meta(meta, "type")
                or getattr(instance, "type", None)
                or config.get("type")
                or ""
            )
            result[platform_id] = {
                "platform_id": platform_id,
                "name": str(name),
                "type": str(platform_type),
            }
        return result

    @staticmethod
    def _read_meta(meta: Any, key: str) -> Any:
        if isinstance(meta, dict):
            return meta.get(key)
        return getattr(meta, key, None)

    def _platform_ids(self) -> list[str]:
        """已加载平台实例的 ID，用于兼容需要 platform_id 的实现。"""
        return list(self._platform_meta().keys())

    # -- 聚合 -------------------------------------------------------------

    def _build_conversations(self, conversations: list[Any]) -> list[dict]:
        """把每个对话（cid）整理成一条独立记录。"""
        items: list[dict] = []

        for conversation in conversations:
            platform_id = str(getattr(conversation, "platform_id", "") or "")
            user_id = str(getattr(conversation, "user_id", "") or "")
            cid = str(getattr(conversation, "cid", "") or "")
            if not user_id and not cid:
                continue

            summary, _ = summarize_history(getattr(conversation, "history", ""))
            if summary["messages"] == 0:
                continue
            message_type, session_id = split_umo(user_id)
            title = str(getattr(conversation, "title", "") or "").strip()

            search_parts = [
                platform_id,
                user_id,
                session_id,
                message_type,
                cid,
                title,
            ]

            items.append(
                {
                    "key": f"{platform_id}:{cid or user_id}",
                    "platform_id": platform_id,
                    "session_id": session_id or user_id,
                    "session_raw": user_id,
                    "message_type": message_type,
                    "umo": (
                        user_id
                        if user_id.count(":") >= 2
                        else f"{platform_id}:{user_id}"
                    ),
                    "cid": cid,
                    "title": title or session_id or cid,
                    "messages": summary["messages"],
                    "tokens": summary["tokens"],
                    "chars": summary["chars"],
                    "roles": summary["roles"],
                    "role_stats": summary["role_stats"],
                    "images": summary["images"],
                    "tool_calls": summary["tool_calls"],
                    "compressed": summary["compression_count"] > 0,
                    "compression_count": summary["compression_count"],
                    "context_window": None,
                    "usage_ratio": None,
                    "created_at": int(
                        coerce_timestamp(
                            getattr(conversation, "created_at", 0)
                        )
                    ),
                    "updated_at": int(
                        coerce_timestamp(
                            getattr(conversation, "updated_at", 0)
                        )
                    ),
                    "search_text": " ".join(
                        part for part in search_parts if part
                    ).lower(),
                }
            )

        items.sort(
            key=lambda item: (item["updated_at"], item["tokens"]),
            reverse=True,
        )
        return items

    def _build_bot_list(self, items: list[dict]) -> list[dict]:
        """按机器人（平台实例）汇总对话数量，供 WebUI 筛选栏使用。"""
        counts: dict[str, int] = {}
        for item in items:
            platform_id = item.get("platform_id") or ""
            counts[platform_id] = counts.get(platform_id, 0) + 1

        bots: list[dict] = []
        seen: set[str] = set()
        for platform_id, info in self._platform_meta().items():
            seen.add(platform_id)
            bots.append(
                {
                    "platform_id": platform_id,
                    "name": info.get("name") or platform_id,
                    "type": info.get("type") or "",
                    "conversations": counts.get(platform_id, 0),
                }
            )

        # 补上历史对话里出现、但当前未加载的平台
        for platform_id, count in counts.items():
            if platform_id in seen:
                continue
            bots.append(
                {
                    "platform_id": platform_id,
                    "name": platform_id or "unknown",
                    "type": "",
                    "conversations": count,
                }
            )

        bots.sort(key=lambda bot: (-bot["conversations"], bot["name"].lower()))
        return bots

    # -- 上下文窗口 -------------------------------------------------------

    async def _attach_context_windows(self, items: list[dict]) -> None:
        """尽力为每个对话补上模型上下文窗口与使用比例。"""
        lookups = 0
        for item in items:
            umo = item.get("umo") or item.get("session_raw") or ""
            if not umo:
                continue
            if lookups >= MAX_WINDOW_LOOKUPS:
                break
            lookups += 1
            window = await self._lookup_context_window(umo)
            if not window:
                continue
            item["context_window"] = window
            item["usage_ratio"] = round(item["tokens"] / window, 4)

    async def _lookup_provider_id(self, umo: str) -> str | None:
        """获取会话当前使用的对话模型提供商 ID。"""
        if not umo:
            return None
        getter = getattr(self.context, "get_current_chat_provider_id", None)
        if not callable(getter):
            return None
        try:
            provider_id = await maybe_await(getter(umo=umo))
        except TypeError:
            try:
                provider_id = await maybe_await(getter(umo))
            except Exception:  # noqa: BLE001
                return None
        except Exception:  # noqa: BLE001
            return None
        return str(provider_id) if provider_id else None

    async def _get_config(self, umo: str) -> dict:
        """读取会话对应的 AstrBot 配置文件（只读）。"""
        if not umo:
            return {}
        if umo in self._config_cache:
            return self._config_cache[umo]

        getter = getattr(self.context, "get_config", None)
        value = None
        if callable(getter):
            try:
                value = getter(umo=umo)
            except TypeError:
                try:
                    value = getter()
                except Exception:  # noqa: BLE001
                    value = None
            except Exception:  # noqa: BLE001
                value = None
        elif not self._config_warning_logged:
            self._config_warning_logged = True
            logger.warning(
                f"[{PLUGIN_NAME}] 当前 AstrBot 未提供 context.get_config，"
                "无法读取上下文策略"
            )
        value = await maybe_await(value)
        if not isinstance(value, dict):
            value = {}
        self._config_cache[umo] = value
        return value

    async def _configured_fallback_window(self, umo: str) -> int | None:
        """读取配置文件中的上下文窗口兜底值。"""
        config = await self._get_config(umo)
        for _path, key, value in walk_config(config):
            lower = key.lower()
            if "fallback" in lower and ("context" in lower or "window" in lower):
                if (
                    not isinstance(value, bool)
                    and isinstance(value, (int, float))
                    and int(value) > 0
                ):
                    return int(value)
        return None

    async def _context_policy(self, umo: str) -> dict:
        """汇总配置中的上下文管理策略，供详情展示。"""
        config = await self._get_config(umo)
        fallback = None
        entries: list[dict] = []
        seen: set[tuple[str, str]] = set()

        for path, key, value in walk_config(config):
            if isinstance(value, bool) or value is None:
                continue
            if not isinstance(value, (str, int, float)):
                continue
            lower = key.lower()
            if isinstance(value, str):
                text = value.strip()
                if not text:
                    continue
                if len(text) > 160:
                    text = text[:160] + "…"
            else:
                text = value

            if "fallback" in lower and ("context" in lower or "window" in lower):
                if (
                    not isinstance(value, bool)
                    and isinstance(value, (int, float))
                    and int(value) > 0
                ):
                    fallback = int(value)
            elif not (
                lower in ("max_context_length", "dequeue_context_length")
                or any(
                    token in lower
                    for token in ("compress", "summary", "context", "window")
                )
            ):
                continue

            marker = (key, str(text))
            if marker in seen:
                continue
            seen.add(marker)
            entries.append({"key": key, "path": path, "value": text})

        return {
            "config_found": bool(config),
            "window_fallback": fallback,
            "entries": entries[:16],
        }

    async def _lookup_context_window(self, umo: str) -> int | None:
        if umo in self._window_cache:
            return self._window_cache[umo]

        provider_id = await self._lookup_provider_id(umo)
        window = self._provider_window(provider_id) if provider_id else None
        if not window:
            window = await self._configured_fallback_window(umo)
        self._window_cache[umo] = window
        return window

    def _provider_window(self, provider_id: str | None) -> int | None:
        """从模型提供商配置里读取上下文窗口大小。"""
        try:
            manager = self.context.provider_manager
        except Exception:  # noqa: BLE001
            return None

        candidates: list[Any] = []
        for attribute in ("llm_providers", "providers", "provider_insts"):
            value = getattr(manager, attribute, None)
            if isinstance(value, (list, tuple)):
                candidates = list(value)
                break
        if not candidates:
            getter = getattr(manager, "get_insts", None)
            if callable(getter):
                try:
                    candidates = list(getter() or [])
                except Exception:  # noqa: BLE001
                    candidates = []

        fallback: list[int] = []
        for provider in candidates:
            if isinstance(provider, dict):
                config: Any = provider.get("provider_config") or provider
                pid = provider.get("id") or provider.get("provider_id")
            else:
                config = getattr(provider, "provider_config", None)
                if config is None:
                    config = getattr(provider, "model_config", None)
                pid = getattr(provider, "provider_id", None) or getattr(
                    provider, "id", None
                )

            window = find_context_window(config)
            if window is None and not isinstance(provider, dict):
                getter = getattr(provider, "get_model_config", None)
                if callable(getter):
                    try:
                        window = find_context_window(getter())
                    except Exception:  # noqa: BLE001
                        window = None
                if window is None:
                    window = find_context_window(
                        getattr(provider, "model_config", None)
                    )

            if not window:
                continue
            if pid is None or (provider_id and str(pid) == provider_id):
                return window
            fallback.append(window)

        # 只有一个提供商带窗口配置时，即使 ID 对不上也使用它
        if len(fallback) == 1:
            return fallback[0]
        return None

    # -- 会话昵称 ---------------------------------------------------------

    async def _attach_display_names(self, items: list[dict]) -> None:
        """为每个会话补上昵称，供 WebUI 显示「昵称(ID)」。"""
        await self._ensure_name_cache()
        pending: list[dict] = []
        seen: set[str] = set()

        for item in items:
            umo = item.get("umo") or ""
            if not umo:
                item["display_name"] = ""
                continue
            if umo in seen:
                item["display_name"] = self._name_cache.get(umo, "")
                continue
            seen.add(umo)
            if umo in self._name_cache:
                item["display_name"] = self._name_cache[umo]
                continue
            if len(pending) >= MAX_NAME_LOOKUPS:
                item["display_name"] = ""
                continue
            pending.append(item)

        if not pending:
            return

        # 并发查询，但限制并发数，避免给协议端造成压力
        semaphore = asyncio.Semaphore(5)

        async def fetch(item: dict) -> None:
            async with semaphore:
                item["display_name"] = await self._lookup_display_name(item)

        await asyncio.gather(*(fetch(item) for item in pending))
        await self._flush_name_cache()

    async def _lookup_display_name(self, item: dict) -> str:
        umo = item.get("umo") or ""
        if not umo:
            return ""
        await self._ensure_name_cache()
        if umo in self._name_cache:
            return self._name_cache[umo]

        platform_id = str(item.get("platform_id") or "")
        message_type = str(item.get("message_type") or "").lower()
        session_id = str(item.get("session_id") or "")

        name = ""
        client = self._platform_client(platform_id)
        if client is not None and session_id:
            api = getattr(client, "api", None)
            call_action = getattr(api, "call_action", None)
            if callable(call_action):
                try:
                    if "group" in message_type:
                        result = await asyncio.wait_for(
                            maybe_await(
                                call_action(
                                    "get_group_info",
                                    group_id=self._to_int(session_id),
                                )
                            ),
                            timeout=NAME_LOOKUP_TIMEOUT,
                        )
                        if isinstance(result, dict):
                            name = str(
                                result.get("group_name")
                                or result.get("groupName")
                                or ""
                            ).strip()
                    else:
                        result = await asyncio.wait_for(
                            maybe_await(
                                call_action(
                                    "get_stranger_info",
                                    user_id=self._to_int(session_id),
                                )
                            ),
                            timeout=NAME_LOOKUP_TIMEOUT,
                        )
                        if isinstance(result, dict):
                            name = str(
                                result.get("nickname")
                                or result.get("name")
                                or ""
                            ).strip()
                except Exception:  # noqa: BLE001
                    name = ""

        if not name:
            name = self._name_cache.get(f"sender:{umo}", "")

        self._name_cache[umo] = name
        self._name_cache_dirty = True
        return name

    async def _ensure_name_cache(self) -> None:
        """首次使用时从插件 KV 加载昵称缓存。"""
        if self._name_cache_loaded:
            return
        self._name_cache_loaded = True
        getter = getattr(self, "get_kv_data", None)
        if not callable(getter):
            return
        try:
            value = await maybe_await(getter("name_cache", {}))
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[{PLUGIN_NAME}] 读取昵称缓存失败: {exc!r}")
            return
        if isinstance(value, dict):
            for key, name in value.items():
                if isinstance(key, str) and isinstance(name, str):
                    self._name_cache.setdefault(key, name)

    async def _flush_name_cache(self) -> None:
        """把昵称缓存写回插件 KV。"""
        if not self._name_cache_dirty:
            return
        setter = getattr(self, "put_kv_data", None)
        if not callable(setter):
            self._name_cache_dirty = False
            return
        self._name_cache_dirty = False
        try:
            await maybe_await(setter("name_cache", dict(self._name_cache)))
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[{PLUGIN_NAME}] 保存昵称缓存失败: {exc!r}")

    async def _load_snapshot(self) -> dict | None:
        """首次使用时从插件 KV 加载会话快照。"""
        if self._snapshot_loaded:
            return self._snapshot
        self._snapshot_loaded = True
        getter = getattr(self, "get_kv_data", None)
        if callable(getter):
            try:
                value = await maybe_await(getter(SNAPSHOT_KEY, None))
            except Exception as exc:  # noqa: BLE001
                logger.error(f"[{PLUGIN_NAME}] 读取会话快照失败: {exc!r}")
                return None
            if isinstance(value, dict) and isinstance(value.get("items"), list):
                self._snapshot = value
        return self._snapshot

    async def _save_snapshot(self, payload: dict) -> None:
        """把会话列表结果写入插件 KV，供下次启动秒开。"""
        snapshot = dict(payload)
        snapshot.pop("cached", None)
        self._snapshot = snapshot
        self._snapshot_loaded = True
        setter = getattr(self, "put_kv_data", None)
        if not callable(setter):
            return
        try:
            await maybe_await(setter(SNAPSHOT_KEY, snapshot))
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[{PLUGIN_NAME}] 保存会话快照失败: {exc!r}")

    # -- 用量采样 ---------------------------------------------------------

    def _get_samples_lock(self) -> asyncio.Lock:
        if self._samples_lock is None:
            self._samples_lock = asyncio.Lock()
        return self._samples_lock

    async def _record_samples(self, items: list[dict]) -> None:
        if not items:
            return
        async with self._get_samples_lock():
            await self._record_samples_locked(items)

    async def _record_samples_locked(self, items: list[dict]) -> None:
        """把每个对话当前的已用/总上下文记录到小时级采样中。"""
        samples = await self._load_samples()
        now = int(time.time())
        bucket = now - (now % 3600)
        retention = self._sample_retention()
        cutoff = now - retention if retention > 0 else None
        max_points = (
            max(24, int(retention / 3600) + 1) if retention > 0 else None
        )

        for item in items:
            cid = str(item.get("cid") or "")
            if not cid:
                continue
            key = f"{item.get('platform_id', '')}:{cid}"
            series = samples.get(key)
            if not isinstance(series, list):
                series = []
            point = [
                bucket,
                int(item.get("tokens") or 0),
                int(item.get("context_window") or 0),
            ]
            if series and series[-1][0] == bucket:
                series[-1] = point
            else:
                series.append(point)
            entries = [
                entry
                for entry in series
                if isinstance(entry, list)
                and len(entry) >= 2
                and (cutoff is None or entry[0] >= cutoff)
            ]
            if max_points:
                entries = entries[-max_points:]
            samples[key] = entries

        if len(samples) > MAX_SAMPLE_SERIES:
            ordered = sorted(
                samples.items(),
                key=lambda kv: kv[1][-1][0] if kv[1] else 0,
                reverse=True,
            )
            samples = dict(ordered[:MAX_SAMPLE_SERIES])

        await self._save_samples(samples)

    async def _load_samples(self) -> dict[str, list]:
        """首次使用时从插件 KV 加载采样数据。"""
        if self._samples_loaded:
            return self._samples
        self._samples_loaded = True
        getter = getattr(self, "get_kv_data", None)
        if callable(getter):
            try:
                value = await maybe_await(getter(SAMPLES_KEY, {}))
            except Exception as exc:  # noqa: BLE001
                logger.error(f"[{PLUGIN_NAME}] 读取用量采样失败: {exc!r}")
                return self._samples
            if isinstance(value, dict):
                for key, series in value.items():
                    if not isinstance(key, str) or not isinstance(series, list):
                        continue
                    cleaned = []
                    for entry in series:
                        if (
                            not isinstance(entry, (list, tuple))
                            or len(entry) < 2
                            or not isinstance(entry[0], (int, float))
                            or not isinstance(entry[1], (int, float))
                        ):
                            continue
                        window = entry[2] if len(entry) > 2 else 0
                        if not isinstance(window, (int, float)):
                            window = 0
                        cleaned.append(
                            [int(entry[0]), int(entry[1]), int(window)]
                        )
                    if cleaned:
                        self._samples[key] = cleaned
        return self._samples

    async def _save_samples(self, samples: dict[str, list]) -> None:
        """把采样数据写回插件 KV。"""
        self._samples = samples
        self._samples_loaded = True
        setter = getattr(self, "put_kv_data", None)
        if not callable(setter):
            return
        try:
            await maybe_await(setter(SAMPLES_KEY, samples))
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[{PLUGIN_NAME}] 保存用量采样失败: {exc!r}")

    async def _get_samples(
        self, platform_id: str, cid: str
    ) -> list[list[int]]:
        if not cid:
            return []
        samples = await self._load_samples()
        series = samples.get(f"{platform_id}:{cid}", [])
        retention = self._sample_retention()
        if retention > 0:
            cutoff = int(time.time()) - retention
            series = [entry for entry in series if entry[0] >= cutoff]
        return [
            [int(entry[0]), int(entry[1]), int(entry[2])]
            for entry in series
        ]

    def _platform_client(self, platform_id: str) -> Any | None:
        """尽力获取平台适配器的客户端（用于调用协议端 API）。"""
        if not platform_id:
            return None
        try:
            platform = self.context.get_platform_inst(platform_id)
        except Exception:  # noqa: BLE001
            return None
        if platform is None:
            return None

        for attribute in ("get_client", "client"):
            value = getattr(platform, attribute, None)
            if callable(value):
                try:
                    client = value()
                except Exception:  # noqa: BLE001
                    client = None
                if client is not None:
                    return client
            elif value is not None:
                return value
        return None

    @staticmethod
    def _to_int(value: str) -> int | str:
        try:
            return int(value)
        except (TypeError, ValueError):
            return value

    # -- 工具 -------------------------------------------------------------

    @staticmethod
    def _read_limit() -> int:
        try:
            raw = request.query.get("limit", 200, type=int)
        except (TypeError, ValueError):
            raw = 200
        try:
            value = int(raw or 200)
        except (TypeError, ValueError):
            value = 200
        return max(1, min(value, MAX_CONVERSATIONS))

    async def terminate(self):
        """插件被卸载/停用时清理缓存。"""
        if self._sample_task is not None:
            self._sample_task.cancel()
            self._sample_task = None
        self._window_cache.clear()
        self._name_cache.clear()
        self._sessions_cache.clear()
        self._snapshot = None
        self._config_cache.clear()
