# coding=utf-8
"""
选题终端 · 单条选题 AI 深度研判

点击详情时按需生成（缓存优先）：
  key（稳定键）→ 反查当日同事件聚合上下文 → 填充研判提示词
  → AIClient(LiteLLM) 生成 → json-repair 解析 → 落盘 output/terminal/research/{hash}/{key}.json

"AI 研判不可变，人工笔记可变"：用户笔记存独立键空间（notes.json），
读取时由本模块与服务端合并返回，绝不写回研究缓存。
"""

import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from trendradar.ai.client import AIClient
from trendradar.ai.prompt_loader import load_prompt_template
from trendradar.webapp.reader import interests_hash, topic_key
from trendradar.webapp.scoring import MERGE_THRESHOLD, build_interests_text
from trendradar.webapp.server import AppError, route

PROMPT_FILE = "ai_topic_research_prompt.txt"
KEY_RE = re.compile(r"^[0-9a-f]{32}$")

_ELEMENT_TYPES = ("人物", "机构", "时间", "金额", "地点")


class ResearchService:
    """单条选题的按需研判；任务经 TaskQueue 串行执行"""

    def __init__(self, ctx, reader, store, scorer=None):
        self.ctx = ctx
        self.reader = reader
        self.store = store
        self.scorer = scorer

    # ---------- 兴趣与 hash ----------

    def _profile_interests(self) -> tuple[str, str]:
        """(interests_text, full_hash)；关键词并入正文，语义与打分引擎一致"""
        profile = self.store.load_profile()
        text = build_interests_text(profile)
        return text, interests_hash(text)

    # ---------- 选题上下文反查 ----------

    def find_topic_context(self, key: str) -> Optional[Dict[str, Any]]:
        """
        由稳定键反查当日选题上下文：
        精确命中该 key 的条目为种子标题，再以包含关系 / 相似度聚合跨平台同题成员。
        """
        date_str = self.reader.today()
        hot_map = self.reader.load_hotlist_titles()
        flat: List[Dict[str, Any]] = []

        for pid, titles in hot_map.items():
            for title, info in titles.items():
                flat.append({
                    "key": topic_key(date_str, title),
                    "source_id": pid,
                    "source_name": info.get("source_name", pid),
                    "title": title,
                    "url": info.get("url", ""),
                    "mobile_url": info.get("mobile_url", ""),
                    "rank": int(info.get("rank") or 0),
                    "count": int(info.get("count") or 1),
                    "first_time": info.get("first_time", ""),
                    "last_time": info.get("last_time", ""),
                })

        seed = next((row for row in flat if row["key"] == key), None)
        if seed is None:
            # TOP10 代表标题可能与任意平台原始标题不同：退化用快照里的成员列表兜底
            snapshot = self.store.load_top10_snapshot() or {}
            for item in snapshot.get("items", []):
                if item.get("key") != key:
                    continue
                member_titles = {m["title"] for m in item.get("members", [])}
                member_titles.add(item.get("title", ""))
                seed = next(
                    (row for row in flat if row["title"] in member_titles), None,
                )
                break
        if seed is None:
            return None

        members = [seed] + [
            row for row in flat
            if row["title"] != seed["title"] and _same_event(seed["title"], row["title"])
        ]

        # 附兴趣标签（仅当日已打分内容）
        index = self.reader.match_index(date_str)
        for m in members:
            hit = index.get(("hotlist", m["source_id"], m["title"]))
            m["tag"] = (hit or {}).get("tag", "")
            m["relevance"] = (hit or {}).get("relevance_score")

        members.sort(key=lambda m: (m["rank"] if m["rank"] > 0 else 99))
        return {"date": date_str, "key": key, "members": members}

    # ---------- 任务体 ----------

    def research_job(self, handle) -> None:
        payload = handle.payload or {}
        key = payload.get("key", "")
        context = payload.get("context") or {}
        interests_text, full_hash = self._profile_interests()

        system_prompt, user_template = load_prompt_template(PROMPT_FILE)
        if not system_prompt or not user_template:
            raise RuntimeError(f"提示词缺失：config/{PROMPT_FILE}")

        ai_analysis_cfg = self.ctx.config.get("AI_ANALYSIS") or {}
        language = str(ai_analysis_cfg.get("LANGUAGE", "中文")) if isinstance(ai_analysis_cfg, dict) else "中文"
        sources_payload = [
            {
                "platform": m["source_name"], "title": m["title"],
                "rank": m["rank"], "count": m["count"],
                "first_time": m.get("first_time", ""), "last_time": m.get("last_time", ""),
            }
            for m in context.get("members", [])
        ]
        tags_payload = sorted({m["tag"] for m in context.get("members", []) if m.get("tag")})

        user_prompt = (
            user_template
            .replace("{language}", language)
            .replace("{title}", context["members"][0]["title"])
            .replace("{sources_json}", _to_json_cn(sources_payload))
            .replace("{tags_json}", _to_json_cn(tags_payload))
            .replace("{interests}", interests_text or "(用户未填写兴趣描述)")
        )

        ai_config = self.ctx.config.get("AI", {})
        client = AIClient(ai_config)
        ok, err = client.validate_config()
        if not ok:
            raise RuntimeError(err)

        raw = client.chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.4,
        )
        research = parse_research_json(raw)

        references = []
        seen_urls = set()
        for m in context.get("members", []):
            if m.get("url") and m["url"] not in seen_urls:
                seen_urls.add(m["url"])
                references.append({"title": f"{m['source_name']} · {m['title']}", "url": m["url"]})
        if not research.get("references"):
            # 提示词要求模型返回空数组；由系统补充真实素材链接
            research["references"] = references[:6]

        self.store.save_research(full_hash, key, research)
        print(f"[选题终端] 深度研判完成并已缓存：{key[:8]}…")

    # ---------- 面向 API 的读取 ----------

    def get_cached(self, key: str):
        _, full_hash = self._profile_interests()
        return self.store.load_research(full_hash, key)


