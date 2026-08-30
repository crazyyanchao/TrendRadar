# coding=utf-8
"""
选题终端 · 关注关键词 AI 能力

- extract_keywords: 基于用户输入文本（或兴趣描述），用 AI 抽取关注关键词
- sync_frequency_words: 把关键词同步为主流程 config/frequency_words.txt 末尾的
  「自动同步组」普通词组（组内任一命中即中，与 matches_word_groups 语义一致），
  使终端保存的关键词直接参与 cron 管线的新闻过滤/推送。

只动含 AUTO_GROUP_MARKER 标记的自动同步组，绝不改动用户手写的其他词组；
写入采用同目录 temp + os.replace 原子替换，并用模块级锁保证 ThreadingHTTPServer
多线程下并发安全。
"""

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, List, Optional, Tuple, Union

from trendradar.ai.client import AIClient
from trendradar.ai.prompt_loader import load_prompt_template

# 自动同步组在 frequency_words.txt 里的身份标记
# 注意：组别名须带 []（frequency.py 把组首行 [xxx] 识别为别名，裸词会被当普通词）
AUTO_GROUP_ALIAS = "[自动同步]"
AUTO_GROUP_MARKER = "# 自动同步组 · 由选题终端管理，请勿手动编辑"

MAX_KEYWORDS = 40            # 同步/返回的关键词上限（信息密集文本应更全面覆盖）
MAX_KEYWORD_LEN = 30         # 单个关键词最大长度（避免撑爆子串匹配）
MAX_EXTRACT_TEXT = 2000      # 抽取接口允许的最大输入文本长度

_sync_lock = threading.Lock()  # 模块级写锁：多个请求线程并发写同一文件


class KeywordExtractionError(Exception):
    """关键词抽取失败（带 HTTP 状态与错误码，由 server 层转成 AppError）"""

    def __init__(self, message: str, status: int = 502, code: str = "ai_extract_failed"):
        super().__init__(message)
        self.status = status
        self.code = code


# ---------------------------------------------------------------------------
# 频率词文件路径解析
# ---------------------------------------------------------------------------

def resolve_frequency_path() -> Path:
    """解析要同步的 frequency_words.txt 路径。

    优先级：TERMINAL_FREQUENCY_WORDS_PATH > FREQUENCY_WORDS_PATH > 默认相对路径。
    与 core 的默认解析保持一致；webapp 进程 cwd 为项目根 / 容器内 /app。
    当用户把 schedule.frequency_file 指向自定义文件时，可用
    TERMINAL_FREQUENCY_WORDS_PATH 覆盖到同一份文件。
    """
    for env_name in ("TERMINAL_FREQUENCY_WORDS_PATH", "FREQUENCY_WORDS_PATH"):
        value = os.environ.get(env_name, "").strip()
        if value:
            return Path(value)
    return Path("config/frequency_words.txt")


# ---------------------------------------------------------------------------
# AI 抽取
# ---------------------------------------------------------------------------

def _sanitize_keyword(kw: str) -> Optional[str]:
    """关键词格式安全清洗。

    拒绝会破坏 frequency_words.txt 解析语义的词：
    - 以 +（必须词）/ !（过滤词）/ @（条数）/ /（正则）/ #（注释）/ [ ]（别名/区域）开头
    - 含 =>（显示名分隔符）、换行符
    - 空串 / 超长
    注意 C++、AI 这类不以特殊前缀开头的词是安全的（走子串匹配）。
    """
    if not isinstance(kw, str):
        return None
    text = kw.strip()
    if not text:
        return None
    if len(text) > MAX_KEYWORD_LEN:
        return None
    if text[0] in "+!@/#[]":
        return None
    if "=>" in text:
        return None
    if "\n" in text or "\r" in text:
        return None
    return text


def _dedupe_keywords(kws: List[str]) -> List[str]:
    """保序去重（忽略大小写，兼容英文大小写重复）"""
    seen = set()
    result: List[str] = []
    for kw in kws:
        key = kw.lower()
        if key not in seen:
            seen.add(key)
            result.append(kw)
    return result


def _extract_json(response: str) -> Optional[str]:
    """从 AI 响应中提取 JSON 文本（尽量鲁棒）。

    依次尝试：
    1. 剥 markdown ```json``` 围栏，取每个代码块
    2. 在每个候选中找最外层 {...} 或 [...]（从第一个 {/[ 到最后一个 }/]）
    """
    if not response or not response.strip():
        return None

    text = response.strip()
    candidates: List[str] = []

    if "```" in text:
        parts = text.split("```")
        for i in range(1, len(parts), 2):
            block = parts[i].strip()
            if block.lower().startswith("json"):
                block = block[4:].lstrip()
            candidates.append(block)
    candidates.append(text)

    for candidate in candidates:
        for start_char, end_char in (("{", "}"), ("[", "]")):
            s = candidate.find(start_char)
            if s == -1:
                continue
            e = candidate.rfind(end_char)
            if e > s:
                return candidate[s:e + 1]
    return None


