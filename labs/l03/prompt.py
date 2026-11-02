"""
L03 · 任务一（Python 通道）：可测试的 prompt 拼装。

跑法：uv run python -m l03.prompt        验证：uv run python -m l03.verify

`shared/prompt.py` 里有我的实现。**先别看。**

完整任务说明见 l03/prompt.ts。Python 这边额外一件事要想清楚：

标准库的 str.format 语法恰好就是 {name}，缺 key 还会抛 KeyError，
看起来完全不用自己写。**但它会把模板里所有花括号都当占位符**，
而你的 <output_format> 段里几乎一定有 {"task": string} 这种形状说明。
要用它就得把它们全写成 {{ }}，于是 prompt 源文件和实际发出去的内容不一致了。

自己写十行正则更划算。这个判断本身比这十行代码值钱。
"""

from __future__ import annotations

from dataclasses import dataclass


class PromptVarError(Exception):
    def __init__(
        self,
        message: str,
        missing: list[str] | None = None,
        unused: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.missing = missing or []
        self.unused = unused or []


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · fill(template, **vars)
#
#   {name} 换成对应的值。缺变量抛错，多传变量也抛错。
#   值允许是 int（max_steps 这种），别只处理 str。
#
# TODO 2 · assert_rendered(text)
#
#   渲染完再扫一遍，还有 {xxx} 就抛错。
#   ★ 别误伤 {"task": string} 这种 JSON 形状说明——我第一版就踩了这个。
#
# TODO 3 · section(Section)
#
#   list → 编号列表；空内容 → 返回 ''，整段省掉，不留空壳。
#
# TODO 4 · build(sections)
#
#   按顺序拼，段间空一行，空段跳过。顺序就是缓存边界。
#
# TODO 5 · wrap_untrusted(tag, content, attrs)
#
#   把内容里自带的同名闭合标签打断。
#   写完回答：这是安全边界，还是只提高了门槛？
# ─────────────────────────────────────────────────────────────────────────────


def fill(template: str, **vars: str | int) -> str:
    raise NotImplementedError("TODO 1")


def assert_rendered(text: str) -> None:
    raise NotImplementedError("TODO 2")


@dataclass
class Section:
    tag: str
    body: str | list[str] | None


def section(s: Section) -> str:
    raise NotImplementedError("TODO 3")


def build(sections: list[Section]) -> str:
    raise NotImplementedError("TODO 4")


def wrap_untrusted(tag: str, content: str, attrs: dict[str, str] | None = None) -> str:
    raise NotImplementedError("TODO 5")


# ─────────────────────────────────────────────────────────────────────────────
# TODO 6 · 拼出讲义第三节那个六段骨架，然后故意漏传一个变量确认它抛错。
#          要亲眼看到它响，而不是相信它会响。
# ─────────────────────────────────────────────────────────────────────────────


def build_agent_prompt(*, cwd: str, tool_names: list[str], max_steps: int) -> str:
    raise NotImplementedError("TODO 6")


if __name__ == "__main__":
    print(
        build_agent_prompt(
            cwd="/repo",
            tool_names=["read_file", "list_dir", "run_tests"],
            max_steps=12,
        )
    )
