# coding=utf-8
"""证监会发布（csrc.gov.cn）— 信息公开-要闻栏目 HTML 列表"""

from trendradar.crawler.media.base import ListSiteParser
from trendradar.crawler.media.registry import register


@register("csrc")
class CsrcParser(ListSiteParser):
    """
    证监会发布·要闻：链接 /csrc/c100028/c<ID>/content.shtml

    注：common_list.shtml 静态页内容更新滞后（2025 年改版后静态页停留旧文），
    抓取结果可能偏旧；gov.cn 反爬较严，超时/失败时只黄灯不阻塞。
    """

    # 文章链接：/csrc/c100028/c数字/content.shtml
    anchor_href_re = r"/csrc/c100028/c\d+/content\.shtml"
    min_title_len = 6
    time_re = r"\d{4}-\d{2}-\d{2}"
    max_links = 60
