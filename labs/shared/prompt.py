"""
Prompt 拼装。shared/prompt.ts 的 Python 对照版。

设计和 TS 版一一对应，但这里有一个**语言层面**的取舍值得单独讲，
因为它是本节 Python 对照的重点。

Python 自带 str.format，语法恰好就是 {name}：

    "工作目录是 {cwd}".format(cwd="/repo")

而且它缺 key 时会抛 KeyError——正是我们要的「漏传要响」。
看起来完全不用自己写。但它有一个致命问题：

    "形状：{\"task\": string}".format(cwd="/repo")
    → KeyError: '"task"'

str.format 会把模板里**所有**花括号都当成占位符。而 prompt 的
<output_format> 段里几乎一定有 JSON 形状说明。要用 str.format 就得把
它们全写成 {{ 和 }}，于是你的 prompt 源文件和发给模型的内容不再一致
——review 的时候看到的是转义后的样子，这在 prompt 上是很糟的一件事。

所以这里和 TS 版一样，用一条收紧过的正则。**标准库看起来刚好合适，
但它的转义规则和你的内容冲突时，自己写十行更划算。**
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# 只认「长得像变量名」的占位符。带引号和冒号的 JSON 形状因此天然被排除。
PLACEHOLDER = re.compile(r"\{(\w+)\}")
LEFTOVER = re.compile(r"\{[A-Za-z_][\w .\-]{0,30}\}")


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


def fill(template: str, **vars: str | int) -> str:
    """
    严格渲染。缺变量抛错，多传变量也抛错。

    「多传也抛错」在 TS 那边解释过：多出来的变量通常意味着改了模板忘了改调用方。
    这是一个不要钱的一致性检查。
    """
    used: set[str] = set()
    missing: list[str] = []

    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        used.add(name)
        if name not in vars or vars[name] is None:
            missing.append(name)
            return ""
        return str(vars[name])

    out = PLACEHOLDER.sub(sub, template)
    unused = [k for k in vars if k not in used]

    if missing or unused:
        parts = []
        if missing:
            parts.append(f"模板需要但没传：{', '.join(missing)}")
        if unused:
            parts.append(f"传了但模板没用到：{', '.join(unused)}")
        raise PromptVarError("；".join(parts), missing, unused)

    return out


def assert_rendered(text: str) -> None:
    """渲染完再扫一遍。防的是 {max steps} 这种带空格、PLACEHOLDER 匹配不到的写法。"""
    left = LEFTOVER.findall(text)
    if left:
        raise PromptVarError(f"渲染完还剩占位符：{', '.join(dict.fromkeys(left))}")


@dataclass
class Section:
    tag: str
    body: str | list[str] | None


def section(s: Section) -> str:
    """空内容返回空字符串（整段省掉），不留 <rules></rules> 空壳。"""
    if s.body is None:
        return ""

    if isinstance(s.body, list):
        items = [x.strip() for x in s.body if x and x.strip()]
        inner = "\n".join(f"{i + 1}. {x}" for i, x in enumerate(items))
    else:
        inner = s.body.strip()

    if not inner:
        return ""
    return f"<{s.tag}>\n{inner}\n</{s.tag}>"


def build(sections: list[Section]) -> str:
    """按给定顺序拼装。顺序就是缓存边界，稳定的放前面。"""
    return "\n\n".join(x for x in (section(s) for s in sections) if x)


def wrap_untrusted(tag: str, content: str, attrs: dict[str, str] | None = None) -> str:
    """
    包一段不可信的外部内容。

    和 TS 版一样，这**不是**安全边界，只是把「一行注释就能越狱」的门槛抬高一点。
    真正的边界在工具权限层。
    """
    attr_str = ""
    if attrs:
        attr_str = "".join(f' {k}="{v.replace(chr(34), "&quot;")}"' for k, v in attrs.items())
    defused = content.replace(f"</{tag}>", f"<\u200b/{tag}>")
    return f"<{tag}{attr_str}>\n{defused}\n</{tag}>"
