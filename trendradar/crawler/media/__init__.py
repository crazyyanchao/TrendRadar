# coding=utf-8
"""媒体信源抓取（site 类型自建解析器）"""

# 导入 parsers 包触发全部解析器注册（@register）
from trendradar.crawler.media import parsers  # noqa: F401
from trendradar.crawler.media.base import MediaSourceConfig, SiteParser
from trendradar.crawler.media.fetcher import MediaFetcher

__all__ = ["MediaSourceConfig", "SiteParser", "MediaFetcher"]
