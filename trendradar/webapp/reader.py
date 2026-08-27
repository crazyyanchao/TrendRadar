# coding=utf-8
"""
选题终端数据读取编排

封装 StorageManager 的只读访问，为 API 组装：
- 热榜并列流（多平台当前在榜）
- 权威头条时间流（RSS + 财经类热榜合并）
- 兴趣匹配索引（当日 ai_filter_results 按 标题+来源 的最优命中）
- 数据源状态灯概况
"""

import hashlib
from datetime import datetime
from typing import Any, Dict, List, Optional

from trendradar.context import AppContext
from trendradar.storage.base import NewsData, RSSData

from trendradar.webapp.store import DailyDbReader, TERMINAL_INTERESTS_FILE

# 权威财经头条流使用的热榜平台（与 RSS 时间流合并展示）
AUTHORITY_PLATFORMS = ["wallstreetcn-hot", "cls-hot", "thepaper", "ifeng"]

# 匹配徽章阈值：>=HIGH 为高匹配（🔥 高亮），>= MID 为中，其余低
MATCH_HIGH_THRESHOLD = 0.85
MATCH_MID_THRESHOLD = 0.70


def topic_key(date: str, title: str) -> str:
    """跨请求稳定的选题键（news_items.id 按天重建，不可持久化引用）"""
    raw = f"{date}|{title}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def interests_hash(content: str) -> str:
    """
    终端个性化兴趣描述的变更检测 hash。
    与 trendradar.ai.filter.AIFilter.compute_interests_hash 同一算法
    （忽略注释行与空白行，取归一化文本 md5）；filename 固定
    topic_terminal.txt 形成终端独立命名空间（见 store.TERMINAL_INTERESTS_FILE）。
    """
    lines = [line.strip() for line in (content or "").strip().splitlines()]
    normalized = "\n".join(line for line in lines if line and not line.startswith("#"))
    digest = hashlib.md5(normalized.encode("utf-8")).hexdigest()
    return f"{TERMINAL_INTERESTS_FILE}:{digest}"


def parse_dt(value: str) -> Optional[datetime]:
    """尽力解析 'YYYY-MM-DD HH:MM[:SS]' 或 ISO 时间字符串"""
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def match_level(score: float) -> str:
    if score >= MATCH_HIGH_THRESHOLD:
        return "high"
    if score >= MATCH_MID_THRESHOLD:
        return "mid"
    return "low"


