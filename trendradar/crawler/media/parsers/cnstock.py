# coding=utf-8
"""上海证券报（cnstock.com）— 首页（JS 渲染，HTML 兜底）"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("cnstock")
class CNStockParser(ListSiteParser):
    """
    上海证券报·中国证券网：https://www.cnstock.com/

    注：首页新闻为 JS 渲染，HTML 仅含可视化财报/视频链接；且该站无公开
    RSS/API，解析大概率失败（只黄灯不阻塞）。可观察后续是否提供静态栏目页。
    """

    # 文章链接（猜测模式，JS 渲染时抓不到）
    anchor_href_re = r"/news/\d{4}/\d{2}/\d{2}/[A-Za-z0-9]+\.html"
    time_re = r"\d{4}-\d{2}-\d{2}"
    max_links = 60
