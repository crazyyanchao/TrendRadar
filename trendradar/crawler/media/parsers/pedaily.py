# coding=utf-8
"""投资界（news.pedaily.cn）— HTML 列表页，链接与时间均服务端渲染"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("pedaily")
class PedailyParser(ListSiteParser):
    """投资界：链接 https://news.pedaily.cn/202608/568354.shtml（日期在 URL）"""

    # 文章链接：/YYYYMM/ID.shtml（202608 为 6 位日期）
    anchor_href_re = r"/20\d{4}/\d+\.shtml"
    # 页面时间更精确（2026-08-31）；URL 仅到月份，不用它
    time_re = r"\d{4}-\d{2}-\d{2}"
    max_links = 60
