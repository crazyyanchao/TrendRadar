# coding=utf-8
"""
选题终端 · TOP10 综合选题打分服务

流程：
  兴趣描述（终端个性化配置，内容直接注入）→ 复用 AIFilterPipeline 完成标签提取与逐条打分
  → 跨平台同事件合并（SequenceMatcher）→ 合成评分（匹配×热度×时效×在榜持久度）
  → 取前 10 → 快照落盘（output/terminal/top10.json）

无 AI key 或管线失败时降级为 keyword 引擎：基于关键词命中的本地排序，
兴趣维度以中性值 0.50 参与评分，前端徽章显示为低亮。
"""

import re
import threading
import time as _time
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from trendradar.ai.client import AIClient
from trendradar.ai.filter_pipeline import AIFilterPipeline
from trendradar.context import AppContext

from trendradar.webapp.reader import interests_hash, parse_dt, topic_key
from trendradar.webapp.store import TERMINAL_INTERESTS_FILE, TerminalStore
from trendradar.webapp.tasks import TaskHandle, TaskQueue

MERGE_THRESHOLD = 0.72          # 标题相似度合并阈值（SequenceMatcher ratio）
AUTO_RESCORE_INTERVAL = 1800    # 自动重打分冷却（秒），一天至多约 48 次、由快照新鲜度再收敛

# 合成评分权重：兴趣匹配 / 榜单热度 / 时效性 / 在榜持久度
W_MATCH, W_HOT, W_FRESH, W_PERSIST = 0.45, 0.25, 0.20, 0.10
KEYWORD_NEUTRAL_MATCH = 0.50    # keyword 引擎无 AI 匹配分时的中性值


def _aggr_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _hotness(best_rank: int) -> float:
    """rank1≈1、rank60≈0 的对数缓降；脱榜(rank<=0)给最低"""
    rank = max(int(best_rank or 0), 1)
    if rank >= 60:
        return 0.0
    import math

    return max(0.0, 1 - (math.log(max(rank, 1)) / math.log(60)))


