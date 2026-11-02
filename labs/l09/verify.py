"""验证 l09/retrieve.py。

    uv run python -m l09.verify

一次 API 都不调，**包括不调 embedding**。

这套测试里有一整组专门盯着**静默失效**：
中文分词返回空、负 IDF 反向扣分、融合被量纲支配、重排负分意外过滤、
装配静默截断、引用校验把"行号凑的"当成合法。

★ 它们的共同点是**不抛异常**。检索坏掉的样子从来不是报错，
是"搜出来的东西看着还行，但少了最关键的那一片"——
而少了什么你不会知道，因为你没有对照。

另有三项是 Python 通道独有的（都标了「Python」）：
内置 hash() 的随机盐、`\\w` 的 Unicode 语义、frozen dataclass 不改入参。

先跑 VERIFY_TARGET=shared 确认测试本身是对的：
    VERIFY_TARGET=shared uv run python -m l09.verify
"""

from __future__ import annotations

import math
import os
import re
import subprocess
import sys
from collections.abc import Callable
from typing import Any

_target = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _target == "shared":
    from shared import retrieval as R
else:
    from l09 import retrieve as R  # type: ignore[no-redef]

print(
    "\n（测的是 shared/ 里的参考实现）" if _target == "shared" else "\n（测的是 l09/ 里你的实现）"
)

_passed = 0
_failures: list[str] = []


def test(name: str, fn: Callable[[], Any]) -> None:
    global _passed
    try:
        fn()
        _passed += 1
        print(f"\033[32m  ✓\033[0m {name}")
    except Exception as err:  # noqa: BLE001 - 测试跑器要吞掉一切
        _failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        print(f"\033[31m      {err}\033[0m")


