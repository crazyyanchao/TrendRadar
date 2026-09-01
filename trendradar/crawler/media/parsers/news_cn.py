# coding=utf-8
"""新华社·新华网（news.cn）— 首页 HTML 列表，日期编入 URL"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("news_cn")
class NewsCnParser(ListSiteParser):
    """
    新华社·新华网：首页「最新播报」区块链接为 20260831/<hash>/c.html（相对路径，日期在 URL）。

    注：whxw.htm（权威发布）栏目已停更，故抓首页；该格式链接基本均为近期内容。
    """

    # 文章链接：YYYYMMDD/<32位hash>/c.html（相对路径）
    anchor_href_re = r"20\d{6}/[a-f0-9]{32}/c\.html"
    # URL 内日期：20260831 → 2026-08-31
    url_date_re = r"(20\d{6})/"
    max_links = 60
