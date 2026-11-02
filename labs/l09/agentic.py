"""L09 任务二：一次性检索 vs 多轮检索（agentic search，Python 版）。

    uv run python -m l09.agentic

不用你写，直接跑。用的是 shared/retrieval.py 里的参考实现。
不调 API——模型的"决定下一步搜什么"这件事用一个确定性的规则模拟，
因为**这个对比要能复现**。

★ 这个脚本要回答一个具体的问题：**agentic search 什么时候值得。**

网上的说法通常是"agentic search 更强"。这个说法不完整——它更强，
而且更贵，而且在一半的场景里那个"更强"是零。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from shared.ledger import Entry, Ledger, Usage
from shared.retrieval import (
    Bm25Index,
    Chunk,
    VectorIndex,
    assemble,
    chunk_by_structure,
    rerank_heuristic,
    rrf,
)

# ─────────────────────────────────────────────────────────────
# 一个小仓库
#
# 关键设计：**答案分散在有依赖关系的几个文件里。**
#
# 这不是为了刁难一次性检索，这是真实代码库的常态——
# 一个 bug 的成因通常横跨"入口 → 中间层 → 工具函数"三层，
# 而只有第一层的名字出现在用户的问题里。
# ─────────────────────────────────────────────────────────────

REPO: dict[str, str] = {
    "src/login.py": """from src.auth.token import verify_token
from src.session.store import get_session


# 登录入口。先校验令牌，再取会话。
async def login(token: str):
    payload = verify_token(token, os.environ["SECRET"])
    if not payload:
        return {"ok": False, "reason": "bad_token"}
    session = await get_session(payload["user_id"])
    if not session:
        return {"ok": False, "reason": "no_session"}
    return {"ok": True, "session": session}
""",
    "src/auth/token.py": """import hashlib


# 令牌的签名校验与过期判断。
def verify_token(token: str, secret: str):
    b64, _, sig = token.partition(".")
    if not b64 or not sig:
        return None
    body = b64decode(b64).decode()
    expect = hashlib.sha256((body + secret).encode()).hexdigest()
    if expect != sig:
        return None
    payload = json.loads(body)
    # 过期判断用的是本机时钟，没有做时钟漂移的容忍。
    if payload["expires_at"] < time():
        return None
    return payload
""",
    "src/session/store.py": """from src.session.redis import redis

TTL_SECONDS = 900


# 会话读写。get_session 拿不到就返回 None，调用方看到的是 no_session。
async def get_session(user_id: str):
    raw = await redis.get("sess:" + user_id)
    if not raw:
        return None
    return json.loads(raw)


async def put_session(user_id: str, data) -> None:
    await redis.setex("sess:" + user_id, TTL_SECONDS, json.dumps(data))
""",
    "src/session/redis.py": """from redis.asyncio import Redis

# Redis 客户端。连接池上限 2，超时 300ms，不自动重连。
redis = Redis.from_url(
    os.environ["REDIS_URL"],
    socket_connect_timeout=0.3,
    retry_on_timeout=False,
    max_connections=2,
)
""",
    "src/config.py": """CONFIG = {
    "token_ttl_minutes": 30,
    "session_ttl_minutes": 15,
    "max_login_attempts": 5,
}
""",
    "docs/deploy.md": """# 部署

生产环境跑在三个区域。**各区域的时钟由 chrony 同步，允许 500ms 漂移。**

Redis 是单实例，没有做副本。连接数上限 64。
""",
    "docs/faq.md": """# 常见问题

## 登录报 bad_token

九成是客户端和服务端时钟不同步。令牌校验用的是本机时钟。

## 登录报 no_session

会话过期了，重新登录即可。
""",
    "src/utils/format.py": """def fmt_date(d):
    return d.isoformat()[:10]


def fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    return f"{n / 1024:.1f}KB"
""",
    "src/utils/retry.py": """async def retry(fn, times: int = 3):
    last = None
    for i in range(times):
        try:
            return await fn()
        except Exception as e:
            last = e
            await asyncio.sleep(0.1 * 2**i)
    raise last
""",
    "src/api/routes.py": """from src.login import login