def ok(cond: Any, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def raises(fn: Callable[[], Any], hint: str) -> None:
    try:
        fn()
    except NotImplementedError:
        raise
    except Exception:
        return
    raise AssertionError(f"应该抛异常但没有：{hint}")


CODE = """import hashlib

# 会话令牌的签发与校验。
class TokenPayload:
    user_id: str


def sign_token(payload, secret):
    body = dumps(payload)
    sig = hashlib.sha256((body + secret).encode()).hexdigest()
    return b64encode(body.encode()).decode() + "." + sig


def verify_token(token, secret):
    b64, _, sig = token.partition(".")
    if not b64 or not sig:
        return None
    body = b64decode(b64).decode()
    if loads(body)["expires_at"] < time():
        return None
    return loads(body)


def load_secret(path):
    raw = Path(path).read_text().strip()
    if len(raw) < 32:
        raise ValueError("SECRET_TOO_SHORT: 密钥至少 32 字节")
    return raw
"""


def chunk(
    cid: str,
    text: str = "x",
    source: str = "a.py",
    lines: tuple[int, int] = (1, 1),
    path: str | None = None,
) -> Any:
    return R.Chunk(id=cid, text=text, source=source, lines=lines, path=path)


def scored(cid: str, score: float, via: str = "vector") -> Any:
    return R.Scored(chunk=chunk(cid, source=cid.split("#")[0]), score=score, via=via)


# ─────────────────────────────────────────────────────────────
print("\n固定窗口分块")
# ─────────────────────────────────────────────────────────────


def _t() -> None:
    cs = R.chunk_fixed(CODE, "a.py", size=200)
    ok(len(cs) > 1, f"size=200 应该切出多块，实际 {len(cs)}")
    ok(cs[0].lines[0] == 1, f"第一块起始行应该是 1，实际 {cs[0].lines[0]}")
    total = len(CODE.split("\n"))
    ok(cs[-1].lines[1] >= total - 1, f"最后一块没到文件尾（{cs[-1].lines[1]} vs {total}）")


test("切出多块，行号 1-based", _t)


def _t() -> None:
    cs = R.chunk_fixed(CODE, "a.py", size=200)
    ok(all(c.source == "a.py" for c in cs), "有块的 source 不对")
    ok(len({c.id for c in cs}) == len(cs), "id 有重复")


test("每块都带 source 和唯一 id", _t)


def _t() -> None:
    cs = R.chunk_fixed(CODE, "a.py", size=150)
    covered: set[int] = set()
    for c in cs:
        covered.update(range(c.lines[0], c.lines[1] + 1))
    total = len(CODE.split("\n"))
    missing = [i for i in range(1, total) if i not in covered]
    ok(
        not missing,
        f"第 {'、'.join(map(str, missing))} 行没被任何块覆盖。\n"
        "      这是分块最常见的静默 bug：内容丢了，而检索"
        '"正常工作"——\n'
        "      它照样返回结果，只是永远返回不了那几行",
    )


test("★ 内容不能丢：每一行至少出现在一块里", _t)


def _t() -> None:
    cs = R.chunk_fixed(CODE, "a.py", size=150)
    overlapped = any(c.lines[0] <= cs[i].lines[1] for i, c in enumerate(cs[1:]))
    ok(
        overlapped,
        "相邻块的行范围完全不相交，也就是 overlap 默认为 0。\n"
        "      固定窗口一定会在某处把一个语义单元切成两半——\n"
        "      重叠让被切断的那部分在两个块里都完整出现一次",
    )


test("★ 默认有重叠（重叠不是可选项）", _t)


def _t() -> None:
    raises(
        lambda: R.chunk_fixed(CODE, "a.py", size=100, overlap=100),
        "overlap 等于 size：cursor 永远推进不了。\n"
        "      静默的后果是进程卡死或者内存爆掉，而卡死比报错难查得多",
    )


test("★ overlap >= size 要抛错（否则是死循环）", _t)


def _t() -> None:
    long = 'x = "' + "a" * 5000 + '"'
    cs = R.chunk_fixed(long, "a.py", size=100)
    ok(len(cs) >= 1, "一块都没有")
    ok(len(cs) < 50, f"一行 5000 字符切出了 {len(cs)} 块，说明推进逻辑有问题")


test("单行超长也能推进（不死循环）", _t)


def _t() -> None:
    ok(isinstance(R.chunk_fixed("", "a.py"), list), "应该返回列表")


test("空文本不崩", _t)


def _t() -> None:
    cs = R.chunk_fixed(CODE, "a.py", size=200, overlap=0)
    starts = [c.lines[0] for c in cs]
    ok(
        starts == sorted(set(starts)),
        f"overlap=0 时起始行不严格递增：{starts}。\n"
        "      overlap=None（没传）和 overlap=0（显式要求不重叠）是两件事，\n"
        "      而 `overlap or int(size*0.15)` 这种写法会把后者也当成前者",
    )


test("★ Python：overlap=0 是合法的显式选择，不能被当成「没传」", _t)


# ─────────────────────────────────────────────────────────────
print("\n结构感知分块")
# ─────────────────────────────────────────────────────────────


def _t() -> None:
    paths = [c.path for c in R.chunk_by_structure(CODE, "a.py")]
    for name in ["sign_token", "verify_token", "load_secret", "TokenPayload"]:
        ok(name in paths, f"没有 path={name} 的块，实际 {paths}")


test("顶层声明各自成块，带 path", _t)


def _t() -> None:
    cs = R.chunk_by_structure(CODE, "a.py")
    vt = next((c for c in cs if c.path == "verify_token"), None)
    ok(vt is not None, "找不到 verify_token 那一块")
    ok(
        "def verify_token" in vt.text and "return loads(body)" in vt.text,
        "签名和函数体不在同一块里。\n"
        "      被切成两半的函数在向量空间里既不像原函数、也不像别的东西——\n"
        "      它是一个语义上的噪声，而且两半都召不回来",
    )


test("★ 函数体不能被切开", _t)


def _t() -> None:
    cs = R.chunk_by_structure(CODE, "a.py")
    ok("import hashlib" in cs[0].text, f"第一块没包含 import：{cs[0].text[:40]}")
    ok(cs[0].lines[0] == 1, "第一块不是从第 1 行开始")


test("第一个声明之前的内容单独成块", _t)


def _t() -> None:
    src = "class Foo:\n    def bar(self):\n        return 1\n\n    def baz(self):\n        return 2"
    cs = R.chunk_by_structure(src + "\n", "a.py")
    named = [c for c in cs if c.path and not c.path.startswith("(")]
    ok(len(named) == 1, f"应该只有 Foo 一块，实际 {[c.path for c in cs]}")


test("缩进的成员跟着父级，不单独成块", _t)


def _t() -> None:
    big = "def huge():\n" + "    do_thing()\n" * 400
    cs = R.chunk_by_structure(big, "a.py", max_size=600)
    ok(len(cs) > 1, f"6000 字符的函数在 max_size=600 下应该被切开，实际 {len(cs)} 块")
    ok(
        all(c.path and re.search(r"huge|第", c.path) for c in cs),
        f"有片段没带定位信息：{[c.path for c in cs]}。\n"
        "      模型要知道"
        "「这是 huge 的第 2/7 片」"
        "，而不是收到一段无主的代码",
    )


test("★ 超大结构再切，但每片都带 path 定位", _t)


def _t() -> None:
    cs = R.chunk_by_structure("这是一段纯中文说明。\n没有任何代码声明。\n第三行。\n", "doc.md")
    ok(len(cs) >= 1, "一块都没有——认不出结构不能返回空")
    ok(
        all(c.path and re.search(r"降级|fallback|固定窗口", c.path) for c in cs),
        f"降级了但没标记（path={[c.path for c in cs]}）。\n"
        "      静默降级的后果是你以为在用结构分块，其实一半文件走了固定窗口——\n"
        "      而质量差异会被归因到 embedding 上，然后你去调 embedding",
    )


test("★ 认不出结构时降级要可见，不能静默", _t)


def _t() -> None:
    src = R.chunk_fixed("这是纯散文。\n第二行。\n", "doc.md")
    R.chunk_by_structure("这是纯散文。\n第二行。\n", "doc.md")
    ok(
        all(c.path is None for c in src),
        "chunk_by_structure 的降级改到了 chunk_fixed 返回的对象上。\n"
        "      Chunk 是 frozen dataclass，加字段要用 dataclasses.replace 造新的，\n"
        "      而不是就地改——就地改在 frozen 上会抛，不 frozen 的话会静默共享",
    )


test("★ Python：降级标记不能改到原对象上（frozen dataclass）", _t)


# ─────────────────────────────────────────────────────────────
print("\n假 embedding 与向量检索")
# ─────────────────────────────────────────────────────────────


def _t() -> None:
    a = R.fake_embed("verify_token 校验签名")
    b = R.fake_embed("verify_token 校验签名")
    ok(a == b, "两次结果不同")


test("确定：同样输入同样输出", _t)


def _t() -> None:
    ok(len(R.fake_embed("abc")) == 64, "默认维度不是 64")
    ok(len(R.fake_embed("abc", 16)) == 16, "dim 参数没生效")


test("维度可配，默认 64", _t)


def _t() -> None:
    v = R.fake_embed("some text here for embedding")
    norm = math.hypot(*v)
    ok(
        abs(norm - 1) < 1e-9,
        f"模长 {norm:.4f}，不是 1。\n"
        "      不归一化的话余弦要每次都除模长，而更常见的错是忘了除——\n"
        "      于是"
        "「长文档天然得分高」"
        "，检索结果被文档长度支配",
    )


test("★ 归一化：模长为 1（否则余弦不能用点积算）", _t)


def _t() -> None:
    for s in ["", "a", "ab"]:
        v = R.fake_embed(s)
        ok(
            all(math.isfinite(x) for x in v),
            f"fake_embed({s!r}) 里有 nan——除零没保护。\n"
            "      ★ math.hypot() 对空序列返回 0.0，而 0.0 当除数就是 ZeroDivisionError\n"
            "      或者 nan。nan 的比较永远是 False，表现为"
            "「排序结果随机」",
        )


test("★ 空文本不能产出 nan（math.hypot 对空序列返回 0）", _t)


def _t() -> None:
    v = R.fake_embed("hello world")
    ok(abs(R.cosine(v, v) - 1) < 1e-9, f"实际 {R.cosine(v, v)}")


test("自己和自己的余弦是 1", _t)


def _t() -> None:
    q = R.fake_embed("verify_token")
    near = R.cosine(q, R.fake_embed("def verify_token(token, secret):"))
    far = R.cosine(q, R.fake_embed("账单生成与税率计算"))
    ok(near > far, f"near={near:.3f} 不大于 far={far:.3f}")


test("字面重合度高的更相似", _t)


def _t() -> None:
    code = (
        "import sys; sys.path.insert(0, '.');"
        f"from {'shared.retrieval' if _target == 'shared' else 'l09.retrieve'} import fake_embed;"
        "print(fake_embed('稳定性测试 stable')[:4])"
    )
    outs = {
        subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            env={**os.environ, "PYTHONHASHSEED": str(seed)},
        ).stdout.strip()
        for seed in (1, 999)
    }
    ok(
        len(outs) == 1,
        "两次不同 PYTHONHASHSEED 下的向量不一样：\n"
        f"      {outs}\n"
        "      ★ 你用了内置的 hash()。它对 str 加了随机盐，\n"
        "      于是**索引一重启就失效**——而失效的方式是"
        "「检索结果变差了一点」"
        "，\n"
        "      没有报错、没有告警。自己写个 31 进制的滚动哈希",
    )


