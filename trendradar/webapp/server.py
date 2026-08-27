# coding=utf-8
"""
选题终端 Web 服务（TOPIC TERMINAL）

基于标准库 http.server 的轻量 JSON API + 静态文件服务：
- 读侧以只读方式访问按天分库的 SQLite（output/news、output/rss），与爬虫进程零写入竞争
- 写侧只落 output/terminal/*.json
- 默认监听 127.0.0.1；容器内自动 0.0.0.0；TERMINAL_HOST/TERMINAL_PORT 可覆盖

启动:
  python -m trendradar.webapp [--host H] [--port P]
  python -m trendradar --serve [--terminal-port P]
"""

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from trendradar import __version__
from trendradar.webapp.reader import AUTHORITY_PLATFORMS, TerminalReader, interests_hash
from trendradar.webapp.store import VALID_TOPIC_STATUS, TerminalStore

STATIC_ROOT = Path(__file__).parent / "static"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}
MAX_BODY_BYTES = 256 * 1024
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class AppError(Exception):
    """带 HTTP 状态与错误码的业务异常（对客户端隐藏内部细节）"""

    def __init__(self, message: str, status: int = 400, code: str = "bad_request"):
        super().__init__(message)
        self.status = status
        self.code = code


# ---------------------------------------------------------------------------
# 应用装配
# ---------------------------------------------------------------------------

class TerminalApp:
    """服务端单例：配置/存储/终端 store 与可选的 AI 服务"""

    def __init__(self):
        from trendradar.context import AppContext
        from trendradar.core import load_config

        self.config = load_config()
        self.ctx = AppContext(self.config)
        self.storage = self.ctx.get_storage_manager()
        self._adapt_storage_for_terminal()
        self.store = TerminalStore(os.environ.get("TERMINAL_DATA_DIR", "output/terminal"))
        self.reader = TerminalReader(self.ctx)
        self.token = os.environ.get("TERMINAL_TOKEN", "").strip()
        self.debug = bool(self.config.get("DEBUG", False))
        self.auto_rescore = os.environ.get("TERMINAL_AUTO_RESCORE", "1") != "0"

        from trendradar.webapp.tasks import TaskQueue, bind_jobs

        self.tasks = TaskQueue(now_func=lambda: self.ctx.get_time().strftime("%Y-%m-%d %H:%M:%S"))

        jobs = {}
        self.scorer = None
        self.researcher = None
        try:
            from trendradar.webapp.scoring import ScoringService

            self.scorer = ScoringService(
                ctx=self.ctx, storage=self.storage, store=self.store,
                reader=self.reader, tasks=self.tasks,
            )
            jobs["rescore"] = self.scorer.rescore_job
            print("[选题终端] AI 打分服务已就绪")
        except Exception as e:  # noqa: BLE001 —— 缺少 AI 依赖时降级运行
            print(f"[选题终端] AI 打分服务未启用: {e}")
        try:
            from trendradar.webapp.research import ResearchService

            self.researcher = ResearchService(
                ctx=self.ctx, reader=self.reader, store=self.store, scorer=self.scorer,
            )
            jobs["research"] = self.researcher.research_job
            print("[选题终端] AI 研判服务已就绪")
        except Exception as e:  # noqa: BLE001
            print(f"[选题终端] AI 研判服务未启用: {e}")

        bind_jobs(self.tasks, jobs)
        self.tasks.start()

    @property
    def engine(self) -> str:
        return getattr(self.scorer, "engine", "unavailable")

    def _adapt_storage_for_terminal(self) -> None:
        """
        把存储后端适配到多线程只读的终端进程：

        1. 线程安全：LocalStorageBackend 按路径缓存 sqlite3.Connection，
           单线程爬虫没有问题，但 ThreadingHTTPServer 的请求来自不同线程，
           复用会触发 "SQLite objects created in a thread..." —— 改为
           每线程独立建连（threading.local 缓存），schema 初始化全局仅一次。
        2. 调试锚点：TERMINAL_DATE=YYYY-MM-DD 时，把所有 date=None 的
           "默认今天" 统一改写（覆盖 AI 筛选管线内部的存储调用）。

        补丁只作用于本 webapp 进程内的后端实例，不影响爬虫管线与磁盘结构。
        """
        import sqlite3 as _sqlite3
        import threading as _threading

        backend = self.storage.get_backend()
        override = os.environ.get("TERMINAL_DATE", "")
        has_override = bool(DATE_RE.match(override))
        original_format = backend._format_date_folder

        # 默认今天 → 调试覆盖（显式传入的 date 始终透传）
        backend._format_date_folder = lambda date=None: (
            override if (has_override and not date) else original_format(date)
        )

        tls = _threading.local()
        seen_paths: set[str] = set()
        open_lock = _threading.Lock()

        def get_connection_threadsafe(date=None, db_type="news"):
            db_path = str(backend._get_db_path(date, db_type))
            cache = getattr(tls, "conns", None)
            if cache is None:
                cache = tls.conns = {}
            conn = cache.get(db_path)
            if conn is not None:
                return conn

            db_exists = Path(db_path).exists()
            with open_lock:
                first_time = db_path not in seen_paths
                if db_exists:
                    # 只读 URI：绝不触碰爬虫正在写的文件
                    conn = _sqlite3.connect(
                        f"file:{Path(db_path).as_posix()}?mode=ro",
                        uri=True, timeout=5,
                    )
                    conn.row_factory = _sqlite3.Row
                    conn.execute("PRAGMA busy_timeout = 5000")
                    if first_time and db_type == "news":
                        # ai_filter 表在极老库中可能缺失；缺失即视为无打分数据，静默降级
                        try:
                            backend._init_tables(conn, db_type)
                        except _sqlite3.OperationalError:
                            pass
                else:
                    # 库不存在：维持与主管线一致的语义（建空库），避免下游空指针
                    conn = _sqlite3.connect(db_path, timeout=5)
                    conn.row_factory = _sqlite3.Row
                    backend._init_tables(conn, db_type)
                seen_paths.add(db_path)
            cache[db_path] = conn
            return conn

        backend._get_connection = get_connection_threadsafe  # noqa: SLF001

        tag = f"，TERMINAL_DATE={override}" if has_override else ""
        print(f"[选题终端] 存储已适配（每线程连接{tag}）")