routes = {
    "POST /login": lambda req: login(req["token"]),
    "GET /health": lambda req: {"ok": True},
}
""",
    # ── 近似干扰项 ──────────────────────────────────────────────
    #
    # ★ 这几个文件是故意加的，它们在检索上和答案**竞争**。
    #
    # 真实项目里的检索难点从来不是"语料里没有答案"，是"语料里有五个
    # 看起来像答案的东西"。只用一堆完全无关的文件当语料，测出来的
    # 检索质量是虚高的。
    "src/db/pool.py": """from psycopg_pool import ConnectionPool

# 数据库连接池。上限 20，空闲回收 30 秒。
pool = ConnectionPool(
    os.environ["DATABASE_URL"],
    max_size=20,
    max_idle=30,
)
""",
    "src/auth/password.py": """import hashlib


# 密码校验。登录失败超过 5 次锁定账号。
def verify_password(input: str, hash: str) -> bool:
    out = hashlib.scrypt(input.encode(), salt=hash[:16].encode(), n=16384, r=8, p=1)
    return out.hex() == hash[16:]
""",
    "src/auth/oauth.py": """# 第三方登录。令牌交换与回调校验。
async def exchange_code(code: str):
    res = await client.post("https://oauth.example.com/token", json={"code": code})
    if res.status_code != 200:
        return {"ok": False, "reason": "bad_code"}
    return {"ok": True, "token": res.json()["access_token"]}
""",
    "src/session/cookie.py": """import re


# 会话 cookie 的读写。SameSite=Lax，7 天过期。
def read_session_cookie(header: str):
    m = re.search(r"sess=([^;]+)", header)
    return m.group(1) if m else None
""",
    "docs/security.md": """# 安全

令牌用 HMAC-SHA256 签名。密钥至少 32 字节，从环境变量读。

会话过期时间 15 分钟，超时后需要重新登录。
""",
    "docs/api.md": """# API

## POST /login