test("★ Python：跨进程稳定（别用内置 hash()）", _t)


def _t() -> None:
    idx = R.VectorIndex()
    cs = R.chunk_by_structure(CODE, "a.py")
    idx.add(cs)
    ok(idx.size == len(cs), f"size={idx.size}，应该是 {len(cs)}")
    hits = idx.search("令牌校验", 2)
    ok(len(hits) == 2, f"k=2 返回了 {len(hits)} 个")
    ok(
        all(h.via == "vector" for h in hits),
        "via 没标成 vector——混合检索里没这个字段你没法调权重",
    )
    ok(hits[0].score >= hits[1].score, "没按分数降序")


test("向量索引：size 与 k 生效，via=vector", _t)


def _t() -> None:
    ok(R.VectorIndex().search("anything", 3) == [], "空索引应该返回空")


test("空索引搜索返回空列表，不崩", _t)


def _t() -> None:
    idx = R.VectorIndex()
    idx.add(
        [
            chunk("src/login.py#1", text="a = 1", source="src/login.py", path="a"),
            chunk("src/billing/tax.py#1", text="a = 1", source="src/billing/tax.py", path="a"),
        ]
    )
    top = idx.search("login", 1)[0]
    ok(
        top.chunk.source == "src/login.py",
        "搜 "
        "「login」"
        f" 命中的是 {top.chunk.source}。\n"
        "      ★ 文件路径是最强的检索信号之一，而只索引正文的话你压根搜不到它。\n"
        "      两个片段的正文完全一样，唯一的区别就在路径上",
    )


