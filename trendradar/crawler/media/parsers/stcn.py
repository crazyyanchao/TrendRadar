# coding=utf-8
"""证券时报（stcn.com）— 快讯栏目（JS 渲染，HTML 兜底 + 长超时重试）"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("stcn")
class STCNParser(ListSiteParser):
    """
    证券时报·快讯（含券商中国替代内容）：https://www.stcn.com/article/list/kx.html

    注：快讯列表为 JS 渲染（页面含验证码/通知机制），HTML 解析大概率提取不到
    文章链接，失败时只黄灯不阻塞。推荐方案：自建 RSSHub 实例后用
    rsshub.base_url + /stcn/kx 路由（本框架 rss.feeds 直接支持）。
    """

    # 文章链接（猜测模式，JS 渲染时抓不到）：/article/detail/数字.html
    anchor_href_re = r"/article/(?:detail|content)/\d+\.html"
    time_re = r"\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}"
    max_links = 60