请求体 { token }。失败时返回 reason，可能是 bad_token 或 no_session。
""",
}

# 一批完全无关的模块，把语料量拉到接近真实项目的量级。
#
# 为什么需要它们：**在一个只有 18 个片段的语料上，keep=8 等于把半个
# 仓库塞进去，任何检索策略都"能解决问题"。** 那个结论是假的——
# 它其实是 choose_retrieval 的第一条（语料塞得下就别检索）。
FILLER_TOPICS = [
    ("billing/invoice", "账单生成", "build_invoice"),
    ("billing/tax", "税率计算", "calc_tax"),
    ("export/csv", "CSV 导出", "to_csv"),
    ("export/pdf", "PDF 渲染", "render_pdf"),
    ("notify/email", "邮件通知", "send_mail"),
    ("notify/webhook", "Webhook 推送", "post_hook"),
    ("upload/image", "图片上传与压缩", "compress_image"),
    ("upload/chunked", "分片上传", "upload_part"),
    ("search/filter", "列表筛选条件", "build_filter"),
    ("search/sort", "排序规则", "compare_by"),
    ("i18n/plural", "复数规则", "pluralize"),
    ("i18n/currency", "货币格式化", "fmt_money"),
    ("report/daily", "日报聚合", "aggregate_daily"),
    ("report/chart", "图表数据整形", "to_series"),
    ("audit/log", "审计日志", "write_audit"),
    ("audit/diff", "变更对比", "diff_records"),
    ("queue/worker", "队列消费者", "consume"),
    ("queue/dlq", "死信处理", "move_to_dlq"),
    ("cache/memo", "内存缓存", "memoize"),
    ("cache/lru", "LRU 淘汰", "lru_set"),
    ("geo/distance", "距离计算", "haversine"),
    ("geo/tz", "时区换算", "to_local_time"),
    ("perm/role", "角色权限", "has_role"),
    ("perm/scope", "作用域校验", "check_scope"),
]

for _path, _topic, _fn in FILLER_TOPICS:
    REPO[f"src/{_path}.py"] = f'''# {_topic}。
def {_fn}(input):
    if not input:
        raise ValueError("{_fn.upper()}_EMPTY_INPUT")
    return input


def {_fn}_batch(items):
    return [{_fn}(i) for i in items]
'''


def _all_chunks() -> list[Chunk]:
    out: list[Chunk] = []
    for path, text in REPO.items():
        if path.endswith(".md"):
            out.append(
                Chunk(
                    id=f"{path}#1",
                    text=text,
                    source=path,
                    lines=(1, len(text.split("\n"))),
                )
            )
        else:
            out.extend(chunk_by_structure(text, path))
    return out


ALL_CHUNKS = _all_chunks()

# ─────────────────────────────────────────────────────────────
# 检索一轮
# ─────────────────────────────────────────────────────────────

_vec = VectorIndex()
_kw = Bm25Index()
_vec.add(ALL_CHUNKS)
_kw.add(ALL_CHUNKS)


def search_once(query: str, keep: int) -> list[Chunk]:
    fused = rrf([_vec.search(query, 8), _kw.search(query, 8)])
    return [s.chunk for s in rerank_heuristic(query, fused, keep=keep, min_score=0).kept]


# ─────────────────────────────────────────────────────────────
# 任务定义
#
# answer 是"要回答这个问题必须看到的文件集合"。这是人工标注的，
# 而**人工标注是唯一诚实的检索评测基线**——用模型判断"检索得好不好"
# 会让你测的东西从检索质量变成模型的口味（L12 会展开）。
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Task:
    question: str
    kind: str  # "定点" | "探索"
    #: 必须召回的文件。全部命中才算解决。
    answer: list[str]
    #: 看到某个文件之后会追问什么。模拟"下一轮搜什么"里**由发现驱动**的那一半。
    follow_up: dict[str, str] = field(default_factory=dict)
    #: 什么都没追到时的备用探查序列。模拟另一半：**换个说法再搜。**
    #:
    #: ★ 真实的 agent 两种都会做，而且第二种更常见——因为第一轮
    #: 经常什么有用的都没召回（干扰项赢了）。只建模第一种的话，
    #: agentic search 会显得比实际更脆。
    probes: list[str] = field(default_factory=list)


TASKS = [
    Task(
        question="verify_token 是怎么校验签名的",
        kind="定点",
        answer=["src/auth/token.py"],
    ),
    Task(
        question="fmt_bytes 这个函数在哪",
        kind="定点",
        answer=["src/utils/format.py"],
    ),
    Task(
        question="会话的 TTL 是多少",
        kind="定点",
        answer=["src/session/store.py"],
    ),
    Task(
        question="登录偶尔失败，用户说点了没反应然后要重新登录",
        kind="探索",
        # ★ 根因在 redis.py 的连接池上限，但**问题里没有任何词指向它**。
        answer=["src/login.py", "src/session/store.py", "src/session/redis.py"],
        follow_up={
            "src/login.py": "get_session 会话 返回 None",
            "src/session/store.py": "redis 连接池 上限 超时",
        },
        probes=[
            "login 登录入口 no_session",
            "get_session 会话 返回 None",
            "redis 连接池 上限 超时",
        ],
    ),
    Task(
        question="多区域部署之后 bad_token 变多了，为什么",
        kind="探索",
        answer=["src/auth/token.py", "docs/deploy.md"],
        follow_up={
            "src/login.py": "verify_token 令牌 校验 过期",
            "src/auth/token.py": "时钟 漂移 区域 同步",
        },
        probes=[
            "verify_token 令牌 校验 过期",
            "时钟 漂移 区域 同步",
            "部署 区域 时钟 chrony",
        ],
    ),
]

# ─────────────────────────────────────────────────────────────
# 两种策略
# ─────────────────────────────────────────────────────────────

BUDGET = 4000
FAKE_MODEL = "deepseek-v4-flash"


@dataclass
class Result:
    solved: bool
    rounds: int
    chunks: int
    tokens: int
    yuan: float
    #: 召回但没用上的片段数。噪声比例的分子。
    noise: int


def _usage(input_tokens: int) -> Usage:
    return Usage(input_tokens=input_tokens, output_tokens=200)


def one_shot(task: Task, keep: int) -> Result:
    """一次性检索：一个 query，一轮，keep 个片段，交给模型。"""
    ledger = Ledger("one-shot")
    got = search_once(task.question, keep)
    packed = assemble(task.question, got, budget=BUDGET)
    ledger.record(
        Entry(label="answer", id="msg_1", model=FAKE_MODEL, usage=_usage(packed.tokens), ms=1)
    )

    sources = {c.source for c in packed.used}
    return Result(
        solved=all(a in sources for a in task.answer),
        rounds=1,
        chunks=len(packed.used),
        tokens=packed.tokens,
        yuan=ledger.totals().yuan,
        noise=sum(1 for c in packed.used if c.source not in task.answer),
    )


def agentic(task: Task, keep_per_round: int, max_rounds: int) -> Result:
    """多轮检索：每轮的 query 由上一轮召回的内容决定。

    ★ 真实实现里"下一轮搜什么"是模型决定的（它调 search 工具）。
    这里用 task.follow_up / task.probes 模拟那个决定，为的是**让对比可复现**。

    代价也照实算：每一轮都是一次模型调用，而**每一次调用都要重发前面所有的
    检索结果**（L02 的无状态）。所以 token 是累积的。
    """
    ledger = Ledger("agentic")
    seen: dict[str, Chunk] = {}
    asked: set[str] = set()
    query = task.question
    rounds = 0
    probe_at = 0

    for _ in range(max_rounds):
        rounds += 1
        asked.add(query)
        for c in search_once(query, keep_per_round):
            seen[c.id] = c

        packed = assemble(task.question, list(seen.values()), budget=BUDGET)
        ledger.record(
            Entry(
                label=f"round {rounds}",
                id=f"msg_{rounds}",
                model=FAKE_MODEL,
                usage=_usage(packed.tokens),
                ms=1,
            )
        )

        sources = {c.source for c in packed.used}
        if all(a in sources for a in task.answer):
            return Result(
                solved=True,
                rounds=rounds,
                chunks=len(packed.used),
                tokens=packed.tokens,
                yuan=ledger.totals().yuan,
                noise=sum(1 for c in packed.used if c.source not in task.answer),
            )

        # 先按"已召回的文件"派生下一轮 query（由发现驱动）；
        # 派生不出来就换个说法再搜（probes）。
        nxt = next(
            (q for s in sources if (q := task.follow_up.get(s)) and q not in asked),
            None,
        )
        while nxt is None and probe_at < len(task.probes):
            p = task.probes[probe_at]
            probe_at += 1
            if p not in asked:
                nxt = p
        if nxt is None:
            break
        query = nxt

    packed = assemble(task.question, list(seen.values()), budget=BUDGET)
    sources = {c.source for c in packed.used}
    return Result(
        solved=all(a in sources for a in task.answer),
        rounds=rounds,
        chunks=len(packed.used),
        tokens=packed.tokens,
        yuan=ledger.totals().yuan,
        noise=sum(1 for c in packed.used if c.source not in task.answer),
    )


# ─────────────────────────────────────────────────────────────


def row(label: str, r: Result) -> str:
    mark = "\033[32m解决\033[0m" if r.solved else "\033[31m未解决\033[0m"
    return (
        f"    {label:<16} {mark}  {r.rounds} 轮 · {r.chunks:>2} 片 · "
        f"{r.tokens:>4} token · ¥{r.yuan:.5f} · 噪声 {r.noise}/{r.chunks}"
    )


def main() -> None:
    print("一次性检索 vs 多轮检索。不调 API，结果可复现。")
    print(f"\n仓库：{len(REPO)} 个文件，切成 {len(ALL_CHUNKS)} 个片段。")

    totals = {"narrow": [0, 0.0], "wide": [0, 0.0], "agentic": [0, 0.0]}
    noise = {"narrow": [0, 0], "wide": [0, 0]}

    for task in TASKS:
        print(f"\n  【{task.kind}】{task.question}")
        print(f"    需要看到：{'、'.join(task.answer)}")

        a = one_shot(task, 3)
        b = one_shot(task, 8)
        c = agentic(task, 3, 4)

        print(row("一次性 keep=3", a))
        print(row("一次性 keep=8", b))
        print(row("多轮 agentic", c))

        for key, r in (("narrow", a), ("wide", b), ("agentic", c)):
            totals[key][0] += 1 if r.solved else 0
            totals[key][1] += r.yuan
        for key, r in (("narrow", a), ("wide", b)):
            noise[key][0] += r.noise
            noise[key][1] += r.chunks

    n = len(TASKS)
    print("\n" + "─" * 70)
    print("\n【合计】")
    print(f"  一次性 keep=3   解决 {totals['narrow'][0]}/{n}   ¥{totals['narrow'][1]:.5f}")
    print(f"  一次性 keep=8   解决 {totals['wide'][0]}/{n}   ¥{totals['wide'][1]:.5f}")
    print(f"  多轮 agentic    解决 {totals['agentic'][0]}/{n}   ¥{totals['agentic'][1]:.5f}")

    # ★ 结论三的数字是**算出来的**，不是写死的。
    #
    # 因为这一条的重点恰恰是"结果取决于答案碰巧排第几"——
    # 把结论写死就等于在演示里假装那个结果是必然的。
    gained = totals["wide"][0] - totals["narrow"][0]
    cost_up = totals["wide"][1] / totals["narrow"][1] - 1
    noise_narrow = noise["narrow"][0] / noise["narrow"][1] * 100
    noise_wide = noise["wide"][0] / noise["wide"][1] * 100

    print(f"""