test("★ 索引内容要含出处：搜文件名要能命中", _t)


# ─────────────────────────────────────────────────────────────
print("\n分词")
# ─────────────────────────────────────────────────────────────


def _t() -> None:
    t = R.tokenize("getUserById")
    ok(
        "user" in t and "id" in t,
        f"实际 {t}。不切驼峰的话，代码检索里最常见的一类查询直接失效",
    )


test('★ 驼峰要切开（否则搜 "user id" 匹配不到 getUserById）', _t)


def _t() -> None:
    t = R.tokenize("max_login_attempts")
    ok("login" in t and "attempts" in t, f"实际 {t}")
    ok("store" in R.tokenize("src/session/store.py"), "路径没切开")


test("下划线和路径分隔符也切", _t)


def _t() -> None:
    ok("secret" in R.tokenize("SECRET_TOO_SHORT"), "没转小写")


test("大小写归一", _t)


def _t() -> None:
    t = R.tokenize("登录偶尔失败")
    ok(
        len(t) >= 4,
        f"「登录偶尔失败」只切出 {t}。\n"
        "      ★ Python 的 `\\w` 默认匹配中文，所以 TS 里"
        "「用 [^a-z0-9]+ 取反去 split」"
        "\n"
        "      那种写法搬过来行为会变——整句变成一个 token，\n"
        "      于是它匹配不到任何东西，而 BM25 会**安静地返回空列表**。\n"
        "      代码不报错、索引也建起来了，只是搜什么都搜不到",
    )


test("★ Python：中文必须切出东西（`\\w` 的 Unicode 语义）", _t)


def _t() -> None:
    t = R.tokenize("登录失败")
    ok(
        "登录" in t,
        f"实际 {t}。\n"
        "      只切单字的话，「的」「是」这种字到处都有，IDF 把它们压到接近 0，\n"
        "      而真正有信息量的"
        "「登录」"
        "这个词从来没作为一个整体被索引过",
    )


test("★ 中文要有二元组（单字的区分度太低）", _t)


def _t() -> None:
    t = R.tokenize("调用 get_session 之后返回 None")
    ok("get" in t and "session" in t, f"英文部分丢了：{t}")
    ok(any(re.search(r"[\u4e00-\u9fa5]", x) for x in t), f"中文部分丢了：{t}")


test("中英混排都要切到", _t)


def _t() -> None:
    t = R.tokenize("  a---b  //  c  ")
    ok(all(len(x) > 0 for x in t), f"有空串：{t}。空 token 会污染 df 统计")


test("不产出空串", _t)


# ─────────────────────────────────────────────────────────────
print("\nBM25")
# ─────────────────────────────────────────────────────────────

DOCS = [
    chunk("a#1", source="a.py", text='if len(raw) < 32: raise ValueError("SECRET_TOO_SHORT")'),
    chunk("b#1", source="b.py", text="def sign_token(payload, secret): return sign(payload)"),
    chunk("c#1", source="c.py", text='def fmt_bytes(n): return f"{n}B"'),
    chunk("d#1", source="d.py", text="def calc_tax(amount): return amount * 0.06"),
]


def _t() -> None:
    kw = R.Bm25Index()
    kw.add(DOCS)
    top = kw.search("SECRET_TOO_SHORT", 3)[0]
    ok(top.chunk.id == "a#1", f"Top1 是 {top.chunk.id}，应该是 a#1")


test("★ 精确错误码：BM25 完胜（这是它存在的理由）", _t)


def _t() -> None:
    kw = R.Bm25Index()
    kw.add(DOCS)
    hits = kw.search("def token", 2)
    ok(len(hits) <= 2, f"k=2 返回了 {len(hits)} 个")
    ok(all(h.via == "bm25" for h in hits), "via 没标成 bm25")
    ok(all(hits[i - 1].score >= h.score for i, h in enumerate(hits) if i), "没降序")


test("via=bm25，降序，k 生效", _t)


def _t() -> None:
    kw = R.Bm25Index()
    kw.add(DOCS)
    ok(kw.search("zzzz_nonexistent_term", 10) == [], "搜不存在的词还返回了结果")


test("零分的不返回（一个词都不匹配的片段不该占名额）", _t)


def _t() -> None:
    kw = R.Bm25Index()
    kw.add([chunk(f"x{i}#1", source=f"x{i}.py", text="common word here") for i in (1, 2, 3)])
    hits = kw.search("common", 5)
    ok(hits, "出现在全部文档里的词直接搜不到了")
    ok(
        all(h.score >= 0 for h in hits),
        f"有负分：{[round(h.score, 3) for h in hits]}。\n"
        "      idf 里那两个 0.5 是平滑项。少了它们，df 等于 N 时 IDF 变成 0 或负数，\n"
        "      而负分意味着"
        "「这个文档因为含有查询词而被扣分」"
        "——那是没有依据的",
    )


test('★ IDF 不能为负（否则"人人都有的词"反向扣分）', _t)