# ---------------------------------------------------------------------------
# API 处理器
# ---------------------------------------------------------------------------

def api_bootstrap(app: TerminalApp, params: dict, body: dict | None) -> dict:
    now = app.ctx.get_time()
    profile = app.store.load_profile()
    return {
        "version": __version__,
        "engine": app.engine,
        "date": app.reader.today(),
        "last_available_date": app.reader.last_available_date(),
        "timezone": app.reader.timezone,
        "nickname": profile.get("nickname", ""),
        "has_interests": bool(profile.get("interests")),
        "status": api_status(app, params, body),
        "platforms": app.reader.configured_platforms(),
        "feeds": app.reader.configured_feeds(),
        "authority_platforms": list(AUTHORITY_PLATFORMS),
        "server_now": now.strftime("%Y-%m-%d %H:%M:%S"),
    }


def api_status(app: TerminalApp, params: dict, body: dict | None) -> dict:
    date = params.get("date", "")
    if date and not DATE_RE.match(date):
        raise AppError("date 参数格式应为 YYYY-MM-DD")
    return app.reader.status_summary(date or None)


def api_hotlists(app: TerminalApp, params: dict, body: dict | None) -> dict:
    platform_ids = [
        p.strip() for p in (params.get("platforms") or "").split(",") if p.strip()
    ]
    configured = {p["id"] for p in app.reader.configured_platforms()}
    platforms = [p for p in platform_ids if p in configured] or None
    limit = _clamp_int(params.get("limit"), default=30, low=5, high=100)
    date = params.get("date", "")
    if date and not DATE_RE.match(date):
        raise AppError("date 参数格式应为 YYYY-MM-DD")

    data = app.reader.hotlists(platforms=platforms, limit=limit, date=date or None)

    statuses = app.store.load_topic_status()
    for group in data["platforms"]:
        for item in group["items"]:
            entry = statuses.get(item["key"])
            item["topic_status"] = entry["status"] if entry else ""

    if app.auto_rescore and app.scorer is not None and not date:
        try:
            app.scorer.maybe_auto_rescore(data.get("fetched_at", ""))
        except Exception:  # noqa: BLE001 —— 自动刷新失败不影响本次读取
            pass
    return data


def api_news_stream(app: TerminalApp, params: dict, body: dict | None) -> dict:
    hours = _clamp_int(params.get("hours"), default=24, low=1, high=168)
    limit = _clamp_int(params.get("limit"), default=80, low=10, high=300)
    date = params.get("date", "")
    if date and not DATE_RE.match(date):
        raise AppError("date 参数格式应为 YYYY-MM-DD")
    stream = app.reader.news_stream(hours=hours, limit=limit, date=date or None)

    statuses = app.store.load_topic_status()
    interest_only = params.get("interest_only") == "1"
    items = []
    for entry in stream["items"]:
        if interest_only and (entry.get("match") or {}).get("level") not in ("high", "mid"):
            continue
        entry["topic_status"] = (statuses.get(entry["key"]) or {}).get("status", "")
        items.append(entry)
    stream["items"] = items
    return stream


