# coding=utf-8
"""经济参考报（jjckb.cn）— 要闻栏目 HTML 列表页，日期编入 URL"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("jjckb")
class JJKBParser(ListSiteParser):
    """经济参考报·要闻：链接 20260831/<hash>/c.html（日期在 URL）"""

    # 文章链接：YYYYMMDD/<32位hash>/c.html（相对路径）
    anchor_href_re = r"20\d{6}/[a-f0-9]{32}/c\.html"
    # URL 内日期：20260831 → 2026-08-31
    url_date_re = r"(20\d{6})/"
    max_links = 60
