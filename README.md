# Agent 学院

一门为前端工程师定制的 Agent 开发课程。24 节课（含 2 节选修），约 6 个月，终点是能过面试、能接需求的 agent 工程师。

## 跑起来

```bash
pnpm install
pnpm dev          # 讲义网页，默认 http://localhost:5273
```

实操代码是独立的项目，TypeScript 和 Python 两套并行：

```bash
cd labs
cp .env.example .env   # 填入 DeepSeek API key，两套共用这一份

pnpm install           # TypeScript 通道
pnpm models            # 确认当前可用的模型 ID

uv sync                # Python 通道（或 pip install -r requirements.txt）
```

详见 [`labs/README.md`](./labs/README.md)。

## 怎么上课

1. 网页上读讲义，展开「原理下钻」看背后的模型机制。
2. 遇到「动手」区块就去 `labs/` 写代码。先自己写，卡十分钟再看 `solutions/`。
3. 回到网页做本节测验。**答案就在每道题下面，默认折叠**——先自己答，再点开对。
4. 觉得这节吃透了，点页面底部的「标记学完」。进度条是你自己按的，不是靠「打开过」推断的。

## 课程设定

| | |
|---|---|
| 主语言 | TypeScript —— 讲义示例、实操、贯穿项目都以它为准 |
| 副语言 | Python —— 每节实操另给一份 `.py`，同样能跑；目的是读得懂生态代码 |
| 模型 | DeepSeek，走 Anthropic 协议兼容端点 |
| 贯穿项目 | Mini Coding Agent —— 从 L04 开始长，到 L19 上线 |
| 理论深度 | 寄生在工程决策里（「原理下钻」折叠区）+ 一节可选深度课 L05x |

用 Anthropic 兼容端点是刻意的选择：**学的是行业标准的 Messages API 心智模型（Claude Code、MCP、Computer Use 都出自这条线，面试也考这套），花的是国内模型的价钱。** 代价是兼容层的特性缺口，L15 会专门实测。

## 目录

```
src/lessons/L00/      讲义（content.mdx）与测验（quiz.ts），每节一个目录
src/components/       讲义里的教学区块、测验组件
src/lib/curriculum.ts 课程大纲的唯一数据源
labs/                 实操代码，TS + Python 双通道
labs/shared/          两套语言各自的 config / resilience，被所有课复用
```

答题草稿存在浏览器 localStorage 里，不落文件。