def api_profile_get(app: TerminalApp, params: dict, body: dict | None) -> dict:
    profile = app.store.load_profile()
    profile["interests_hash"] = app.store.saved_interests_hash()
    profile.pop("updated_at", None)
    return {"profile": profile}


def api_profile_post(app: TerminalApp, params: dict, body: dict) -> dict:
    if body is None:
        raise AppError("请求体不能为空")
    provided = {k: body[k] for k in ("nickname", "keywords", "interests", "source_prefs") if k in body}

    # 合并语义：未提供的字段保留现值（例如只改昵称不应清空兴趣描述）
    current = app.store.load_profile()
    payload = {**current, **provided}

    interests = str(payload.get("interests", "") or "")
    new_hash = interests_hash(interests) if interests else ""
    old_hash = app.store.saved_interests_hash()

    profile = app.store.save_profile(payload, _now(app), interests_hash=new_hash or None)

    task_id = None
    changed = interests and new_hash != old_hash
    if changed:
        if app.scorer is not None:
            task_id = app.scorer.trigger_rescore()
        else:
            raise AppError(
                "配置已保存，但 AI 打分服务不可用（缺少模型或 API Key）",
                status=503, code="scorer_unavailable",
            )
    return {"profile": profile, "task_id": task_id}


def api_topic_status_post(app: TerminalApp, params: dict, body: dict) -> dict:
    key = str((body or {}).get("key") or "")
    status = str((body or {}).get("status") or "")
    if not key:
        raise AppError("缺少 key")
    valid = set(VALID_TOPIC_STATUS) | {"none", ""}
    if status not in valid:
        raise AppError(f"status 取值需为 {'/'.join(VALID_TOPIC_STATUS)} 或 none")
    app.store.set_topic_status(key, status, _now(app))
    return {"key": key, "status": status if status != "" else "none"}


def api_notes_put(app: TerminalApp, params: dict, body: dict) -> dict:
    key = str((body or {}).get("key") or "")
    notes = str((body or {}).get("notes") or "")
    if not key:
        raise AppError("缺少 key")
    app.store.set_note(key, notes, _now(app))
    return {"key": key, "saved": True}


def _now(app: TerminalApp) -> str:
    return app.ctx.get_time().strftime("%Y-%m-%d %H:%M:%S")


