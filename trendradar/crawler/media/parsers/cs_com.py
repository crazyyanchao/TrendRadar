# coding=utf-8
"""中国证券报（cs.com.cn）— 新闻中心栏目（https 可访问，内容更新滞后）"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("cs_com")
class CSComParser(ListSiteParser):
    """
    中国证券报·中证网：https://www.cs.com.cn/xwzx/

    注：http 直连超时，须用 https；栏目页为静态快照（内容更新滞后），
    且无公开 RSS/API。抓取量有限，失败时只黄灯不阻塞。
    """

    # 文章链接（中证网栏目页常见模式）：/20260831/t20260831_数字.html
    anchor_href_re = r"/t20\d{6}_\d+\.html"
    # URL 内日期：t20260831_ → 2026-08-31
    url_date_re = r"t(20\d{6})_"
    time_re = r"\d{4}-\d{2}-\d{2}"
    max_links = 60
