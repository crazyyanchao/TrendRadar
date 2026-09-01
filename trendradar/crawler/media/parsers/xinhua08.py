# coding=utf-8
"""中经社·新华财经（cnfin.com / xinhua08.com）— HTML 列表页，日期编入 URL"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("xinhua08")
class Xinhua08Parser(ListSiteParser):
    """
    中经社·中国金融信息网（新华财经）：https://www.cnfin.com/

    链接 //www.cnfin.com/yw-lb/detail/20260831/4463037_1.html（当天文章，
    日期在 URL）。注：app.xinhua08.com/rss.php 为假 feed（返回 HTML），勿用。
    """

    # 文章链接：/yw-lb/detail/YYYYMMDD/ID_1.html
    anchor_href_re = r"/yw-lb/detail/20\d{6}/"
    # URL 内日期：20260831 → 2026-08-31
    url_date_re = r"/detail/(20\d{6})/"
    max_links = 60