def _t() -> None:
    kw = R.Bm25Index()
    kw.add(
        [
            chunk("short#1", source="short.py", text="verify_token"),
            chunk("long#1", source="long.py", text="verify_token " + "filler words here " * 60),
        ]
    )
    top = kw.search("verify_token", 2)[0]
    ok(
        top.chunk.id == "short#1",
        f"Top1 是 {top.chunk.id}。b=0.75 的长度归一应该让只讲这一件事的短片段排前面",
    )


test("★ 长度归一：短文档不吃亏", _t)


def _t() -> None:
    kw = R.Bm25Index()
    kw.add(
        [
            chunk(
                "z#1", source="z.py", text="# Redis 客户端。连接池上限 2，超时 300ms，不自动重连。"
            ),
            chunk("y#1", source="y.py", text="# 账单生成。按月聚合。"),
        ]
    )
    hits = kw.search("连接池 超时", 2)
    ok(
        hits and hits[0].chunk.id == "z#1",
        f"中文查询返回 {[h.chunk.id for h in hits]}。\n"
        "      这条挂了通常不是 BM25 的问题，是 tokenize 的问题",
    )


test("★ 中文查询能召回中文内容", _t)


def _t() -> None:
    ok(R.Bm25Index().search("x", 3) == [], "空索引应该返回空（avg_len 会除零）")


test("空索引不崩", _t)


# ─────────────────────────────────────────────────────────────
print("\nRRF 融合")
# ─────────────────────────────────────────────────────────────


def _t() -> None:
    import dataclasses

    v = [scored("a#1", 0.91), scored("b#1", 0.90), scored("c#1", 0.89)]
    b = [scored("c#1", 12, "bm25"), scored("a#1", 8, "bm25")]
    before = [s.chunk.id for s in R.rrf([v, b])]
    after = [
        s.chunk.id
        for s in R.rrf(
            [
                [dataclasses.replace(s, score=s.score * 1000) for s in v],
                [dataclasses.replace(s, score=s.score / 1000) for s in b],
            ]
        )
    ]
    ok(
        before == after,
        f"放大分数改变了结果：{before} → {after}。\n"
        "      说明你用了分数而不是排名。而两路的分数不在同一个量纲上：\n"
        "      余弦挤在 0.7~0.95，BM25 是 0~几十，相加等于只用 BM25",
    )


test("★ 只用排名：一路的分数放大一千倍，结果不变", _t)


def _t() -> None:
    fused = R.rrf(
        [
            [scored("a#1", 0.9), scored("b#1", 0.8)],
            [scored("a#1", 5, "bm25"), scored("c#1", 3, "bm25")],
        ]
    )
    by_id = {s.chunk.id: s.via for s in fused}
    ok(by_id.get("a#1") == "both", f"a#1 的 via 是 {by_id.get('a#1')}，应该是 both")
    ok(by_id.get("b#1") == "vector", f"b#1 的 via 是 {by_id.get('b#1')}")
    ok(by_id.get("c#1") == "bm25", f"c#1 的 via 是 {by_id.get('c#1')}")


test("★ 两路都召回的标成 both", _t)


def _t() -> None:
    # a 在两路都排第 3；b 在向量里排第 1，BM25 里没有。
    v = [scored("b#1", 0.99), scored("x#1", 0.98), scored("a#1", 0.97)]
    k = [scored("y#1", 9, "bm25"), scored("z#1", 8, "bm25"), scored("a#1", 7, "bm25")]
    ids = [s.chunk.id for s in R.rrf([v, k])]
    ok(
        ids.index("a#1") < ids.index("b#1"),
        f"a#1 排第 {ids.index('a#1') + 1}，b#1 排第 {ids.index('b#1') + 1}。\n"
        "      k=60 的作用就是压低头部的权重差：没有 k 时第 1 和第 2 名差 0.5，\n"
        "      有 k 时差 0.0003。这让"
        "「两路共识」"
        "胜过"
        "「一路的第一名」",
    )


test("★ 两路都进前十 > 一路第一另一路没召回", _t)


def _t() -> None:
    fused = R.rrf([[scored("a#1", 0.9)], [scored("a#1", 5, "bm25")], [scored("a#1", 3, "bm25")]])
    ok(len(fused) == 1, f"去重失败，返回了 {len(fused)} 个")


test("去重：同一个 chunk 只出现一次", _t)


def _t() -> None:
    many = [scored(f"m{i}#1", 1 - i / 100) for i in range(30)]
    ok(len(R.rrf([many], 60, 5)) == 5, "limit 没生效")
    ok(R.rrf([]) == [], "空输入应该返回空")
    ok(R.rrf([[], []]) == [], "两个空列表应该返回空")


test("limit 生效，空输入不崩", _t)


# ─────────────────────────────────────────────────────────────
print("\n重排")
# ─────────────────────────────────────────────────────────────

