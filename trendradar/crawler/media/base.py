# coding=utf-8
"""
媒体信源抓取基类

- MediaSourceConfig: 媒体源配置（site 类型自建解析器）
- SiteParser: 站点解析器基类，输出 ParsedRSSItem 列表（复用 RSS 通道的数据模型）
- ListPageExtractor: 通用列表页提取器（纯 stdlib html.parser，结构不敏感）

约定：单源失败返回 ([], error)，绝不向外抛异常 —— 保证失败隔离。
"""

import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from html.parser import HTMLParser
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

import requests

from trendradar.crawler.rss.parser import ParsedRSSItem
from trendradar.utils.time import DEFAULT_TIMEZONE, get_configured_time

# 常见中文列表页时间格式（无时区，按配置时区本地化，避免 UTC 误判）
_TIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y/%m/%d",
    "%m-%d %H:%M:%S",
    "%m-%d %H:%M",
)

# 默认时间文本正则（日期 + 可选时间，兼容 - 与 / 分隔）
DEFAULT_TIME_RE = r"\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?"


@dataclass
class MediaSourceConfig:
    """媒体源配置（site 类型自建解析器）"""

    id: str
    name: str
    parser_id: str                      # 对应 registry 中的解析器键
    target_url: str = ""                # 目标列表页/API URL
    max_items: int = 0                  # 0=不限制
    enabled: bool = True
    max_age_days: Optional[int] = None  # None=全局，0=禁用过滤
    headers: Dict[str, str] = field(default_factory=dict)  # 每源自定义请求头
    timeout: int = 0                    # 0=使用全局
    scheme: str = ""                    # 强制 "http"/"https"（处理 https 握手异常站点）
    verify: bool = True                 # False=跳过 TLS 校验
    retry: int = 2                      # 失败重试次数


