"""
L03 · 任务三（Python 通道）：让模型稳定输出可解析的结构。

跑法：uv run python -m l03.structured        验证：uv run python -m l03.verify

`shared/parse.py` 里有我的实现。**先别看。**

完整任务说明见 l03/structured.ts。Python 这边有一个 TS 那边不存在的坑，
而且它是「静默拿到坏数据」这一类里最典型的：

**json.loads 默认接受 NaN / Infinity / -Infinity，而 JSON.parse 会拒绝。**

模型偶尔真的会输出 NaN，尤其是你让它算平均值、而分母是 0 的时候。
于是同一份输出在 Python 侧「解析成功」，你拿到一个 float('nan')，
它一路流到下游，最后表现为某个统计数字不对——而你会去查统计逻辑。
在 TS 侧它当场就报错了。

这就是本节那条纪律的一个具体实例：**宽松是一种技术债。**
用 parse_constant 参数把它关掉。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from shared.config import create_client, get_provider
from shared.ledger import Ledger
from shared.message import text_of


class ParseError(Exception):
    def __init__(self, message: str, raw: str) -> None:
        super().__init__(message)
        self.raw = raw


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · strip_fences(text)
#
# TODO 2 · extract_json(text, *, allow_trailing_comma=False, on_repair=None)
#
#   ★ 括号计数必须跳过字符串内部，还要处理 \ 转义。
#   ★ 没闭合就抛错，不要补括号。截断和格式错是两种故障，错误信息要能区分。
#   ★ 关掉 NaN / Infinity（见模块头）。
#
# TODO 3 · extract_tag(text, tag)
#
#   只有开标签的情况必须能处理——配合 stop_sequences 时那是最正常的情况。
# ─────────────────────────────────────────────────────────────────────────────


def strip_fences(text: str) -> str:
    raise NotImplementedError("TODO 1")


def extract_json(
    text: str,
    *,
    allow_trailing_comma: bool = False,
    on_repair: Callable[[str], None] | None = None,
) -> Any:
    raise NotImplementedError("TODO 2")


def extract_tag(text: str, tag: str) -> str | None:
    raise NotImplementedError("TODO 3")


# ─────────────────────────────────────────────────────────────────────────────
# TODO 4 · 三个版本各跑 5 次，比较一次解析成功率。详见 l03/structured.ts。
# ─────────────────────────────────────────────────────────────────────────────

MEETING = """
张伟：这周的登录页改版我来做，下周三之前给出可点的版本。
李娜：那我同步把埋点方案写出来，不过我下周一二在出差，可能要往后挪。
王强：数据库迁移脚本我已经写完了，等评审。
张伟：好，那评审我们放在周四。另外线上那个偶发 500 有人跟吗？
李娜：我看过日志，像是连接池打满，还没定位到根因。
""".strip()


def main() -> None:
    provider = get_provider()
    client = create_client(provider)
    ledger = Ledger("L03 结构化输出")

    _ = (client, ledger, MEETING, text_of)
    raise NotImplementedError("把 TODO 4 写完，然后删掉这一行")


if __name__ == "__main__":
    main()