CANDS = [
    R.Scored(
        chunk=chunk(
            "hit#1",
            source="auth.py",
            text="def load_secret(path):\n    if len(raw) < 32: raise",
            path="load_secret",
        ),
        score=0.5,
        via="both",
    ),
    R.Scored(
        chunk=chunk(
            "mid#1", source="auth.py", text="def sign_token(payload, secret):", path="sign_token"
        ),
        score=0.4,
        via="vector",
    ),
    R.Scored(
        chunk=chunk(
            "off#1",
            source="tax.py",
            text="def calc_tax(amount): return amount * 0.06",
            path="calc_tax",
        ),
        score=0.3,
        via="vector",
    ),
]


def _t() -> None:
    r = R.rerank_heuristic("load secret 最短长度", CANDS, keep=2, min_score=0)
    ok(len(r.kept) <= 2, f"keep=2 保留了 {len(r.kept)} 个")
    ok(all(r.kept[i - 1].score >= s.score for i, s in enumerate(r.kept) if i), "没降序")


test("keep 生效，降序", _t)


def _t() -> None:
    r = R.rerank_heuristic("load secret", CANDS, keep=1, min_score=0)
    ok(r.kept[0].chunk.id == "hit#1", f"Top1 是 {r.kept[0].chunk.id}")


test("词覆盖率高的排前面", _t)


def _t() -> None:
    r = R.rerank_heuristic("完全无关的查询词 zzzz", CANDS, keep=3, min_score=0.5)
    ok(
        len(r.kept) < 3,
        f"阈值 0.5 下还留了 {len(r.kept)} 个。\n"
        "      排序不解决"
        "「召回的全是噪声」"
        "这个问题——高阈值下就该什么都不留",
    )
    ok(
        any(re.search(r"阈值|低于|min_score", why) for _, why in r.dropped),
        f"dropped 的理由里没区分「低于阈值」和「排名靠后」：{[w for _, w in r.dropped]}",
    )


test('★ min_score 是闸：没有它，"重排"只是重新排序', _t)


def _t() -> None:
    r = R.rerank_heuristic("load secret", CANDS, keep=1, min_score=0)
    ok(
        len(r.kept) + len(r.dropped) == len(CANDS),
        f"进去 {len(CANDS)} 个，出来 {len(r.kept)}+{len(r.dropped)} 个。候选凭空消失了",
    )
    ok(
        all(isinstance(why, str) and why for _, why in r.dropped),
        "有 dropped 没带理由。「为什么这段代码没被用上」是排查检索问题唯一有用的东西",
    )


test("★ dropped 必须带理由，且不丢候选", _t)


def _t() -> None:
    one = R.Scored(chunk=chunk("p#1", source="p.py", text="alpha beta"), score=0, via="vector")
    two = R.Scored(chunk=chunk("q#1", source="q.py", text="alpha beta"), score=0, via="both")
    r = R.rerank_heuristic("alpha beta", [one, two], keep=2, min_score=0)
    ok(r.kept[0].chunk.id == "q#1", f"两路召回的没排前面（Top1 是 {r.kept[0].chunk.id}）")


test("via=both 加分", _t)


def _t() -> None:
    huge = R.Scored(
        chunk=chunk("huge#1", source="h.py", text="filler word " * 3000),
        score=0.1,
        via="vector",
    )
    r = R.rerank_heuristic("zzzz 完全不匹配", [huge], keep=5, min_score=0)
    ok(
        len(r.kept) == 1,
        "min_score=0 本该"
        "「什么都不过滤」"
        "，结果过滤掉了。\n"
        "      长度惩罚把一个无关片段压成了负分，而负分 < 0 于是被闸掉了。\n"
        "      这种 bug 表现为"
        "「检索突然一片都不返回」"
        "，非常难查",
    )


test("★ 分数不能为负（负分会让 min_score=0 意外过滤）", _t)


def _t() -> None:
    r = R.rerank_heuristic("q", [], keep=3)
    ok(not r.kept and not r.dropped, "空候选应该两个都空")


test("空候选不崩", _t)


def _t() -> None:
    r = R.rerank_heuristic("", CANDS, keep=2, min_score=0)
    ok(
        all(math.isfinite(s.score) for s in r.kept),
        "空查询产出了 nan 分数——q_toks 为空时的除零",
    )


test("空查询不崩（不能除零）", _t)


def _t() -> None:
    before = [s.score for s in CANDS]
    R.rerank_heuristic("load secret", CANDS, keep=1, min_score=0)
    ok(
        [s.score for s in CANDS] == before,
        f"入参的 score 被改了：{before} → {[s.score for s in CANDS]}。\n"
        "      ★ 重排要产出新的 Scored（dataclasses.replace），别就地改。\n"
        "      就地改的后果是同一批候选跑两次重排结果不一样，\n"
        "      而这种 bug 只在"
        "「重试」"
        "的路径上出现，平时测不出来",
    )


test("★ Python：重排不改入参（dataclasses.replace）", _t)


# ─────────────────────────────────────────────────────────────
print("\n该不该检索")
# ─────────────────────────────────────────────────────────────