class SiteParser(ABC):
    """
    站点解析器基类

    约定：输入 MediaSourceConfig + requests.Session，输出 (ParsedRSSItem 列表, 错误信息)。
    单源失败返回 ([], error)，绝不向外抛异常 —— 保证失败隔离。
    """

    parser_id: str = ""                 # 注册表键

    def __init__(
        self,
        source: MediaSourceConfig,
        session: requests.Session,
        timezone: str = DEFAULT_TIMEZONE,
        default_timeout: int = 20,
    ):
        self.source = source
        self.session = session
        self.timezone = timezone
        self.timeout = source.timeout or default_timeout

    # ---------- 子类必须实现 ----------

    @abstractmethod
    def fetch(self) -> Tuple[List[ParsedRSSItem], Optional[str]]:
        """抓取并解析单个源（禁止抛异常，失败返回 ([], error)）"""

    # ---------- 共享工具 ----------

    def _get(self, url: str, **kwargs) -> requests.Response:
        """带重试的 GET；scheme/verify 兜底"""
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                          " (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TrendRadar/2.0",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            **self.source.headers,
        }
        final_url = self._apply_scheme(url)
        last_err: Optional[Exception] = None
        for attempt in range(self.source.retry + 1):
            try:
                resp = self.session.get(
                    final_url,
                    timeout=self.timeout,
                    headers=headers,
                    verify=self.source.verify,
                    **kwargs,
                )
                resp.raise_for_status()
                resp.encoding = resp.apparent_encoding or "utf-8"
                return resp
            except requests.RequestException as e:
                last_err = e
                if attempt < self.source.retry:
                    time.sleep(1.5 * (attempt + 1))
        raise last_err  # type: ignore[misc]

    def _apply_scheme(self, url: str) -> str:
        """scheme 字段强制 http/https（处理 https 握手异常站点）"""
        if self.source.scheme in ("http", "https") and url.startswith(("http://", "https://")):
            return self.source.scheme + url[url.index(":"):]
        return url

    def _abs_url(self, url: str) -> str:
        """相对 URL 转绝对 URL"""
        if not url:
            return ""
        if url.startswith(("http://", "https://")):
            return url
        return urljoin(self.source.target_url, url)

    def _clean(self, text: str) -> str:
        """清理文本（去标签/实体/压缩空白），截断 500 字符"""
        if not text:
            return ""
        text = re.sub(r"<[^>]+>", "", text)
        text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                    .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
        return " ".join(text.split())[:500]

    def _to_iso(self, time_str: str) -> str:
        """常见中文时间格式 → 'YYYY-MM-DD HH:MM'（省略年份时补当年，按配置时区）"""
        raw = (time_str or "").strip()
        if not raw:
            return ""
        # 纯时间（如 "08:30"）默认补今天
        if re.fullmatch(r"\d{1,2}:\d{2}", raw):
            raw = get_configured_time(self.timezone).strftime("%Y-%m-%d ") + raw
        dt: Optional[datetime] = None
        for fmt in _TIME_FORMATS:
            try:
                dt = datetime.strptime(raw, fmt)
                break
            except ValueError:
                continue
        if dt is None:
            return ""
        if dt.year == 1900:  # 省略年份的格式（%m-%d %H:%M）
            dt = dt.replace(year=get_configured_time(self.timezone).year)
        return dt.strftime("%Y-%m-%d %H:%M")

    def _limit(self, items: List[ParsedRSSItem]) -> List[ParsedRSSItem]:
        """max_items 截断（0=不限制）"""
        if self.source.max_items > 0:
            return items[: self.source.max_items]
        return items

    def _build_items(self, rows: List[Tuple[str, str, str, str]]) -> List[ParsedRSSItem]:
        """
        将 (标题, URL, 时间文本, GUID) 行转成 ParsedRSSItem 列表

        - 标题清理、URL 转绝对地址、时间转 ISO
        - 同 URL 只保留第一条（保持列表顺序）
        - GUID 优先用行内 ID，缺省回退 URL
        """
        seen: set = set()
        items: List[ParsedRSSItem] = []
        for title, url, time_str, guid in rows:
            if not title or not url:
                continue
            abs_url = self._abs_url(url)
            if not abs_url or abs_url in seen:
                continue
            seen.add(abs_url)
            items.append(ParsedRSSItem(
                title=self._clean(title),
                url=abs_url,
                published_at=self._to_iso(time_str),
                summary="",
                guid=guid or abs_url,
            ))
        return self._limit(items)


class ListSiteParser(SiteParser):
    """
    通用列表页解析器基类：抓取 target_url → ListPageExtractor 提取 → _build_items

    子类定制（类属性）:
    - anchor_href_re: 有效文章链接正则（必填）
    - min_title_len / max_links / time_re: 同 ListPageExtractor
    - url_date_re: 从 URL 提取日期的正则（捕获组 1 = YYYYMMDD，可选）。
      中文站点列表页常把日期编入 URL，比页面时间文本更可靠。
    """

    anchor_href_re = r".+"
    min_title_len = 4
    max_links = 100
    time_re = DEFAULT_TIME_RE
    url_date_re = r""

    def _augment_time(self, url: str, time_str: str) -> str:
        """URL 日期优先于页面时间文本（捕获组 1 = YYYYMMDD / YYYYMM / YYYY-MM-DD）"""
        if self.url_date_re:
            m = re.search(self.url_date_re, url)
            if m:
                try:
                    raw = m.group(1)
                    fmt = {8: "%Y%m%d", 6: "%Y%m", 10: "%Y-%m-%d"}.get(len(raw))
                    if fmt is None:
                        return time_str
                    dt = datetime.strptime(raw, fmt)
                    hm = re.search(r"\d{1,2}:\d{2}", time_str or "")
                    if hm:
                        return f"{dt.strftime('%Y-%m-%d')} {hm.group(0)}"
                    return dt.strftime("%Y-%m-%d")
                except ValueError:
                    pass
        return time_str

    def fetch(self) -> Tuple[List[ParsedRSSItem], Optional[str]]:
        """抓取列表页并解析（禁止抛异常，失败返回 ([], error)）"""
        try:
            resp = self._get(self.source.target_url)
        except requests.RequestException as e:
            return [], f"请求失败: {e}"
        try:
            html = resp.text
        except Exception as e:
            return [], f"内容解码失败: {e}"

        extractor = ListPageExtractor(html, base_url=self.source.target_url)
        extractor.anchor_href_re = self.anchor_href_re
        extractor.min_title_len = self.min_title_len
        extractor.max_links = self.max_links
        extractor.time_re = self.time_re
        extractor.feed(html)  # 触发解析（类属性覆盖后调用）

        rows = []
        for title, url, time_str, guid in extractor.rows():
            rows.append((title, url, self._augment_time(url, time_str), guid))

        if not rows:
            return [], "未提取到文章链接（页面 JS 渲染或结构变化）"
        items = self._build_items(rows)
        if not items:
            return [], "解析后无有效条目"
        return items, None


