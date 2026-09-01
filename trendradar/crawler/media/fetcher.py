# coding=utf-8
"""
媒体信源抓取器（site 类型自建解析器统一调度）

与 RSSFetcher 同构：输入 MediaSourceConfig 列表，输出 RSSData ——
下游（存储 rss_items 表 / webapp 时间流 / 状态灯 / MCP）完全无感复用。
"""

import random
import time
from typing import Dict, List, Optional, Tuple

import requests

from trendradar.crawler.media.base import MediaSourceConfig, SiteParser
from trendradar.crawler.media.registry import get_parser
from trendradar.crawler.rss.parser import ParsedRSSItem
from trendradar.storage.base import RSSData, RSSItem
from trendradar.utils.time import DEFAULT_TIMEZONE, get_configured_time


class MediaFetcher:
    """媒体信源抓取器"""

    def __init__(
        self,
        sources: List[MediaSourceConfig],
        request_interval: int = 1500,
        timeout: int = 20,
        use_proxy: bool = False,
        proxy_url: str = "",
        timezone: str = DEFAULT_TIMEZONE,
    ):
        self.sources = [s for s in sources if s.enabled]
        self.request_interval = request_interval
        self.timeout = timeout
        self.use_proxy = use_proxy
        self.proxy_url = proxy_url
        self.timezone = timezone
        self.session = self._create_session()

    def _create_session(self) -> requests.Session:
        """创建请求会话（与 RSSFetcher 一致）"""
        session = requests.Session()
        session.headers.update({
            "User-Agent": "TrendRadar/2.0 Media Reader (https://github.com/trendradar)",
            "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        })
        if self.use_proxy and self.proxy_url:
            session.proxies = {
                "http": self.proxy_url,
                "https": self.proxy_url,
            }
        return session

    def fetch_source(self, source: MediaSourceConfig) -> Tuple[List[ParsedRSSItem], Optional[str]]:
        """查 registry 取解析器并抓取；未知解析器返回错误"""
        parser_cls = get_parser(source.parser_id)
        if parser_cls is None:
            return [], f"未知解析器: {source.parser_id}"
        parser = parser_cls(source, self.session, self.timezone, self.timeout)
        return parser.fetch()

    def fetch_all(self) -> RSSData:
        """
        抓取所有媒体信源

        Returns:
            RSSData 对象（复用 RSS 存储/展示链路）
        """
        all_items: Dict[str, List[RSSItem]] = {}
        id_to_name: Dict[str, str] = {}
        failed_ids: List[str] = []

        now = get_configured_time(self.timezone)
        crawl_time = now.strftime("%H:%M")
        crawl_date = now.strftime("%Y-%m-%d")

        print(f"[媒体] 开始抓取 {len(self.sources)} 个媒体信源...")

        for i, source in enumerate(self.sources):
            # 请求间隔（带随机波动）
            if i > 0:
                interval = self.request_interval / 1000
                jitter = random.uniform(-0.2, 0.2) * interval
                time.sleep(interval + jitter)

            id_to_name[source.id] = source.name

            try:
                parsed_items, error = self.fetch_source(source)
            except Exception as e:  # 解析器异常兜底，保证失败隔离
                parsed_items, error = [], f"未知错误: {e}"

            if error:
                failed_ids.append(source.id)
                print(f"[媒体] {source.name}: {error}")
                continue

            items: List[RSSItem] = []
            for parsed in parsed_items:
                items.append(RSSItem(
                    title=parsed.title,
                    feed_id=source.id,
                    feed_name=source.name,
                    url=parsed.url,
                    guid=parsed.guid or "",
                    published_at=parsed.published_at or "",
                    summary=parsed.summary or "",
                    author=parsed.author or "",
                    crawl_time=crawl_time,
                    first_time=crawl_time,
                    last_time=crawl_time,
                    count=1,
                ))
            all_items[source.id] = items
            print(f"[媒体] {source.name}: 获取 {len(items)} 条")

        total_items = sum(len(items) for items in all_items.values())
        print(f"[媒体] 抓取完成: {len(all_items)} 个源成功, {len(failed_ids)} 个失败, 共 {total_items} 条")

        return RSSData(
            date=crawl_date,
            crawl_time=crawl_time,
            items=all_items,
            id_to_name=id_to_name,
            failed_ids=failed_ids,
        )

    @classmethod
    def from_config(
        cls,
        media_config: Dict,
        feeds: List[Dict],
        timezone: str = DEFAULT_TIMEZONE,
        use_proxy: bool = False,
        proxy_url: str = "",
    ) -> "MediaFetcher":
        """
        从 config["MEDIA_SOURCES"] + 合并后的 FEEDS 条目构建

        Args:
            media_config: loader 的 MEDIA_SOURCES 配置（ENABLED/REQUEST_INTERVAL/TIMEOUT）
            feeds: 已合并 media 源的 RSS FEEDS 列表（type == "site" 的条目）
        """
        sources = []
        for feed in feeds:
            if feed.get("type") != "site" or not feed.get("enabled", True):
                continue
            sources.append(MediaSourceConfig(
                id=feed["id"],
                name=feed.get("name", feed["id"]),
                parser_id=feed.get("parser_id", ""),
                target_url=feed.get("target_url", ""),
                max_items=feed.get("max_items", 0),
                enabled=feed.get("enabled", True),
                max_age_days=feed.get("max_age_days"),
                headers=feed.get("headers", {}) or {},
                timeout=feed.get("timeout", 0) or 0,
                scheme=feed.get("scheme", ""),
                verify=feed.get("verify", True),
                retry=feed.get("retry", 2),
            ))
        return cls(
            sources=sources,
            request_interval=media_config.get("REQUEST_INTERVAL", 1500),
            timeout=media_config.get("TIMEOUT", 20),
            use_proxy=use_proxy,
            proxy_url=proxy_url,
            timezone=timezone,
        )