【四条结论】

一 · **定点问题上，多轮检索一分收益都没有。**

    看前三行：agentic 那一行的数字和 keep=3 **完全一样**——
    一轮就命中，没有第二轮。它的额外价值是零。

    好消息是它也没多花钱（因为它会自己停）。坏消息是真实系统里
    它会多花：真 agent 得先调一次工具才知道该不该继续，而那一次
    调用是要付钱的。

    这是 L07 那条判据的检索版：**知道要找什么，就别让模型自己探索。**

二 · **探索问题上，keep 开大解决不了第一个问题。**

    "登录偶尔失败" 的根因在 redis.py 的连接池上限，而**问题里
    没有任何词指向它**。keep=8 召回的片段几乎全是噪声——
    它不是排名靠后，是**语义上和问题不相关**。

    只有"先看 login.py，发现它调 get_session，于是去看 store.py，
    发现它调 redis"这条链能到达。而这条链只能一轮一轮走。

    ★ **一次性检索的上限不是 keep，是 query。** query 是用户写的，
    而用户不知道答案在哪——这才是 agentic search 真正的立足点。

三 · **调 keep 是在赌答案的排名，而你事先不知道答案排第几。**

    keep 从 3 开到 8 的账：多解决了 {gained} 个问题，
    成本涨 {cost_up * 100:.0f}%，噪声比例从 {noise_narrow:.0f}% 涨到 {noise_wide:.0f}%。

    keep 开大**只能救"答案恰好排在第 4 到第 8 名"的那些问题**。
    排在第 20 名的照样漏，而语义上压根不相关的（上面那个连接池）
    keep 开到 100 也漏。

    ★ 所以这不是一个可以调优的参数，是一个**赌注**。
    而它的赔率取决于你事先不知道的东西。

