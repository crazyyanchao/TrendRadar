# coding=utf-8
"""站点解析器注册表"""

from typing import Dict, Optional, Type

from trendradar.crawler.media.base import SiteParser

_PARSERS: Dict[str, Type[SiteParser]] = {}


def register(parser_id: str):
    """解析器注册装饰器：@register("stcn")"""

    def deco(cls):
        _PARSERS[parser_id] = cls
        return cls

    return deco


def get_parser(parser_id: str) -> Optional[Type[SiteParser]]:
    """按 parser_id 获取解析器类（未注册返回 None）"""
    return _PARSERS.get(parser_id)
