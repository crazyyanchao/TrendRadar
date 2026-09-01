# coding=utf-8
"""每日经济新闻（nbd.com.cn）— HTML 列表页，链接与时间均服务端渲染"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("nbd")
class NBDParser(ListSiteParser):
    """每日经济新闻：链接 https://www.nbd.com.cn/articles/2026-08-31/4567422.html"""

    # 文章链接：/articles/日期/ID.html
    anchor_href_re = r"/articles/\d{4}-\d{2}-\d{2}/\d+\.html"
    # URL 内日期优先（/articles/2026-08-31/）；页面时间兜底
    url_date_re = r"/articles/(20\d{2}-\d{2}-\d{2})/"
    time_re = r"\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}"
    max_links = 60
