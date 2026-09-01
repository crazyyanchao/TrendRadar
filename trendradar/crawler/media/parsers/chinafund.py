# coding=utf-8
"""中国基金报（chinafund.cn）— 官网（JS 渲染 + 反爬，HTML 兜底）"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("chinafund")
class ChinaFundParser(ListSiteParser):
    """
    中国基金报：http://www.chinafund.cn/

    注：官网直连经常超时（反爬），且新闻列表 JS 渲染；解析大概率失败
    （只黄灯不阻塞）。可观察后续是否有静态栏目页或官方渠道。
    """

    # 文章链接（猜测模式，JS 渲染时抓不到）
    anchor_href_re = r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/"
    time_re = r"\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}"
    max_links = 60
