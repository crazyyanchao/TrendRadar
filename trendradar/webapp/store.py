# coding=utf-8
"""
选题终端持久化与只读查询模块

- TerminalStore: output/terminal/ 下 JSON 文件的原子读写（profile / 选题状态 / 笔记 / 研判缓存）
  所有写操作只落在本目录，与爬虫进程的 output/news、output/rss 互不竞争。
- DailyDbReader: 以只读模式（URI mode=ro）打开按天分库的 SQLite，
  查询抓取记录与各平台抓取状态，用于顶栏数据源状态灯。
"""

import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

# 终端兴趣集在 ai_filter_tags 表中的隔离命名（与 cron 管线的 ai_interests.txt 同表共存）
TERMINAL_INTERESTS_FILE = "topic_terminal.txt"

DEFAULT_PROFILE: Dict[str, Any] = {
    "nickname": "隔岸观火",
    "keywords": [],
    "interests": "",
    "source_prefs": {},
}

VALID_TOPIC_STATUS = ("recommended", "watched", "done")


class TerminalStore:
    """线程安全的 JSON 原子读写（threading.Lock + os.replace）"""

    PROFILE = "profile.json"
    TOPIC_STATUS = "topics_status.json"
    NOTES = "notes.json"
    TOP10 = "top10.json"

    def __init__(self, root: str = "output/terminal"):
        self.root = Path(root)
        self._lock = threading.Lock()

    # ---------- 底层 ----------

    def _path(self, name: str) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def _load_json_file(path: Path, default: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return default

    def _read_json(self, name: str, default: Any) -> Any:
        with self._lock:
            return self._load_json_file(self._path(name), default)

    def _write_json(self, name: str, data: Any) -> None:
        with self._lock:
            path = self._path(name)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8",
            )
            os.replace(tmp, path)

    # ---------- 用户个性化配置 ----------

    def load_profile(self) -> Dict[str, Any]:
        saved = self._read_json(self.PROFILE, {})
        profile = dict(DEFAULT_PROFILE)
        profile.update({k: v for k, v in saved.items() if k != "updated_at"})
        return profile

    def saved_interests_hash(self) -> str:
        """profile.json 中记录的上次打分用兴趣 hash（变更检测基准）"""
        return self._read_json(self.PROFILE, {}).get("interests_hash", "")

    def save_profile(
        self,
        profile: Dict[str, Any],
        now_str: str,
        interests_hash: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload = dict(DEFAULT_PROFILE)
        payload.update({
            "nickname": str(profile.get("nickname") or DEFAULT_PROFILE["nickname"]).strip() or DEFAULT_PROFILE["nickname"],
            "keywords": [str(k).strip() for k in (profile.get("keywords") or []) if str(k).strip()],
            "interests": str(profile.get("interests") or "").strip(),
            "source_prefs": profile.get("source_prefs") or {},
        })
        if interests_hash is not None:
            payload["interests_hash"] = interests_hash
        elif saved := self._read_json(self.PROFILE, {}):
            # 未显式给出时保留原值，作为变更检测基准
            if "interests_hash" in saved:
                payload["interests_hash"] = saved["interests_hash"]
        payload["updated_at"] = now_str
        self._write_json(self.PROFILE, payload)
        return payload

    # ---------- 选题状态（推荐/待看/已阅） ----------

    def load_topic_status(self) -> Dict[str, Dict[str, str]]:
        return self._read_json(self.TOPIC_STATUS, {})

    def set_topic_status(self, key: str, status: str, now_str: str) -> bool:
        """status 取 VALID_TOPIC_STATUS 之一；传入其他值视为清除"""
        data = self.load_topic_status()
        entry_key = str(key or "")
        if not entry_key:
            return False
        if status in VALID_TOPIC_STATUS:
            data[entry_key] = {"status": status, "updated_at": now_str}
        else:
            data.pop(entry_key, None)
        self._write_json(self.TOPIC_STATUS, data)
        return True

    # ---------- 用户研判笔记 ----------

    def load_notes(self) -> Dict[str, Dict[str, str]]:
        return self._read_json(self.NOTES, {})

    def get_note(self, key: str) -> str:
        entry = self.load_notes().get(str(key)) or {}
        return entry.get("notes", "")

    def set_note(self, key: str, notes: str, now_str: str) -> bool:
        entry_key = str(key or "")
        if not entry_key:
            return False
        data = self.load_notes()
        text = str(notes or "")
        if text.strip():
            data[entry_key] = {"notes": text, "updated_at": now_str}
        else:
            data.pop(entry_key, None)
        self._write_json(self.NOTES, data)
        return True

    # ---------- TOP10 快照 ----------

    def load_top10_snapshot(self) -> Dict[str, Any]:
        return self._read_json(self.TOP10, {})

    def save_top10_snapshot(self, snapshot: Dict[str, Any]) -> None:
        self._write_json(self.TOP10, snapshot)

    # ---------- AI 研判缓存（按兴趣 hash 分目录，换兴趣后自然失配） ----------

    def research_path(self, interests_hash: str, key: str) -> Path:
        hash_dir = "".join(ch for ch in interests_hash if ch.isalnum())[:16] or "default"
        return self._path(str(Path("research") / hash_dir / f"{key}.json"))

    def load_research(self, interests_hash: str, key: str) -> Optional[Dict[str, Any]]:
        return self._load_json_file(self.research_path(interests_hash, key), None)

    def save_research(self, interests_hash: str, key: str, research: Dict[str, Any]) -> None:
        path = self.research_path(interests_hash, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(research, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        os.replace(tmp, path)


class DailyDbReader:
    """以只读 URI 模式访问按天分库的 SQLite（每次查询即开即用，避免跨线程连接共享）"""

    def __init__(self, data_dir: str = "output"):
        self.data_dir = Path(data_dir)

    def available_dates(self, db_type: str = "news") -> List[str]:
        """扫描目录下已有的日期库名（YYYY-MM-DD.db），倒序返回"""
        db_dir = self.data_dir / db_type
        if not db_dir.exists():
            return []
        dates = [
            f.stem for f in db_dir.glob("*.db")
            if len(f.stem) == 10 and f.stem[4] == "-" and f.stem[7] == "-"
        ]
        return sorted(dates, reverse=True)

    def _connect_ro(self, date: str, db_type: str) -> Optional[sqlite3.Connection]:
        db_path = self.data_dir / db_type / f"{date}.db"
        if not db_path.exists():
            return None
        uri = f"file:{db_path.resolve().as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def _query_ro(self, date: str, db_type: str, sql: str, params: tuple = ()) -> List[tuple]:
        """执行一次只读查询；并发写冲突时重试一次"""
        for attempt in range(2):
            conn = None
            try:
                conn = self._connect_ro(date, db_type)
                if conn is None:
                    return []
                cursor = conn.execute(sql, params)
                return cursor.fetchall()
            except sqlite3.OperationalError:
                if attempt == 0:
                    continue
                return []
            except sqlite3.Error:
                return []
            finally:
                if conn is not None:
                    conn.close()
        return []

    def count_items(self, date: str, db_type: str = "news", table: str = "news_items") -> int:
        """统计某天某库指定表的行数（0 表示空滚动库/无数据）"""
        rows = self._query_ro(date, db_type, f"SELECT COUNT(*) FROM {table}")
        return rows[0][0] if rows else 0

    # ---------- 抓取状态（状态灯数据源） ----------

    def get_crawl_summary(self, date: str) -> Dict[str, Any]:
        """
        返回当天热榜抓取概况：
        {last_crawl: "HH:MM"|"", ok: int, failed: int, total: int,
         failed_ids: [...], sample_total: int}
        """
        rows = self._query_ro(
            date, "news",
            "SELECT id, crawl_time, total_items FROM crawl_records ORDER BY id DESC LIMIT 1",
        )
        if not rows:
            return {"last_crawl": "", "ok": 0, "failed": 0, "total": 0, "failed_ids": [], "sample_total": 0}
        record_id, crawl_time, sample_total = rows[0][0], rows[0][1] or "", rows[0][2] or 0

        status_rows = self._query_ro(
            date, "news",
            "SELECT platform_id, status FROM crawl_source_status WHERE crawl_record_id = ?",
            (record_id,),
        )
        ok = sum(1 for _, s in status_rows if s == "success")
        failed_ids = [pid for pid, s in status_rows if s != "success"]
        return {
            "last_crawl": crawl_time[:5],
            "ok": ok,
            "failed": len(failed_ids),
            "total": len(status_rows),
            "failed_ids": failed_ids,
            "sample_total": int(sample_total or 0),
        }

    def get_rss_crawl_summary(self, date: str) -> Dict[str, Any]:
        """同上，针对 RSS 库"""
        rows = self._query_ro(
            date, "rss",
            "SELECT id, crawl_time, total_items FROM rss_crawl_records ORDER BY id DESC LIMIT 1",
        )
        if not rows:
            return {"last_crawl": "", "ok": 0, "failed": 0, "total": 0, "failed_ids": []}
        record_id, crawl_time = rows[0][0], rows[0][1] or ""

        status_rows = self._query_ro(
            date, "rss",
            "SELECT feed_id, status FROM rss_crawl_status WHERE crawl_record_id = ?",
            (record_id,),
        )
        ok = sum(1 for _, s in status_rows if s == "success")
        failed_ids = [fid for fid, s in status_rows if s != "success"]
        return {
            "last_crawl": crawl_time[:5],
            "ok": ok,
            "failed": len(failed_ids),
            "total": len(status_rows),
            "failed_ids": failed_ids,
        }
