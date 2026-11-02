"""
查一下当前账号能用哪些模型 ID。shared/models.ts 的 Python 对照版。

为什么需要这个脚本：模型 ID 会退役，任何教程里写死的 ID 都有过期的一天。
与其信文档，不如直接问 API。跑法：uv run python -m shared.models

两个值得留意的点：

  1. 这里走的是 DeepSeek 的 OpenAI 兼容端点（/models），因为 Anthropic 协议里
     没有「列模型」这个接口——兼容层不等于功能等同，这是你遇到的第一个例子。

  2. 用的是标准库 urllib 而不是 httpx。anthropic 这个 SDK 内部依赖的是
     httpx2（它自己 vendor 的版本），`import httpx` 会直接 ImportError。
     一次性的小请求没必要为此多加一个直接依赖。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def main() -> int:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        print("缺少 DEEPSEEK_API_KEY，先把 .env 配好", file=sys.stderr)
        return 1

    req = urllib.request.Request(
        "https://api.deepseek.com/models",
        headers={"Authorization": f"Bearer {key}"},
    )

    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            body = json.load(res)
    except urllib.error.HTTPError as e:
        print(f"查询失败 HTTP {e.code}：{e.read().decode()}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"连不上：{e.reason}", file=sys.stderr)
        return 1

    print("\n当前可用的模型 ID：\n")
    for model in body.get("data", []):
        print(f"  · {model['id']}")
    print("\n把你要用的那个写进 .env 的 DEEPSEEK_MODEL_MAIN。\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