class ScoringService:
    """TOP10 打分引擎；AI 分类任务经 TaskQueue 串行执行"""

    def __init__(
        self,
        ctx: AppContext,
        storage,
        store: TerminalStore,
        reader,
        tasks: TaskQueue,
    ):
        self.ctx = ctx
        self.storage = storage
        self.store = store
        self.reader = reader
        self.tasks = tasks
        self._auto_last = 0.0
        self._lock = threading.Lock()

    # ---------- 引擎可用性 ----------

    @property
    def engine(self) -> str:
        try:
            ai_config = self.ctx.config.get("AI", {})
            ok, _ = AIClient(ai_config).validate_config()
            return "ai" if ok else "keyword"
        except Exception:
            return "keyword"

    # ---------- 触发入口 ----------

    def trigger_rescore(self) -> Optional[str]:
        """提交重打分任务；返回 task_id（不可用时返回 None 由调用方提示）"""
        return self.tasks.submit("rescore", self.rescore_job)

    def maybe_auto_rescore(self, fetched_at: str) -> None:
        """
        随读取接口自动刷新：冷却已过且配置了兴趣时自动重打分。
        TERMINAL_AUTO_RESCORE=0 可整体关闭（server 层判断）。
        """
        if self.engine != "ai":
            return
        profile = self.store.load_profile()
        if not profile.get("interests"):
            return
        snapshot = self.store.load_top10_snapshot()
        now_ts = _time.time()
        with self._lock:
            if now_ts - self._auto_last < AUTO_RESCORE_INTERVAL:
                return
            generated_at = snapshot.get("generated_at")
            if generated_at:
                generated_dt = parse_dt(str(generated_at))
                if generated_dt is not None and (
                    self.reader.now().replace(tzinfo=None) - generated_dt.replace(tzinfo=None)
                ).total_seconds() < AUTO_RESCORE_INTERVAL:
                    return
            self._auto_last = now_ts
        print("[选题终端] 自动触发 TOP10 重打分…")
        self.trigger_rescore()

    def _profile_hash(self, profile: Dict[str, Any]) -> str:
        return interests_hash(profile.get("interests", ""))

    # ---------- 任务体（worker 线程执行） ----------

    def rescore_job(self, handle: TaskHandle) -> None:
        profile = self.store.load_profile()
        content = build_interests_text(profile)

        if not content.strip():
            # 未配置兴趣：清空快照，前端展示引导文案
            self._save_snapshot([], self.engine, "")
            return

        hash_value = self._profile_hash(profile)
        engine = self.engine
        candidates: List[Dict[str, Any]] = []

        if engine == "ai":
            handle.set_progress(0, 1)
            try:
                pipeline = AIFilterPipeline(
                    config=self.ctx.config,
                    storage_manager=self.storage,
                    get_time_func=self.ctx.get_time,
                )
                result = pipeline.run(
                    interests_file=TERMINAL_INTERESTS_FILE,
                    interests_content=content,
                )
            except Exception as e:  # noqa: BLE001 —— 降级到 keyword
                print(f"[选题终端] AI 打分失败，回退关键词引擎: {e}")
                result = None

            if result is not None and getattr(result, "success", False):
                candidates = self._candidates_from_ai_result(result)
            else:
                engine = "keyword"

        if engine == "keyword":
            candidates = self._candidates_from_keywords(profile.get("keywords", []))
            handle.set_progress(1, 3)

        groups = aggregate_candidates(candidates)
        date_str = self.reader.today()
        now = self.reader.now().replace(tzinfo=None)

        scored = []
        for group in groups:
            score = composite_score(group, now)
            item_out = group_to_item(group, date_str, score)
            scored.append(item_out)
        scored.sort(key=lambda x: (-x["score"], x["best_rank"]))

        items = []
        for idx, entry in enumerate(scored[:10], start=1):
            statuses = self.store.load_topic_status()
            entry["rank_no"] = idx
            saved = statuses.get(entry["key"]) or {}
            entry["topic_status"] = saved.get("status", "")
            items.append(entry)

        self._save_snapshot(items, engine, hash_value)
        print(f"[选题终端] TOP10 已生成：engine={engine} 候选 {len(candidates)} 条，合并后 {len(groups)} 组")

    def _save_snapshot(self, items: List[Dict[str, Any]], engine: str, hash_value: str) -> None:
        self.store.save_top10_snapshot({
            "generated_at": self.ctx.get_time().strftime("%Y-%m-%d %H:%M:%S"),
            "date": self.reader.today(),
            "interests_hash": hash_value,
            "engine": engine,
            "items": items,
        })

    def _candidates_from_ai_result(self, result) -> List[Dict[str, Any]]:
        candidates: List[Dict[str, Any]] = []
        for tag_group in result.tags:
            tag_name = tag_group.get("tag", "")
            tag_desc = tag_group.get("description", "")
            tag_priority = tag_group.get("priority", 9999)
            for item in tag_group.get("items", []):
                candidates.append({
                    "title": item.get("title", ""),
                    "source_id": item.get("source_id", ""),
                    "source_name": item.get("source_name", "") or item.get("source_id", ""),
                    "rank": int(item.get("rank") or 0),
                    "url": item.get("url", ""),
                    "mobile_url": item.get("mobile_url", ""),
                    "first_time": item.get("first_time", ""),
                    "last_time": item.get("last_time", ""),
                    "count": int(item.get("count") or 1),
                    "ranks": item.get("ranks") or [],
                    "relevance": float(item.get("relevance_score") or 0),
                    "tag": tag_name,
                    "tag_description": tag_desc,
                    "tag_priority": tag_priority,
                })
        return candidates

    def _candidates_from_keywords(self, keywords: List[str]) -> List[Dict[str, Any]]:
        """keyword 引擎：在榜条目中筛出命中任一关注词的标题做候选。
        未配置任何关键词时返回空（避免把全量榜单伪装成"个性化选题"）。"""
        normalized = [k.lower() for k in keywords if k]
        if not normalized:
            return []
        entries = self.reader.load_hotlist_titles()
        candidates: List[Dict[str, Any]] = []
        for pid, titles in entries.items():
            for title, info in titles.items():
                low = title.lower()
                hit = next((kw for kw in normalized if kw in low), None)
                if hit is None:
                    continue
                candidates.append({
                    "title": title,
                    "source_id": pid,
                    "source_name": info.get("source_name", pid),
                    "rank": int(info.get("rank") or 0),
                    "url": info.get("url", ""),
                    "mobile_url": info.get("mobile_url", ""),
                    "first_time": info.get("first_time", ""),
                    "last_time": info.get("last_time", ""),
                    "count": int(info.get("count") or 1),
                    "ranks": info.get("ranks") or [],
                    "relevance": KEYWORD_NEUTRAL_MATCH,
                    "tag": hit or "",
                    "tag_description": "",
                    "tag_priority": 9999,
                })
        return candidates

    # ---------- 读取 ----------

    def top10_payload(self) -> Dict[str, Any]:
        snapshot = self.store.load_top10_snapshot()
        if not snapshot:
            return {"generated_at": "", "date": "", "interests_hash": "", "engine": self.engine, "items": []}
        # 状态灯实时 overlay（避免每改一次状态就要重写快照）
        statuses = self.store.load_topic_status()
        for item in snapshot.get("items", []):
            saved = statuses.get(item["key"]) or {}
            item["topic_status"] = saved.get("status", "")
        snapshot["engine"] = snapshot.get("engine") or self.engine
        # 选题为空时不携带生成时间（空快照的 generated_at 不代表真正生成）
        if not snapshot.get("items"):
            snapshot["generated_at"] = ""
        return snapshot


