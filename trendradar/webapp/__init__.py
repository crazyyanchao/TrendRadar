# coding=utf-8
"""
TrendRadar 选题终端（TOPIC TERMINAL）

浅色玻璃态三栏式 AI 选题工作台的轻量 Web 服务与前端页面。
启动: python -m trendradar.webapp [--host H] [--port P]
"""

from trendradar.webapp.server import run

__all__ = ["run"]