def route(**kw: Any) -> Any:
    base = dict(
        corpus_size=20_000,
        corpus_tokens=4_000_000,
        budget_tokens=200_000,
        has_exact_terms=False,
        needs_exploration=False,
    )
    return R.choose_retrieval(R.RouteInput(**{**base, **kw}))


def _t() -> None:
    d = route(corpus_size=300, corpus_tokens=40_000)
    ok(
        d.mode == "none",
        f"返回了 {d.mode}。语料只占预算 20%，全塞进去。\n"
        "      检索的收益是省钱和降延迟，代价是**可能漏掉相关内容**——\n"
        "      而漏掉的那部分你不会知道。全塞没有这个风险",
    )


test("★ 语料塞得下就别检索", _t)


def _t() -> None:
    d = route(has_exact_terms=True)
    ok(
        d.mode == "lookup",
        f"返回了 {d.mode}。grep 在这个场景里打败任何 embedding：\n"
        "      它精确、免费，而且**失败是响亮的**——找不到就是找不到，\n"
        "      不会给你一个"
        "「最相似」"
        "的错答案",
    )


test("★ 有精确标识符 → lookup，而不是向量", _t)


def _t() -> None:
    ok(
        route(needs_exploration=True).mode == "agentic",
        f"返回了 {route(needs_exploration=True).mode}",
    )


test("★ 要找什么本身不确定 → agentic", _t)


def _t() -> None:
    d = route(has_exact_terms=True, needs_exploration=True)
    ok(
        d.mode == "agentic",
        f"返回了 {d.mode}。有精确词但需要探索时，一次 grep 解决不了——\n"
        "      第一次搜到什么决定第二次搜什么",
    )


test("★ 探索优先于 lookup（两个都为真时）", _t)


def _t() -> None:
    ok(route().mode == "search", f"返回了 {route().mode}")


test("剩下的才是经典 RAG", _t)


def _t() -> None:
    d = route(corpus_tokens=10_000, needs_exploration=True, has_exact_terms=True)
    ok(
        d.mode == "none",
        f"返回了 {d.mode}。判据的顺序是故意的：从最便宜的开始，够用就停。\n"
        "      语料全在上下文里的时候，"
        "「探索」"
        "这件事模型自己就能做完",
    )


test('★ "塞得下"优先于一切（连 agentic 都让位）', _t)


def _t() -> None:
    for kw in [
        {"corpus_tokens": 1000},
        {"has_exact_terms": True},
        {"needs_exploration": True},
        {},
    ]:
        d = route(**kw)
        ok(d.why and len(d.why) > 8, f"{d.mode} 的 why 太短或没有：{d.why!r}")


test("每个分支都要有 why", _t)


# ─────────────────────────────────────────────────────────────
print("\n装配上下文")
# ─────────────────────────────────────────────────────────────


def _t() -> None:
    parts = R.chunk_by_structure(CODE, "a.py")
    got = R.assemble("令牌怎么签名", parts, budget=4000)
    for c in got.used:
        ok(
            f"{c.source}:{c.lines[0]}-{c.lines[1]}" in got.text,
            f"{c.id} 的出处没写进文本。\n"
            "      不可验证的引用等于没有引用——用户没法确认，于是只能信",
        )


test("★ 每片都带出处和行号", _t)


def _t() -> None:
    got = R.assemble("q", R.chunk_by_structure(CODE, "a.py"), budget=4000)
    ok(
        re.search(r"不知道|没有相关信息|不要编|无法回答", got.text),
        "装配出来的文本里没有这句话。\n"
        "      光给材料不给这句话，模型会在材料不够时用先验知识补——\n"
        "      **而那正是 RAG 想避免的事**",
    )


test('★ 必须写明"没有依据就说不知道"', _t)


def _t() -> None:
    parts = R.chunk_by_structure(CODE, "a.py")
    got = R.assemble("q", parts, budget=220)
    ok(len(got.used) < len(parts), f"预算 220 应该装不下全部 {len(parts)} 块")
    ok(
        len(got.used) + len(got.truncated) == len(parts),
        f"进去 {len(parts)} 块，出来 used={len(got.used)} + truncated={len(got.truncated)}。\n"
        "      静默截断的后果是模型基于不完整的证据回答，\n"
        "      而它不知道自己看的不完整，**于是语气一样自信**",
    )


test("★ 被预算砍掉的必须报出来", _t)


def _t() -> None:
    got = R.assemble("一个不算短的查询问题放在这里", R.chunk_by_structure(CODE, "a.py"), budget=400)
    ok(
        got.tokens <= 400,
        f"实际 {got.tokens} token，超了预算 400。\n"
        "      header/footer 和 query 本身也占 token。不扣的话每次都超一点，\n"
        "      而超出的表现是最后一片被 API 截断——你看不到那件事发生",
    )


test("★ 预算是硬上限（header/footer 和 query 都要扣）", _t)


def _t() -> None:
    parts = R.chunk_by_structure(CODE, "a.py")
    got = R.assemble("q", parts, budget=100_000)
    ok(not got.truncated, f"预算充足还砍了 {len(got.truncated)} 块")
    ok(len(got.used) == len(parts), "used 不全")


