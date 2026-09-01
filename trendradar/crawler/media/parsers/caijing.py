# coding=utf-8
"""财经网（caijing.com.cn）— 首页 HTML 列表（正文区 JS 渲染，尽力而为）"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("caijing")
class CaijingParser(ListSiteParser):
    """
    财经网：链接 http://www.caijing.com.cn/20260415/5153827.shtml（日期在 URL）

    注：正文列表为 JS 渲染，首页 HTML 仅含少量服务端链接（多为历史/公示），
    抓取量有限；建议自建 RSSHub 实例用 /caijing/roll 路由获得完整滚动流。
    """

    # 文章链接：/YYYYMMDD/ID.shtml
    anchor_href_re = r"/20\d{6}/\d+\.shtml"
    # URL 内日期：20260415 → 2026-04-15
    url_date_re = r"/(20\d{6})/"
    max_links = 60