class ListPageExtractor(HTMLParser):
    """
    通用列表页提取器：收集 <a> 的文本+href，并在原始 HTML 中按 href 位置
    用正则提取相邻的时间文本（结构不敏感）。

    子类定制:
    - anchor_href_re: 有效文章链接正则（如 r"/article/" + 数字）
    - min_title_len: 最小标题长度（过滤导航/广告）
    - max_links: 最多收集条数
    - time_re: 时间文本正则（默认匹配 YYYY-MM-DD HH:MM 与 YYYY/MM/DD HH:MM）
    """

    anchor_href_re = r".+"
    min_title_len = 4
    max_links = 100
    time_re = DEFAULT_TIME_RE

    def __init__(self, html: str, base_url: str = ""):
        super().__init__(convert_charrefs=True)
        self.html = html
        self.base_url = base_url
        # (title, abs_url, raw_href)，按出现顺序去重；raw_href 用于在原始 HTML 中定位时间
        self.links: List[Tuple[str, str, str]] = []
        self._in_anchor = False
        self._anchor_href = ""
        self._anchor_text: List[str] = []
        self._stop = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if self._stop:
            return
        if tag == "a":
            href = dict(attrs).get("href", "") or ""
            if href:
                self._in_anchor = True
                self._anchor_href = href
                self._anchor_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_anchor:
            self._in_anchor = False
            title = " ".join("".join(self._anchor_text).split())
            href = self._anchor_href
            if (title and len(title) >= self.min_title_len
                    and re.search(self.anchor_href_re, href)):
                abs_url = urljoin(self.base_url, href)
                if abs_url and abs_url not in {u for _, u, _ in self.links}:
                    self.links.append((title, abs_url, href))
                    if len(self.links) >= self.max_links:
                        self._stop = True
            self._anchor_href = ""
            self._anchor_text = []

    def handle_data(self, data: str) -> None:
        if self._in_anchor and not self._stop:
            self._anchor_text.append(data)

    def extract_times(self) -> Dict[str, str]:
        """对每个链接，在其原始 href 出现位置之后 300 字符窗口内提取时间文本 -> {abs_url: time_str}"""
        times: Dict[str, str] = {}
        for _, abs_url, raw_href in self.links:
            idx = self.html.find(raw_href)
            if idx < 0:
                idx = self.html.find(abs_url)
            if idx < 0:
                continue
            window = self.html[idx: idx + 300]
            m = re.search(self.time_re, window)
            if m:
                times[abs_url] = m.group(0)
        return times

    def rows(self) -> List[Tuple[str, str, str, str]]:
        """(标题, URL, 时间文本, GUID='') 行列表；GUID 由 _build_items 回退 URL"""
        times = self.extract_times()
        return [(title, url, times.get(url, ""), "") for title, url, _ in self.links]
