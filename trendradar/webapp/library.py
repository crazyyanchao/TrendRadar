# coding=utf-8
"""
选题终端 · 个人选题库（收藏池）

数据来源：
- 用户上传：粘贴多行文本批量入库（每行一条，自动去序号/列表符号）
- 系统选用：TOP10 卡片「入库」按钮（携带标题/标签/来源 key）

与 TOP10 评分、AI、爬虫完全解耦，仅操作 output/terminal/library.json。
去重身份：标题小写后的 md5；同标题（忽略大小写）重复入库自动跳过。
读-改-写全程持模块级锁（ThreadingHTTPServer 多线程下防丢更新），
TerminalStore 的锁仅覆盖单次读写调用，无法保证 handler 内序列原子性。
"""

import hashlib
import re
import threading
from typing import Any, Dict, List, Optional

from trendradar.webapp.server import AppError, _now, route

MIN_LIB_TITLE_LEN = 2
MAX_LIB_TITLE_LEN = 120
MAX_IMPORT_ITEMS = 100          # 单次批量导入新增上限
MAX_LIB_TAGS = 5                # 单条选题标签上限
MAX_LIB_TAG_LEN = 30            # 单标签长度上限
MAX_LIB_URL_LEN = 500
VALID_LIB_STATUS = ("", "pending", "doing", "done")
LIB_ITEM_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# 与 keywords.py _parse_keywords_lines 同款行清洗：列表符号 → 数字序号 → 包裹标点
_LINE_BULLET_RE = re.compile(r"^[\-\*•·○\s]+")
_LINE_NUM_RE = re.compile(r"^\d+[\.、)．:]+\s*")

_lib_lock = threading.Lock()    # 读-改-写互斥：并发请求下防丢更新（keywords.py 同款模式）


def _item_id(title: str) -> str:
    """标题（小写）的 md5 —— 大小写不敏感去重的稳定身份"""
    return hashlib.md5(title.lower().encode("utf-8")).hexdigest()


def _sanitize_title(raw: Any) -> str:
    """清洗单行标题：去行首列表符号/序号/包裹引号与杂散标点；长度 2~120 否则返回 ''"""
    text = str(raw or "").strip()
    if not text:
        return ""
    text = _LINE_BULLET_RE.sub("", text).strip()
    text = _LINE_NUM_RE.sub("", text).strip()
    text = text.strip("\"'“”[]`，,。;；:：")
    if len(text) < MIN_LIB_TITLE_LEN or len(text) > MAX_LIB_TITLE_LEN:
        return ""
    return text


def _clean_tags(raw: Any) -> List[str]:
    tags: List[str] = []
    for tag in (raw or []):
        t = str(tag or "").strip()
        if t and t not in tags:
            tags.append(t[:MAX_LIB_TAG_LEN])
    return tags[:MAX_LIB_TAGS]


def _build_item(
    title: str,
    origin: str,
    now_str: str,
    source_key: str = "",
    tags: Optional[List[str]] = None,
    url: str = "",
) -> Dict[str, Any]:
    return {
        "id": _item_id(title),
        "title": title,
        "origin": "system" if origin == "system" else "user",
        "source_key": source_key,
        "tags": _clean_tags(tags),
        "url": str(url or "")[:MAX_LIB_URL_LEN],
        "status": "",
        "created_at": now_str,
        "updated_at": now_str,
    }


def _sorted_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """新→旧排序（created_at 为主、updated_at 兜底，同秒保持插入序）"""
    return sorted(
        items,
        key=lambda it: (it.get("created_at", ""), it.get("updated_at", "")),
        reverse=True,
    )


# ═══════════════════════════════════════
#  路由注册（server.register_task_routes 回调）
# ═══════════════════════════════════════

def register_routes():
    @route("GET", r"^/api/library$")
    def api_library_get(app, params, body):  # noqa: ANN001
        return {"items": _sorted_items(app.store.load_library())}

    @route("POST", r"^/api/library/import$")
    def api_library_import(app, params, body):  # noqa: ANN001
        text = str((body or {}).get("text") or "")
        if not text.strip():
            raise AppError("缺少 text 参数", code="bad_request")

        added: List[Dict[str, Any]] = []
        skipped = 0
        invalid = 0
        truncated = False
        with _lib_lock:
            items = app.store.load_library()
            existing_ids = {it.get("id") for it in items}
            for raw_line in text.splitlines():
                title = _sanitize_title(raw_line)
                if not title:
                    invalid += 1
                    continue
                item_id = _item_id(title)
                if item_id in existing_ids:
                    skipped += 1
                    continue
                if len(added) >= MAX_IMPORT_ITEMS:
                    skipped += 1
                    truncated = True
                    continue
                item = _build_item(title, "user", _now(app))
                items.append(item)
                existing_ids.add(item_id)
                added.append(item)
            if added:
                app.store.save_library(items)
        return {
            "added": len(added),
            "skipped": skipped,
            "invalid": invalid,
            "truncated": truncated,
            "items": added,
        }

    @route("POST", r"^/api/library/items$")
    def api_library_add(app, params, body):  # noqa: ANN001
        title = _sanitize_title((body or {}).get("title"))
        if not title:
            raise AppError("title 不合法（需 2~120 字符）", code="invalid_title")
        source_key = str((body or {}).get("source_key") or "")
        tags = (body or {}).get("tags")
        url = str((body or {}).get("url") or "")

        with _lib_lock:
            items = app.store.load_library()
            item_id = _item_id(title)
            for it in items:
                if it.get("id") == item_id:
                    return {"duplicate": True, "item": it}
            item = _build_item(
                title,
                "system" if source_key else "user",
                _now(app),
                source_key=source_key,
                tags=tags,
                url=url,
            )
            items.append(item)
            app.store.save_library(items)
        return {"duplicate": False, "item": item}

    @route("PUT", r"^/api/library/items/(?P<item_id>[0-9a-f]{32})$")
    def api_library_update(app, params, body, item_id=""):  # noqa: ANN001
        status = str((body or {}).get("status") or "")
        if status not in VALID_LIB_STATUS:
            raise AppError("status 取值需为 pending/doing/done 或留空", code="invalid_status")
        with _lib_lock:
            items = app.store.load_library()
            for it in items:
                if it.get("id") == item_id:
                    it["status"] = status
                    it["updated_at"] = _now(app)
                    app.store.save_library(items)
                    return {"item": it}
        raise AppError("选题不存在", status=404, code="lib_item_not_found")

    @route("DELETE", r"^/api/library/items/(?P<item_id>[0-9a-f]{32})$")
    def api_library_delete(app, params, body, item_id=""):  # noqa: ANN001
        with _lib_lock:
            items = app.store.load_library()
            remaining = [it for it in items if it.get("id") != item_id]
            if len(remaining) == len(items):
                raise AppError("选题不存在", status=404, code="lib_item_not_found")
            app.store.save_library(remaining)
        return {"deleted": item_id}