def _same_event(title_a: str, title_b: str) -> bool:
    if len(title_a) >= 4 and len(title_b) >= 4:
        if title_a in title_b or title_b in title_a:
            return True
    return SequenceMatcher(None, title_a, title_b).ratio() >= MERGE_THRESHOLD


def _to_json_cn(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)


# ═══════════════════════════════════════
#  JSON 解析与规范化
# ═══════════════════════════════════════

def parse_research_json(raw: str) -> Dict[str, Any]:
    """json-repair 优先；失败回退首个 {...} 子串解析；统一补全字段默认值"""
    import json

    try:
        from json_repair import repair_json

        parsed = repair_json(raw, return_objects=True)
    except Exception:  # noqa: BLE001 —— 未安装/异常时走兜底
        parsed = None
    if not isinstance(parsed, (dict, list)):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", raw, re.S)
            parsed = json.loads(match.group(0)) if match else None
    if isinstance(parsed, list) and parsed:
        parsed = parsed[0]
    if not isinstance(parsed, dict):
        raise ValueError("模型输出不是合法的研究 JSON")

    elements = parsed.get("key_elements") or []
    normalized_elements = []
    if isinstance(elements, list):
        for el in elements:
            if isinstance(el, dict) and el.get("value"):
                etype = str(el.get("type", "")).strip() or "要素"
                if etype not in _ELEMENT_TYPES:
                    etype = etype[:6]
                normalized_elements.append({"type": etype, "value": str(el["value"])})

    actionability = parsed.get("actionability") or {}
    exposure = parsed.get("exposure_forecast") or {}

    def _str_list(value) -> List[str]:
        if isinstance(value, str):
            return [v.strip() for v in value.splitlines() if v.strip()]
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
        return []

    hours = parsed.get("estimated_hours")
    try:
        hours = round(float(hours), 2) if hours is not None else None
    except (TypeError, ValueError):
        hours = None

    return {
        "summary": str(parsed.get("summary", "")).strip(),
        "key_elements": normalized_elements[:8],
        "actionability": {
            "level": str(actionability.get("level", "中")),
            "reason": str(actionability.get("reason", "")),
        },
        "exposure_forecast": {
            "tier": str(exposure.get("tier", "")),
            "basis": str(exposure.get("basis", "")),
        },
        "estimated_hours": hours,
        "match_explanation": str(parsed.get("match_explanation", "")).strip(),
        "angles": _str_list(parsed.get("angles"))[:5],
        "opportunities": _str_list(parsed.get("opportunities"))[:4],
        "risks": _str_list(parsed.get("risks"))[:4],
        "references": [],
    }


# ═══════════════════════════════════════
#  路由注册（server.register_task_routes 回调）
# ═══════════════════════════════════════

def register_routes():
    @route("POST", r"^/api/research$")
    def api_research_post(app, params, body):  # noqa: ANN001
        researcher = app.researcher
        key = str((body or {}).get("key") or "")
        refresh = bool((body or {}).get("refresh"))
        if not KEY_RE.match(key):
            raise AppError("key 不合法", code="invalid_key")
        if researcher is None:
            raise AppError(
                "AI 服务不可用：请在 config.yaml 配置 ai.api_key 后重启终端服务",
                status=503, code="ai_unavailable",
            )

        if not refresh:
            cached = researcher.get_cached(key)
            if cached:
                return {
                    "cached": True,
                    "research": cached,
                    "notes": app.store.get_note(key),
                }

        # 提交前排障：AI 配置缺失时直接给出可操作的错误，而不是等待注定失败的任务
        from trendradar.ai.client import AIClient

        ok, err = AIClient(app.ctx.config.get("AI", {})).validate_config()
        if not ok:
            raise AppError(
                f"AI 服务不可用：{err}",
                status=503, code="ai_unavailable",
            )

        context = researcher.find_topic_context(key)
        if context is None:
            raise AppError("未能在今日数据中找到该选题", status=404, code="topic_not_found")

        _, full_hash = researcher._profile_interests()  # noqa: SLF001 —— 同包内部装配
        task_id = app.tasks.submit(
            "research",
            researcher.research_job,
            dedupe_key=f"{full_hash}:{key}",
            payload={"key": key, "context": context},
        )
        return {"cached": False, "task_id": task_id}

    @route("GET", r"^/api/research/(?P<key>[0-9a-f]{32})$")
    def api_research_get(app, params, body, key=""):  # noqa: ANN001
        researcher = app.researcher
        cached = researcher.get_cached(key) if researcher else None
        return {
            "cached": bool(cached),
            "state": "done" if cached else "missing",
            "research": cached,
            "notes": app.store.get_note(key),
        }