def _parse_keywords_payload(data: Any) -> List[str]:
    """把解析出的 JSON 数据转成关键词字符串列表，兼容多种结构。"""

    def _item_text(item: Any) -> Optional[str]:
        if isinstance(item, dict):
            # dict 项：优先常见字段名，退而取第一个字符串值
            for key in ("tag", "name", "label", "keyword", "word", "value", "term"):
                val = item.get(key)
                if isinstance(val, str) and val.strip():
                    return val
            for val in item.values():
                if isinstance(val, str) and val.strip():
                    return val
            return None
        return str(item)

    if isinstance(data, list):
        return [x for x in (_item_text(v) for v in data) if x]
    if isinstance(data, dict):
        # 常见字段名：keywords / keyword / word / words / tags
        for key in ("keywords", "keyword", "word", "words", "tags"):
            val = data.get(key)
            if isinstance(val, list):
                return [x for x in (_item_text(v) for v in val) if x]
            if isinstance(val, str) and val.strip():
                return [x for x in re.split(r"[,，、;；\n]+", val) if x.strip()]
    return []


def _parse_keywords_lines(response: str) -> List[str]:
    """非 JSON 兜底：按行解析（兼容模型输出列表/序号/引号包裹）。"""
    results: List[str] = []
    for line in response.splitlines():
        line = line.strip()
        if not line:
            continue
        # 去掉行首列表符号（- * • 圆点）再去掉数字序号前缀（如 "1. "、"2、"）
        line = re.sub(r"^[\-\*•·○\s]+", "", line).strip()
        line = re.sub(r"^\d+[\.、)．:]+\s*", "", line).strip()
        # 去掉行尾/包裹引号与杂散标点
        line = line.strip("\"'“”[]`，,。;；:：")
        if line:
            results.append(line)
    return results


def extract_keywords(ctx, text: str) -> List[str]:
    """基于用户输入文本（或兴趣描述），用 AI 抽取关注关键词。

    解析足够鲁棒：剥围栏 → 找最外层 JSON → dict/list/分隔串 → 行式兜底；
    全部失败时返回空列表（不抛错），由前端提示"未抽取到有效关键词"。
    已知模型偶发空响应，抽不出时自动重试一次。

    Args:
        ctx: AppContext（读取 AI 配置）
        text: 用户输入的源文本

    Returns:
        清洗后的关键词列表（可为空）

    Raises:
        KeywordExtractionError: AI 不可用 / 提示词模板缺失 / AI 调用失败
    """
    ai_config = ctx.config.get("AI", {}) if hasattr(ctx, "config") else {}
    client = AIClient(ai_config)
    ok, err = client.validate_config()
    if not ok:
        raise KeywordExtractionError(err, status=503, code="ai_unavailable")

    system, user_template = load_prompt_template(
        "keyword_extract_prompt.txt", config_subdir="ai_filter", label="关键词提取",
    )
    if not user_template:
        raise KeywordExtractionError("关键词提取提示词模板缺失", status=500, code="prompt_missing")

    user_prompt = user_template.replace("{text}", text)
    messages: List[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user_prompt})

    def _run_once() -> List[str]:
        # max_tokens 给足，避免模型罗列较多术语时 JSON 被截断导致解析失败
        response = client.chat(messages, temperature=0.3, max_tokens=1000)
        return _parse_keywords_response(response)

    # DeepSeek 等接口在负载高时偶发"空响应/解析失败"：退避重试。
    # 同时跑两轮并合并去重：模型每轮选的关键词集合略有差异，合并后覆盖更全面（更贴合"更全面"诉求）。
    import time as _time

    merged: List[str] = []
    last_error: Optional[str] = None
    # 自适应多轮合并：模型每轮选的关键词集合略有差异，空响应/失败则继续下一轮，
    # 凑够目标量即停。既抵消接口偶发空响应，又让覆盖更全面。
    target = min(MAX_KEYWORDS, 30)
    for _round in range(4):
        if len(merged) >= target:
            break
        try:
            kws = _run_once()
        except Exception as e:  # noqa: BLE001 —— 记录最后一次异常，继续下一轮
            last_error = str(e)
            kws = []
        if kws:
            for k in kws:
                if k and k not in merged:
                    merged.append(k)
        if _round < 2:
            _time.sleep(1.0)
    if not merged and last_error:
        raise KeywordExtractionError(f"AI 调用失败: {last_error}") from None
    if len(merged) > MAX_KEYWORDS:
        # 模型可能罗列了远超上限的术语：均匀抽样保留前 MAX_KEYWORDS 个，
        # 兼顾高优先级靠前与跨维度覆盖。
        step = len(merged) / MAX_KEYWORDS
        merged = [merged[int(i * step)] for i in range(MAX_KEYWORDS)]
    return merged


