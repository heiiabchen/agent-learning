"""
shared/config.ts 的 Python 对照版。和 TS 版共用同一份 .env。

读这个文件的重点不是「Python 怎么调 API」，而是**同一个工程决策在两套语言里长什么样**。
三个决策是语言无关的，两边一模一样：

  1. 模型 ID 来自环境变量，不写死。deepseek-chat 在 2026-07 就下线了。
  2. 兼容端点的特性支持要显式记录——不支持时它通常不报错，只是静默忽略。
  3. 单价只有一处事实来源，算账才可信。

差异只有两处，都在语言层面：
  · TS 靠 `tsx --env-file=.env` 注入环境变量；Python 得自己 load_dotenv()。
  · TS 只有一个 Anthropic 类（JS 天生异步）；Python 有 Anthropic 和 AsyncAnthropic 两个。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from anthropic import Anthropic, AsyncAnthropic
from dotenv import load_dotenv

# .env 和 labs/ 同级，不依赖你在哪个目录敲命令。
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


@dataclass(frozen=True)
class Supports:
    """实测结论，不是官方声明。L15 会写一个探测脚本来填这张表。"""

    prompt_caching: bool
    vision: bool
    extended_thinking: bool
    parallel_tool_use: bool


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key: str
    model_main: str
    model_fast: str
    supports: Supports


def _required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(
            f"缺少环境变量 {name}。\n"
            "把 .env.example 复制成 .env 并填入你的 key（TS 和 Python 共用这一份）。"
        )
    return v


def get_provider() -> Provider:
    return Provider(
        name="deepseek",
        base_url=os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic"),
        api_key=_required("DEEPSEEK_API_KEY"),
        model_main=os.environ.get("DEEPSEEK_MODEL_MAIN") or "deepseek-v4-flash",
        model_fast=os.environ.get("DEEPSEEK_MODEL_FAST") or "deepseek-v4-flash",
        supports=Supports(
            # DeepSeek 是「自动前缀缓存」：不需要传 cache_control，命中与否看你的前缀稳不稳定。
            # 这和 Anthropic 官方那套显式打标记的机制不一样，L15 会实测两者的差别。
            prompt_caching=True,
            vision=False,
            # V4 默认就开着思考模式——这就是流式响应里会冒出 thinking_delta 的原因。
            extended_thinking=True,
            parallel_tool_use=True,
        ),
    )


@dataclass(frozen=True)
class Price:
    """单位是「元 / 百万 token」。"""

    input_miss: float
    input_hit: float
    output: float


# 价格会变（DeepSeek 已经预告过高峰时段翻倍），跑重要的成本估算之前
# 去 https://api-docs.deepseek.com/zh-cn/quick_start/pricing 对一眼。
#
# 注意 input_miss 和 input_hit 差 50 倍。这个比例是 L15 一整节课的由来。
PRICING: dict[str, Price] = {
    "deepseek-v4-flash": Price(input_miss=1, input_hit=0.02, output=2),
    "deepseek-v4-pro": Price(input_miss=3, input_hit=0.025, output=6),
}


def price_of(model: str) -> Price:
    p = PRICING.get(model)
    if p is None:
        raise KeyError(f"PRICING 里没有 {model} 的价格，先去补上再算账。")
    return p


def create_client(p: Provider | None = None) -> Anthropic:
    """
    两个关键选项，和 TS 版同理：

    - auth_token 而不是 api_key：Anthropic 官方端点用 `x-api-key` 头，
      兼容端点普遍走标准的 `Authorization: Bearer`。SDK 里 auth_token 对应后者。
      填错的表现是 401，报错信息通常没什么帮助。

    - max_retries=0：SDK 默认会自己重试 2 次。我们要手写重试逻辑，
      所以先关掉，否则两层重试会叠乘（4 次变 12 次），账单和日志都会很难看。
    """
    p = p or get_provider()
    return Anthropic(base_url=p.base_url, auth_token=p.api_key, max_retries=0)


def create_async_client(p: Provider | None = None) -> AsyncAnthropic:
    """
    需要并发的时候用这个。

    注意 Python 这里比 TS 多了一次选择：JS 里 fetch 天生是异步的，你没得选；
    Python 里同步和异步是两套互不兼容的调用栈（所谓「函数染色」）。
    简单脚本用同步版更省事，只有真的要并发才值得付异步的复杂度。
    """
    p = p or get_provider()
    return AsyncAnthropic(base_url=p.base_url, auth_token=p.api_key, max_retries=0)


def log_usage(label: str, usage: object) -> None:
    """打印这次调用花了多少 token，从第一天就养成看账的习惯。"""
    in_tokens = getattr(usage, "input_tokens", 0)
    out_tokens = getattr(usage, "output_tokens", 0)
    print(f"\x1b[2m[{label}] 输入 {in_tokens} token · 输出 {out_tokens} token\x1b[0m")