# ═══════════════════════════════════════
#  合并 / 评分 / 输出组装（纯函数）
# ═══════════════════════════════════════

def build_interests_text(profile: Dict[str, Any]) -> str:
    """
    终端个性化兴趣文本：兴趣描述为主体；
    关注关键词并入正文一行参与标签提取（keywords 单独仅用于页面高亮）。
    """
    parts: List[str] = []
    interests = (profile.get("interests") or "").strip()
    if interests:
        parts.append(interests)
    keywords = [k for k in (profile.get("keywords") or []) if k]
    if keywords:
        parts.append("# 显式关注词：" + "、".join(keywords))
    return "\n".join(parts)


def aggregate_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    跨平台同事件聚合：同一平台内标题天然唯一；跨平台用相似度贪心聚类。
    代表成员 = 相关度最高者（keyword 引擎里即中性分中排名最优者）。
    """
    sorted_rows = sorted(
        candidates,
        key=lambda c: (-(c["relevance"] or 0), c["rank"] if c["rank"] > 0 else 99),
    )
    groups: List[List[Dict[str, Any]]] = []
    for row in sorted_rows:
        placed = False
        for group in groups:
            if _group_matches(group, row["title"]):
                group.append(row)
                placed = True
                break
        if not placed:
            groups.append([row])
    return groups


def _group_matches(group: List[Dict[str, Any]], title: str) -> bool:
    rep = group[0]["title"]
    if len(rep) >= 4 and len(title) >= 4:
        if rep == title or rep in title or title in rep:
            return True
    return _aggr_similarity(rep, title) >= MERGE_THRESHOLD


def composite_score(group: List[Dict[str, Any]], now) -> int:
    matched_items = [c for c in group if c.get("relevance")]
    match = max((c["relevance"] for c in matched_items), default=KEYWORD_NEUTRAL_MATCH)

    ranked = [c["rank"] for c in group if c["rank"] and c["rank"] > 0]
    best_rank = min(ranked) if ranked else 60
    hot = _hotness(best_rank)

    first_dts = [
        parse_dt(_first_full_time(c)) for c in group if c.get("first_time")
    ]
    first_dts = [dt for dt in first_dts if dt is not None]
    if first_dts:
        earliest = min(first_dts)
        hours = max(0.0, (now - earliest).total_seconds() / 3600)
    else:
        hours = 12.0
    fresh = _exp_decay(hours, 12.0)

    persist = min(max(c["count"] for c in group) / 5, 1.0)
    multi_bonus = min(len({c["source_id"] for c in group}) / 3, 1.0) * 0.05

    total = W_MATCH * match + W_HOT * min(1.0, hot + multi_bonus) + W_FRESH * fresh + W_PERSIST * persist
    return round(100 * total)


def _exp_decay(hours: float, half_life: float) -> float:
    import math

    if hours <= 0:
        return 1.0
    return math.exp(-hours / half_life)


def _first_full_time(candidate: Dict[str, Any]) -> str:
    raw = candidate.get("first_time") or ""
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        return raw
    return ""


def group_to_item(group: List[Dict[str, Any]], date_str: str, score: int) -> Dict[str, Any]:
    best = max(group, key=lambda c: ((c["relevance"] or 0), -(c["rank"] if c["rank"] > 0 else 99)))
    ranked = [c["rank"] for c in group if c["rank"] and c["rank"] > 0]
    tags_hit = [c for c in group if c.get("tag")]
    tags_hit.sort(key=lambda c: c.get("tag_priority", 9999))
    sources_by_platform: Dict[str, Dict[str, Any]] = {}
    for c in group:
        pid = c["source_id"]
        cur = sources_by_platform.get(pid)
        rank_here = c["rank"] if c["rank"] > 0 else 99
        if cur is None or rank_here < cur["rank"]:
            sources_by_platform[pid] = {
                "id": pid, "name": c["source_name"] or pid, "rank": c["rank"],
            }

    key = topic_key(date_str, best["title"])
    times = [
        dt for dt in (
            parse_dt(c.get("first_time") or "") for c in group
        ) if dt is not None
    ]
    last_times = [
        dt for dt in (
            parse_dt(c.get("last_time") or "") for c in group
        ) if dt is not None
    ]

    return {
        "key": key,
        "title": best["title"],
        "score": score,
        "event_type": (tags_hit[0]["tag"] if tags_hit else ""),
        "match_level": _level_of(best.get("relevance")),
        "match_score": round(float(best.get("relevance") or 0), 3),
        "sources": list(sources_by_platform.values()),
        "merged_count": len({c["source_id"] for c in group}),
        "best_rank": min(ranked) if ranked else 99,
        "max_count": max(c["count"] for c in group),
        "first_time": min(times).strftime("%H:%M") if times else "",
        "last_time": max(last_times).strftime("%H:%M") if last_times else "",
        "url": best.get("url", ""),
        "mobile_url": best.get("mobile_url", ""),
        "members": [
            {
                "title": c["title"], "source_id": c["source_id"],
                "source_name": c["source_name"], "rank": c["rank"], "url": c["url"],
                "tag": c.get("tag", ""), "relevance": c.get("relevance"),
            }
            for c in group[:8]
        ],
    }


def _level_of(relevance: Optional[float]) -> str:
    if not relevance:
        return ""
    if relevance >= 0.85:
        return "high"
    if relevance >= 0.70:
        return "mid"
    return "low"


def register_routes():
    """向 server 注册打分相关路由（server.register_task_routes 回调本模块导入时触发）"""
    from trendradar.webapp.server import route

    @route("POST", r"^/api/score/run$")
    def api_score_run(app, params, body):  # noqa: ANN001
        scorer = app.scorer
        if scorer is None:
            from trendradar.webapp.server import AppError

            raise AppError("AI 打分服务未启用（缺少模型或 API Key）", status=503, code="scorer_unavailable")
        return {"task_id": scorer.trigger_rescore()}

    @route("GET", r"^/api/score/top10$")
    def api_score_top10(app, params, body):  # noqa: ANN001
        scorer = app.scorer
        if scorer is None:
            payload = {"generated_at": "", "date": "", "interests_hash": "", "engine": "unavailable", "items": []}
            return payload
        return scorer.top10_payload()

    @route("GET", r"^/api/tasks/(?P<tid>[A-Za-z0-9_-]+)$")
    def api_task_get(app, params, body, tid=""):  # noqa: ANN001
        task = app.tasks.get(tid)
        if task is None:
            from trendradar.webapp.server import AppError

            raise AppError("任务不存在或已被清理", status=404, code="task_not_found")
        return task