def _parse_keywords_response(response: str) -> List[str]:
    """从一次 AI 响应中提取并清洗关键词（不做 AI 调用）。"""
    keywords: List[str] = []
    json_str = _extract_json(response)
    if json_str:
        try:
            data = json.loads(json_str)
            keywords = _parse_keywords_payload(data)
        except json.JSONDecodeError:
            keywords = []
    if not keywords:
        keywords = _parse_keywords_lines(response)

    cleaned: List[str] = []
    for item in keywords:
        k = _sanitize_keyword(item)
        if k and k not in cleaned:
            cleaned.append(k)
    cleaned = _dedupe_keywords(cleaned)
    if len(cleaned) > MAX_KEYWORDS:
        # 模型可能罗列了远超上限的术语（文本本身是关键词库时尤其常见）。
        # 均匀抽样保留前 MAX_KEYWORDS 个：既照顾高优先级靠前的词，又保证跨维度覆盖，
        # 避免只截到前几个维度的词。
        step = len(cleaned) / MAX_KEYWORDS
        cleaned = [cleaned[int(i * step)] for i in range(MAX_KEYWORDS)]
    return cleaned


# ---------------------------------------------------------------------------
# 同步到 frequency_words.txt（自动同步组）
# ---------------------------------------------------------------------------

def _find_marker_line(lines: List[str], marker: str) -> Optional[int]:
    for i, line in enumerate(lines):
        if line.strip() == marker:
            return i
    return None


def _auto_group_span(lines: List[str], marker_idx: int) -> Tuple[int, int]:
    """返回自动同步组的 [start, end) 行区间。

    自动组是一段连续非空行（组别名 + 注释标记 + 关键词行），以空行为界。
    """
    start = marker_idx
    while start > 0 and lines[start - 1].strip() != "":
        start -= 1
    end = marker_idx + 1
    while end < len(lines) and lines[end].strip() != "":
        end += 1
    return start, end


def _build_auto_group_block(keywords: List[str]) -> str:
    """构造自动同步组文本块：组别名 + 标记注释 + 关键词逐行"""
    lines = [AUTO_GROUP_ALIAS, AUTO_GROUP_MARKER]
    lines.extend(keywords)
    return "\n".join(lines) + "\n"


def _atomic_write(path: Path, lines: Union[List[str], str]) -> None:
    """同目录 temp + os.replace 原子写，失败清理临时文件"""
    if isinstance(lines, list):
        text = "\n".join(lines).rstrip("\n") + "\n"
    else:
        text = str(lines)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def sync_frequency_words(freq_path: Union[str, Path], keywords: List[str]) -> None:
    """把关键词同步为 frequency_words.txt 末尾的「自动同步组」。

    - 只替换/删除/追加含 AUTO_GROUP_MARKER 的组，用户手写组保持不动
    - keywords 为空 → 删除已存在的自动同步组
    - 全程模块级锁内执行；原子写
    """
    path = Path(freq_path)
    safe = []
    for kw in keywords:
        cleaned = _sanitize_keyword(kw)
        if cleaned and cleaned not in safe:
            safe.append(cleaned)
    safe = safe[:MAX_KEYWORDS]

    with _sync_lock:
        if not path.exists():
            if not safe:
                return
            # 文件不存在：新建并确保落在 [WORD_GROUPS] 区
            _atomic_write(path, "[WORD_GROUPS]\n\n" + _build_auto_group_block(safe))
            return

        content = path.read_text(encoding="utf-8", errors="replace")
        lines = content.split("\n")
        idx = _find_marker_line(lines, AUTO_GROUP_MARKER)

        if not safe:
            if idx is not None:
                start, end = _auto_group_span(lines, idx)
                _atomic_write(path, lines[:start] + lines[end:])
            return

        block_lines = _build_auto_group_block(safe).rstrip("\n").split("\n")
        if idx is not None:
            # 命中自动组 → 整段替换
            start, end = _auto_group_span(lines, idx)
            _atomic_write(path, lines[:start] + block_lines + lines[end:])
        else:
            # 未命中 → 末尾追加（前补一个空行分隔）
            while lines and lines[-1] == "":
                lines.pop()
            lines.append("")
            lines.extend(block_lines)
            _atomic_write(path, lines)