test("预算够时全部装进去", _t)


def _t() -> None:
    got = R.assemble("q", R.chunk_by_structure(CODE, "a.py"), budget=4000, estimate=len)
    ok(got.tokens == len(got.text), f"自定义 estimate 没生效（{got.tokens} vs {len(got.text)}）")


test("estimate 可替换，且 text 与 tokens 同源", _t)


def _t() -> None:
    got = R.assemble("q", [chunk("z#1", source="z.md", text="中" * 200)], budget=4000)
    ok(
        got.tokens >= 200,
        f"200 个汉字估成了 {got.tokens} token。中文约 1 token/字，按 1/4 估会低估四倍",
    )


test("CJK 估算不能按 4 字符 1 token 算", _t)


def _t() -> None:
    got = R.assemble("q", [], budget=1000)
    ok(not got.used and got.tokens > 0, "空列表也该有 header/footer")


test("空片段列表不崩", _t)


# ─────────────────────────────────────────────────────────────
print("\n引用校验")
# ─────────────────────────────────────────────────────────────

PROVIDED = [
    chunk("a#1", source="auth.py", lines=(11, 15)),
    chunk("a#2", source="auth.py", lines=(20, 30)),
    chunk("b#1", source="store.py", lines=(1, 9)),
]


def _t() -> None:
    c = R.check_citations("见 auth.py:11-15 和 store.py:1-9。", PROVIDED)
    ok("auth.py:11-15" in c.cited and "store.py:1-9" in c.cited, f"实际 {c.cited}")


test("抽出所有引用", _t)


def _t() -> None:
    c = R.check_citations("见 auth.py:11-15。", PROVIDED)
    ok(not c.unknown_source, f"误报 unknown_source：{c.unknown_source}")
    ok(not c.wrong_range, f"误报 wrong_range：{c.wrong_range}")


test("合法引用不报错", _t)


def _t() -> None:
    c = R.check_citations("实现在 src/crypto/hmac.py:8-20。", PROVIDED)
    ok(
        "src/crypto/hmac.py:8-20" in c.unknown_source,
        f"没抓到（unknown_source={c.unknown_source}）。\n"
        "      这类说明模型在用先验知识——prompt 里那句"
        "「不许编」"
        "没生效",
    )


test("★ 文件压根不在检索结果里 → unknown_source", _t)


def _t() -> None:
    c = R.check_citations("校验逻辑见 auth.py:120-140。", PROVIDED)
    ok(
        "auth.py:120-140" in c.wrong_range,
        f"没抓到（wrong_range={c.wrong_range}）。\n"
        "      ★ 这一类比 unknown_source 更隐蔽：文件名看着眼熟，\n"
        "      review 的人扫一眼就过了——而行号是模型凑的。\n"
        "      两类要分开报，因为处置不同：一类要改 prompt，一类能自动修",
    )


test("★ 文件对但行号凑的 → wrong_range（更隐蔽也更常见）", _t)


def _t() -> None:
    c = R.check_citations("auth.py:120-140 和 nope.py:1-2。", PROVIDED)
    ok(
        len(c.wrong_range) == 1 and len(c.unknown_source) == 1,
        f"wrong_range={c.wrong_range}，unknown_source={c.unknown_source}",
    )


test("★ 两类不能混为一谈", _t)


def _t() -> None:
    c = R.check_citations("只看了 auth.py:11-15。", PROVIDED)
    ok(
        "b#1" in c.unused,
        f"unused={c.unused}，应该含 b#1。\n"
        "      它是"
        "「检索召回了噪声」"
        "的信号，也是调 keep 的唯一依据",
    )
    ok("a#1" not in c.unused, "a#1 被引用了，不该在 unused 里")


test("★ unused：召回了但没被引用的片段", _t)


def _t() -> None:
    c = R.check_citations("auth.py:11-15 ... auth.py:11-15 ... auth.py:11-15", PROVIDED)
    ok(len(c.cited) == 1, f"实际 {len(c.cited)} 个")


test("重复引用只算一次", _t)


def _t() -> None:
    c = R.check_citations("我不知道。", PROVIDED)
    ok(not c.cited, "空答案不该抽出引用")
    ok(len(c.unused) == 3, f"unused={len(c.unused)}，应该是 3")


test("没有引用时全部 unused", _t)


# ─────────────────────────────────────────────────────────────

print("\n" + "─" * 60)
if not _failures:
    print(f"\033[32m全过。{_passed} 项。\033[0m")
    print("\n接着跑 uv run python -m l09.retrieve 看六组观察实验，再跑 l09.agentic。")
else:
    print(f"\033[31m{len(_failures)} 项没过（过了 {_passed} 项）：\033[0m")
    for f in _failures:
        print(f"\033[31m  · {f}\033[0m")
    print("\n先跑 VERIFY_TARGET=shared uv run python -m l09.verify 对照参考实现。")
    sys.exit(1)