def _clamp_int(raw, default: int, low: int, high: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------

ROUTES = []


def route(method: str, pattern: str):
    compiled = re.compile(pattern)

    def deco(fn):
        ROUTES.append((method, compiled, fn))
        return fn

    return deco


route("GET", r"^/api/bootstrap$")(api_bootstrap)
route("GET", r"^/api/status$")(api_status)
route("GET", r"^/api/hotlists$")(api_hotlists)
route("GET", r"^/api/rss$")(api_news_stream)
route("GET", r"^/api/profile$")(api_profile_get)
route("POST", r"^/api/profile$")(api_profile_post)
route("POST", r"^/api/topic-status$")(api_topic_status_post)
route("PUT", r"^/api/notes$")(api_notes_put)


def register_task_routes():
    """M3/M4 由 scoring/research 模块注入剩余路由（score/top10、research、tasks）"""
    for module_name in ("trendradar.webapp.scoring", "trendradar.webapp.research"):
        try:
            module = __import__(module_name, fromlist=["register_routes"])
            register = getattr(module, "register_routes", None)
            if register:
                register()
        except Exception:  # noqa: BLE001 —— 未启用的能力不留路由
            pass


register_task_routes()


class TerminalHandler(BaseHTTPRequestHandler):
    server_version = "TrendRadarTerminal/" + __version__
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> TerminalApp:
        return self.server.app  # type: ignore[attr-defined]

    # ---------- 基础输出 ----------

    def log_message(self, fmt: str, *args):  # noqa: A003
        print(f"[选题终端] {self.command} {self.path}")

    def _send_bytes(self, status: int, content_type: str, payload: bytes, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, "application/json; charset=utf-8", body)

    def send_ok(self, data, status: int = 200) -> None:
        self.send_json({"ok": True, "data": data}, status)

    def send_fail(self, message: str, status: int = 400, code: str = "bad_request") -> None:
        self.send_json({"ok": False, "error": {"code": code, "message": message}}, status)

    # ---------- 请求处理 ----------

    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_POST(self):  # noqa: N802
        self._handle("POST")

    def do_PUT(self):  # noqa: N802
        self._handle("PUT")

    def _handle(self, method: str) -> None:
        path = unquote(urlparse(self.path).path)
        query = {k: v[-1] for k, v in parse_qs(urlparse(self.path).query).items()}

        try:
            if path.startswith("/api/"):
                self._dispatch_api(method, path, query)
            elif method == "GET":
                self._serve_static(path)
            else:
                self.send_fail("Not Found", status=404, code="not_found")
        except BrokenPipeError:
            pass
        except AppError as e:
            self.send_fail(str(e), status=e.status, code=e.code)
        except Exception as e:  # noqa: BLE001 —— 统一兜底，细节仅在 DEBUG 下暴露
            detail = f": {e}" if getattr(self.app, "debug", False) else ""
            self.send_fail(f"服务器内部错误{detail}", status=500, code="internal_error")

    def _dispatch_api(self, method: str, path: str, query: dict) -> None:
        body = None
        if method in ("POST", "PUT"):
            if self.app.token:
                token = self.headers.get("X-Terminal-Token", "")
                if not secrets_safe_equal(token, self.app.token):
                    raise AppError("未授权：请正确设置 X-Terminal-Token", status=401, code="unauthorized")
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                raise AppError("请求体过大", status=413, code="payload_too_large")
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    body = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise AppError("请求体不是合法 JSON", code="invalid_json")

        for route_method, pattern, fn in ROUTES:
            matched = pattern.match(path)
            if matched and route_method == method:
                result = fn(self.app, query, body, **matched.groupdict())
                self.send_ok(result)
                return
        self.send_fail("接口不存在", status=404, code="not_found")

    # ---------- 静态文件 ----------

    def _serve_static(self, path: str) -> None:
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        if ".." in rel:
            self.send_fail("Not Found", status=404, code="not_found")
            return
        candidate = (STATIC_ROOT / rel).resolve()
        try:
            candidate.relative_to(STATIC_ROOT.resolve())
        except ValueError:
            self.send_fail("Not Found", status=404, code="not_found")
            return
        if not candidate.is_file():
            self.send_fail("Not Found", status=404, code="not_found")
            return
        suffix = candidate.suffix.lower()
        content_type = CONTENT_TYPES.get(suffix, "application/octet-stream")
        with open(candidate, "rb") as fh:
            payload = fh.read()
        self._send_bytes(200, content_type, payload, cache="no-cache")


def secrets_safe_equal(provided: str, expected: str) -> bool:
    import hmac

    return hmac.compare_digest((provided or "").encode("utf-8"), expected.encode("utf-8"))


class TerminalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # Windows 上 SO_REUSEADDR 语义过宽，显式关闭


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def run(host: str = "", port: int = 0, open_browser: bool = False) -> None:
    """解析主机/端口并启动服务（阻塞直到 Ctrl+C）"""
    _make_output_utf8_safe()
    _load_env_files(["docker/.env", ".env"])

    env_host = os.environ.get("TERMINAL_HOST", "")
    env_port = os.environ.get("TERMINAL_PORT", "")

    if not host:
        host = env_host or ("0.0.0.0" if _in_docker() else "127.0.0.1")
    if not port:
        port = int(env_port) if env_port.isdigit() else 8090

    display_host = host if host != "0.0.0.0" else "127.0.0.1"
    print("=" * 56)
    print(f"  📡 TrendRadar 选题终端 v{__version__}")
    print(f"  地址: http://{display_host}:{port}/")
    if os.environ.get("TERMINAL_TOKEN"):
        print("  访问令牌: 已启用（写接口需携带 X-Terminal-Token）")
    print(f"  数据目录: output/  ·  终端数据: output/terminal/")
    print("=" * 56)

    app = TerminalApp()

    try:
        server = TerminalHTTPServer((host, port), TerminalHandler)
    except OSError as e:
        print(f"❌ 无法绑定 {host}:{port} — {e}")
        raise SystemExit(2)

    server.app = app  # type: ignore[attr-defined]

    if open_browser:
        import threading
        import webbrowser

        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
        print("[选题终端] 即将自动打开浏览器…")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[选题终端] 已停止")
    finally:
        server.server_close()


def _make_output_utf8_safe() -> None:
    """Windows GBK 控制台打不出 emoji 时降级替换，避免 banner 直接崩溃"""
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream is not None and hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 —— 任何失败都不阻塞启动
            pass


def _load_env_files(paths) -> None:
    """
    依次加载本地 .env 文件（如 docker/.env），使 AI_API_KEY 等配置
    在本地直接运行终端时同样生效（Docker 部署由 compose 注入，不受影响）。
    已存在的环境变量优先，文件不覆盖。
    """
    for path in paths:
        env_file = Path(path)
        if not env_file.is_file():
            continue
        try:
            for raw_line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if not key:
                    continue
                os.environ.setdefault(key, value)
        except OSError as e:
            print(f"[选题终端] 跳过 {path}: {e}")
            continue
        print(f"[选题终端] 已加载环境变量文件: {path}")


def _in_docker() -> bool:
    return os.environ.get("DOCKER_CONTAINER") == "true" or os.path.exists("/.dockerenv")
