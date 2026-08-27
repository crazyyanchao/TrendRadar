# coding=utf-8
"""python -m trendradar.webapp 入口"""

import argparse

from trendradar.webapp.server import run


def main():
    parser = argparse.ArgumentParser(
        prog="python -m trendradar.webapp",
        description="TrendRadar 选题终端 Web 服务",
    )
    parser.add_argument("--host", default="", help="监听地址（默认 127.0.0.1，容器内 0.0.0.0，可用 TERMINAL_HOST 覆盖）")
    parser.add_argument("--port", type=int, default=0, help="监听端口（默认 8090，可用 TERMINAL_PORT 覆盖）")
    parser.add_argument("--open-browser", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    run(host=args.host, port=args.port, open_browser=args.open_browser)


if __name__ == "__main__":
    main()