class TerminalReader:
    """为 web API 提供只读数据装配；线程内即开即用，不持有长期连接"""

    def __init__(self, ctx: AppContext):
        self.ctx = ctx
        self.storage = ctx.get_storage_manager()
        self.db = DailyDbReader()

    # ---------- 基础信息 ----------

    @property
    def timezone(self) -> str:
        return self.ctx.timezone

    def now(self) -> datetime:
        return self.ctx.get_time()

    def today(self) -> str:
        # 调试用：TERMINAL_DATE=YYYY-MM-DD 可将终端整体视作指定日期（用于历史数据演示）
        import os

        override = os.environ.get("TERMINAL_DATE", "")
        if len(override) == 10 and override[4] == "-" and override[7] == "-":
            return override
        return self.ctx.format_date()

    def configured_platforms(self) -> List[Dict[str, str]]:
        return [{"id": p["id"], "name": p.get("name", p["id"])} for p in self.ctx.platforms]

    def configured_feeds(self) -> List[Dict[str, str]]:
        feeds = [
            {"id": f["id"], "name": f.get("name", f["id"])}
            for f in self.ctx.rss_feeds
            if f.get("enabled", True)
        ]
        return feeds

    def last_available_date(self) -> str:
        dates = self.db.available_dates("news")
        return dates[0] if dates else ""

    # ---------- 热榜并列流 ----------

    def hotlists(
        self,
        platforms: Optional[List[str]] = None,
        limit: int = 30,
        date: Optional[str] = None,
    ) -> Dict[str, Any]:
        resolved_date = date or self.today()
        news = self._load_latest_crawl(resolved_date)
        wanted = platforms or self.ctx.platform_ids
        matches = self.match_index(resolved_date)

        groups = []
        for pid in wanted:
            name = pid
            items: List[Dict[str, Any]] = []
            if news is not None:
                name = news.id_to_name.get(pid, pid)
                raw_list = sorted(
                    news.items.get(pid, []),
                    key=lambda x: (x.rank if x.rank > 0 else 99),
                )
                for item in raw_list[: max(1, limit)]:
                    hit = matches.get(("hotlist", pid, item.title))
                    items.append({
                        "key": topic_key(resolved_date, item.title),
                        "title": item.title,
                        "rank": item.rank,
                        "url": item.url,
                        "mobile_url": item.mobile_url,
                        "first_time": item.first_time,
                        "count": item.count,
                        "match": self._badge(hit),
                        # topic_status 由 server 层 overlay，这里不带
                    })
            groups.append({"id": pid, "name": name, "items": items})

        return {
            "date": resolved_date,
            "fetched_at": news.crawl_time if news is not None else "",
            "platforms": groups,
        }

    def load_hotlist_titles(self, date: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
        """当日全量在榜标题映射 {(platform_id): {title: item_dict}}，供状态灯外的装配复用"""
        resolved_date = date or self.today()
        news = self._load_today_all(resolved_date)
        result: Dict[str, Dict[str, Any]] = {}
        if news is None:
            return result
        for pid, items in news.items.items():
            result[pid] = {
                item.title: item.to_dict() | {"source_id": pid, "source_name": item.source_name}
                for item in items
            }
        return result

    # ---------- 权威头条时间流 ----------

    def news_stream(
        self,
        hours: int = 24,
        limit: int = 80,
        date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """RSS 条目 + 权威平台热榜条目合并的时间倒序流"""
        resolved_date = date or self.today()
        now = self.now()
        matches = self.match_index(resolved_date)

        entries: List[Dict[str, Any]] = []

        # RSS 部分
        rss = self._load_rss_day(resolved_date)
        if rss is not None:
            for feed_id, feed_items in rss.items.items():
                feed_name = rss.id_to_name.get(feed_id, feed_id)
                for item in feed_items:
                    entries.append({
                        "key": topic_key(resolved_date, item.title),
                        "source_type": "rss",
                        "feed_id": feed_id,
                        "source_id": feed_id,
                        "source_name": feed_name,
                        "title": item.title,
                        "url": item.url,
                        "published_at": item.published_at,
                        "summary_snippet": (item.summary or "")[:80],
                        "sort_ts": parse_dt(item.published_at) or self._fallback_dt(resolved_date, item.crawl_time),
                        "match": self._badge(matches.get(("rss", feed_id, item.title))),
                    })

        # 权威平台热榜部分
        try:
            news = self._load_today_all(resolved_date)
        except Exception:
            news = None
        if news is not None:
            for pid in AUTHORITY_PLATFORMS:
                source_name = news.id_to_name.get(pid, pid)
                for item in news.items.get(pid, []):
                    sort_ts = self._fallback_dt(resolved_date, item.last_time or item.first_time)
                    entries.append({
                        "key": topic_key(resolved_date, item.title),
                        "source_type": "hotlist",
                        "feed_id": "",
                        "source_id": pid,
                        "source_name": source_name,
                        "title": item.title,
                        "url": item.url,
                        "published_at": item.last_time or item.first_time,
                        "summary_snippet": "",
                        "sort_ts": sort_ts,
                        "match": self._badge(matches.get(("hotlist", pid, item.title))),
                    })

        # 时间窗过滤 + 排序
        if hours > 0:
            floor = self._as_naive(now).timestamp() - hours * 3600
            entries = [
                e for e in entries
                if e["sort_ts"] is None or self._as_naive(e["sort_ts"]).timestamp() >= floor
            ]
        has_ts = [e for e in entries if e["sort_ts"] is not None]
        no_ts = [e for e in entries if e["sort_ts"] is None]
        no_ts.sort(key=lambda e: (e["published_at"] or ""), reverse=True)
        has_ts.sort(key=lambda e: self._as_naive(e["sort_ts"]), reverse=True)

        ordered = ([{
            **e,
            "published_at": self._display_time(e["sort_ts"]),
        } for e in has_ts] + no_ts)[: max(1, limit)]

        for entry in ordered:
            entry.pop("sort_ts", None)

        return {
            "date": resolved_date,
            "since": self._display_time(datetime.fromtimestamp(now.timestamp() - hours * 3600)) if hours > 0 else "",
            "items": ordered,
        }

    # ---------- 兴趣匹配索引 ----------

    def match_index(self, date: Optional[str] = None) -> Dict[tuple, Dict[str, Any]]:
        """
        当日 ai_filter_results 最优命中索引。
        键: (source_type, source_id, title)；值: 含 relevance_score/tag/tag_description/tag_priority。
        interests_file 固定使用终端命名空间（见 store.TERMINAL_INTERESTS_FILE）。
        """
        resolved_date = date or self.today()
        index: Dict[tuple, Dict[str, Any]] = {}
        try:
            rows = self.storage.get_active_ai_filter_results(
                date=resolved_date, interests_file=TERMINAL_INTERESTS_FILE,
            )
        except Exception:
            return index
        for row in rows:
            key = (row.get("source_type", ""), row.get("source_id", ""), row.get("title", ""))
            current = index.get(key)
            if current is None or row.get("relevance_score", 0) > current.get("relevance_score", 0):
                index[key] = row
        return index

    def has_ai_results_for(self, interests_file: str = TERMINAL_INTERESTS_FILE) -> bool:
        try:
            rows = self.storage.get_active_ai_filter_results(
                date=self.today(), interests_file=interests_file,
            )
        except Exception:
            return False
        return bool(rows)

    # ---------- 状态灯 ----------

    def status_summary(self, date: Optional[str] = None) -> Dict[str, Any]:
        resolved_date = date or self.today()
        crawl = self.db.get_crawl_summary(resolved_date)
        rss = self.db.get_rss_crawl_summary(resolved_date)
        level = self._status_level(crawl, rss, resolved_date)
        return {
            "date": resolved_date,
            "level": level,
            "platform_ok": crawl["ok"],
            "platform_total": crawl["total"],
            "platform_failed_ids": crawl["failed_ids"],
            "rss_ok": rss["ok"],
            "rss_total": rss["total"],
            "last_crawl": crawl["last_crawl"] or rss["last_crawl"],
            "last_available_date": self.last_available_date(),
        }

    def _status_level(self, crawl: Dict[str, Any], rss: Dict[str, Any], date: str) -> str:
        if not crawl["total"]:
            # 当天无抓取记录：看是否根本还没有任何历史数据
            return "red"
        last_dt = parse_dt(f"{date} {crawl['last_crawl']}") if crawl["last_crawl"] else None
        hours_since = 999.0
        if last_dt is not None:
            delta = self._as_naive(self.now()) - self._as_naive(last_dt)
            hours_since = delta.total_seconds() / 3600
        if hours_since > 24:
            return "red"
        if hours_since <= 1.5 and not crawl["failed"] and (not rss["total"] or not rss["failed"]):
            return "green"
        return "yellow"

    # ---------- 内部工具 ----------

    def _load_latest_crawl(self, date: str) -> Optional[NewsData]:
        try:
            return self.storage.get_latest_crawl_data(date=date)
        except Exception:
            return None

    def _load_today_all(self, date: str) -> Optional[NewsData]:
        try:
            return self.storage.get_today_all_data(date=date)
        except Exception:
            return None

    def _load_rss_day(self, date: str) -> Optional[RSSData]:
        try:
            return self.storage.get_rss_data(date=date)
        except Exception:
            return None

    @staticmethod
    def _badge(hit: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not hit:
            return None
        score = round(float(hit.get("relevance_score") or 0), 3)
        return {
            "level": match_level(score),
            "score": score,
            "tag": hit.get("tag") or "",
            "tag_description": hit.get("tag_description") or "",
        }

    def _fallback_dt(self, date: str, hhmm: str) -> Optional[datetime]:
        if not hhmm:
            return None
        return parse_dt(f"{date} {hhmm}")

    @staticmethod
    def _as_naive(dt: datetime) -> datetime:
        if dt.tzinfo is not None:
            return dt.replace(tzinfo=None)
        return dt

    @staticmethod
    def _display_time(dt: Optional[datetime]) -> str:
        if dt is None:
            return ""
        if dt.tzinfo is not None:
            return dt.isoformat(timespec="seconds")
        return dt.strftime("%Y-%m-%d %H:%M:%S")