四 · **噪声的危害不只是浪费 token。**

    看"噪声"列。那些无关片段会**稀释注意力**（L05x）并且提高幻觉概率：
    模型看到 src/auth/password.py 里的"登录失败超过 5 次锁定账号"，
    就可能编出"登录偶尔失败是因为触发了防爆破锁定"——
    **一个完全讲得通、有材料支撑、而且错的答案。**

    这是 RAG 最常见的一种自伤：**为了提高召回率而降低了答案质量。**
    而召回率涨了这件事在指标上看得见，答案变差看不见。

【TODO】

  1. 把 agentic 的 max_rounds 从 4 改成 1。它退化成什么？
     和 one_shot(task, 3) 的结果完全一样吗？为什么？

  2. 把 TASKS 里的 follow_up 和 probes 全部清空，再跑探索型那两个。
     ★ 这模拟的是**大多数人实际实现出来的 agentic search**：
     它确实调了 search 工具好几次，但每轮的 query 都差不多。
     它比一次性检索强吗？强在哪、贵多少？

  3. 给 FILLER_TOPICS 再加 50 个无关模块（语料翻一倍）。
     哪一种策略退化得最快？为什么 keep 越大退化越明显？

  4. 把 search_once 里的 rrf 换成"只用 _vec"，再换成"只用 _kw"。
     三种配置在"定点"和"探索"两类问题上的表现分别怎么变？
""")


if __name__ == "__main__":
    main()
