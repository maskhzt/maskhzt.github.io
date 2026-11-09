---
title: "Agent 系统讲解 08：结构化输出与校验修复"
date: 2026-11-09 11:00:00 +0800
permalink: /posts/agent-structured-output/
categories: [Agent, agent系统讲解]
tags: [agent, structured-output, json-schema, validation, retry, tool-calling]
description: "从自然语言为什么不能直接进程序讲起，给出 parse_json_reply + validate + repair 的最小实现，讲清三种约束手段的边界、修复提示怎么写、重试上限与降级，以及为什么工具参数也是结构化输出。"
---

<!-- series-nav -->
> **系列位置**：Agent 系统讲解，第 08 篇 / 共 18 篇
> **总目录**：[学习地图](/posts/agent-systematic-learning-map/)
> **上一篇**：[07：记忆：从 messages 到跨会话](/posts/agent-memory-and-recall/)
> **下一篇**：[09：Evals：从感觉调到用数字调](/posts/agent-evals/)


你让模型把商品信息整理成一条记录。

它回你：

```text
这个商品的价格大概是 30 元左右，不过要看有没有促销活动。
```

你写的是：

```python
price = float(reply)
```

然后程序崩了。

前七篇里，模型的输出要么是给人看的回答，要么是工具调用参数。

这一篇处理第三种情况：

```text
模型的输出，要直接喂给程序。
```

## 1. 为什么自然语言输出不能直接进程序

自然语言是给人和人之间用的。

它有三个特性，正好都是程序不需要的。

**它可以含糊。**

「大概 30 元左右」——30 是 29.9 还是 35？程序要一个数，它给了你一个区间加一个语气词。

**它可以省略。**

「有货」——有 3 件还是有 3000 件？

**它可以自相矛盾。**

「价格 30，不过要看促销，可能是 25 也可能不变」——三种可能，程序一种都用不了。

程序要的不是描述。

程序要的是**断言**。

```text
字段名是什么、类型是什么、必填哪几个、取值范围。
```

一句话：

```text
自然语言负责让人理解。
JSON 负责让程序继续往下走。
```

这两件事不能混。

混了以后，你的代码里就会出现这种东西：

```python
if "元左右" in reply:
    price = float(re.search(r"(\d+)", reply).group(1))
```

能跑。

跑到第 200 条数据的时候，遇到「约 30」「三十块」「¥30.00 起」，就崩了。

## 2. 三种手段，和它们的能力边界

想让模型稳定吐 JSON，工程上有三种手段。

它们不是替代关系，是强度递增的三层。

**手段一：在 prompt 里给 schema。**

```text
请输出一个 JSON 对象，字段是：
  name: 商品名，字符串
  price: 价格，数字，单位元
  stock: 库存，整数

只输出 JSON，不要解释，不要代码围栏。
```

能力边界：这只是**提示**。

模型可以不听。

短 schema 通常听，schema 一长，它就开始漏字段、加解释。

**手段二：JSON mode。**

很多 API 提供一个开关，叫 JSON mode 或 `response_format={"type": "json_object"}` 这类字段名。

（字段名各家不同，以你要用的模型文档为准。）

开了之后，模型的输出**语法上**一定是一个合法 JSON 对象。

能力边界很清楚：它只保证语法。

```text
它保证：能 json.loads 成功。
它不保证：字段叫 name 而不是 名称。
它不保证：price 是数字而不是 "30"。
它不保证：必填字段都在。
```

另外，公开文档里通常还要求 prompt 里出现「json」这个词，否则可能报错。

这一条也要按你用的模型对一遍。

**手段三：原生结构化输出 / 工具强制调用。**

有些 API 允许你把一个 JSON Schema 一起传进去。

有的接口会把 schema 变成解码约束，模型在生成时就被限制在合法结构里。

还有一条路：定义一个工具，参数 schema 就是你要的结构，然后强制模型调用这个工具。

能力边界依然存在：

```text
schema 的表达能力有限：递归、联合类型、复杂的条件约束，未必都支持。
约束强的地方，字段一定对；约束弱的地方（比如描述性字段），还是可能胡说。
必填字段偶发缺失，在真实系统里出现过。
```

一句提醒：

```text
没有任何一种手段能让"模型一定会给你正确的业务数据"。
它们只能让"形状"更稳，让"内容"仍然需要你校验。
```

形状和内容，是两件事。

**怎么选？**

按顺序问三个问题。

```text
你的接口有原生结构化输出吗？  有 → 用它
只有 JSON mode 吗？           有 → 用它 + 严格校验
什么都没有？                  → prompt 给 schema + 严格校验 + 修复
```

注意后两行里的「严格校验」。

不管用哪种手段，校验都不能省。

因为手段约束的是形状的下限，不是内容的正确。

这一篇剩下的部分，全在讲形状。

## 3. 三段循环：解析 → 校验 → 修复

结构化输出的工程形态，是一个三段循环。

```text
                ┌──────────────┐
   模型回复 ───▶ │ 1. 解析 parse │
                └──────┬───────┘
                       │ 不是 JSON → 错误
                       ▼
                ┌──────────────┐
                │ 2. 校验 validate │
                └──────┬───────┘
                       │ 不合 schema → 错误
                       ▼
                ┌──────────────┐
                │ 3. 修复 repair │──▶ 回到模型，带上错误
                └──────────────┘
                       │ 通过
                       ▼
                     数据
```

三段必须分开写。

因为三段失败的样子不一样。

```text
解析失败：模型连 JSON 都没给对。可能是围栏、可能是解释文字、可能是单引号。
校验失败：JSON 合法，但字段不对。缺字段、类型错、枚举值不在范围内。
修复失败：模型连续几次都改不对。这时候要降级，不是继续重试。
```

混在一起写会怎样？

你会得到一个 `try: ... except: retry` 的大块。

然后你不知道这次失败是「它包了围栏」还是「它把数字写成字符串」。

而这两种情况，修复提示要写的内容完全不同。

## 4. parse_json_reply()

第一段：从一段自由文本里，把 JSON 抠出来。

```python
import json
import re


def parse_json_reply(text: str) -> dict:
    """从模型回复里抠出一个 JSON 对象。失败抛 ValueError。"""
    if not isinstance(text, str):
        raise ValueError(f"回复不是字符串，而是 {type(text).__name__}")

    s = text.strip()

    # 1. 最常见的破坏：外面包了一层 json 代码围栏
    fence = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
    if fence:
        s = fence.group(1).strip()

    # 2. 第二常见：前后各加了一段解释
    if not s.startswith("{"):
        i, j = s.find("{"), s.rfind("}")
        if i < 0 or j <= i:
            raise ValueError("回复里找不到完整的 JSON 对象")
        s = s[i:j + 1]

    return json.loads(s)
```

十几行，处理了真实世界八成的坏输入。

几点说明。

**为什么先处理围栏，再找花括号？**

因为围栏里的内容可能包含解释文字，也可能不包含。

先剥围栏，再找边界，顺序错了会把围栏的反引号也算进去。

**为什么用 `rfind` 而不是 `find` 找右括号？**

因为 JSON 里可能有嵌套对象。

`{"a": {"b": 1}}` 的第一个 `}` 是内层的。

**`json.loads` 抛的异常要不要包？**

不要。

`json.JSONDecodeError` 是 `ValueError` 的子类。

外层统一接 `ValueError` 就够了，还省一层缩进。

**它故意不处理什么？**

数组。函数签名写的是 `-> dict`。

如果你的场景要顶层数组，单独写一个 `parse_json_array`。

不要让一个函数既返回 dict 又返回 list，调用方每次都要判断类型。

试几种输入：

```text
'{"name": "螺丝"}'                     → 直接过
围栏包着的同一个对象                    → 剥围栏
'好的，结果如下：{"name": "螺丝"}'      → 抠花括号
```

### 流式输出下怎么攒完整 JSON

打开流式之后，你收到的不再是一条完整回复。

是一串增量。

```text
data: {"choices":[{"delta":{"content":"{\"name\":"}}]}
data: {"choices":[{"delta":{"content":" \"螺丝\","}}]}
data: {"choices":[{"delta":{"content":" \"price\": 0.5}"}}]}
```

拼起来才是 `{"name": "螺丝", "price": 0.5}`。

工具调用也一样。

`arguments` 是分批到达的字符串片段。

```text
第 1 片：{"a":
第 2 片：100,
第 3 片："b": 4}
```

所以三件事要记住。

```text
一、流式下不能边收边 json.loads。半截 JSON 永远解析失败。
二、片段要按顺序拼，拼完再解析。
三、失败重试时整段重收，不要只补最后一片。
```

拼接代码很短。

```python
def collect_text(chunks) -> str:
    buf = []
    for ch in chunks:
        buf.append(ch.get("content") or "")
    return "".join(buf)
```

工具调用要按 `index` 分桶。

```python
def collect_tool_calls(chunks) -> list[dict]:
    slots = {}
    for ch in chunks:
        for tc in ch.get("tool_calls", []):
            slot = slots.setdefault(tc["index"], {"name": "", "arguments": ""})
            slot["name"] += tc.get("function", {}).get("name") or ""
            slot["arguments"] += tc.get("function", {}).get("arguments") or ""
    return [slots[i] for i in sorted(slots)]
```

注意 `index`。

一轮里模型可以并发发多个调用，片段会交错到达。

不分桶，你会把两个调用的参数拼在一起。

得到一段语法合法、语义全错的 JSON。

拼完之后，流程和不流式一模一样。

```text
拼接 → parse_json_reply → validate → 失败则 repair
```

还有一个选择：要不要边收边展示。

```text
回答类场景：边收边打，用户要的是"它在说话"
结构化场景：攒完再渲染，半截 JSON 对用户没有意义
```

一句：

```text
流式改变的是"你什么时候拿到全文"，不改变"你怎么校验"。
```

## 5. validate()

第二段：JSON 合法了，但它符合你的契约吗？

先用标准库写一个能跑的最小版本。

```python
_TYPES = {"object": dict, "array": list, "string": str,
          "boolean": bool, "number": (int, float), "integer": int}


def _validate_minimal(obj, schema) -> list[str]:
    errors = []
    if not isinstance(obj, dict):
        return [f"顶层应该是 object，实际是 {type(obj).__name__}"]
    for key in schema.get("required", []):
        if key not in obj:
            errors.append(f"缺少必填字段 {key!r}")
    for key, spec in schema.get("properties", {}).items():
        if key not in obj:
            continue
        want = spec.get("type")
        py = _TYPES.get(want)
        if py and not isinstance(obj[key], py):
            errors.append(f"字段 {key!r} 应为 {want}，实际是 {type(obj[key]).__name__}")
    return errors


def validate(obj, schema) -> list[str]:
    """返回错误列表。空列表 = 通过。"""
    try:
        import jsonschema
    except ImportError:
        return _validate_minimal(obj, schema)     # 没装也能跑
    try:
        jsonschema.validate(obj, schema)
        return []
    except jsonschema.ValidationError as exc:
        path = ".".join(str(p) for p in exc.absolute_path) or "<root>"
        return [f"{path}: {exc.message}"]
```

装了就走上半，没装走下半。

这个设计的重点不是「兼容」，是**错误信息的形状要一致**。

两个分支都返回 `list[str]`。

因为下一段（repair）只关心「有一组可以用人话描述的错误」。

`jsonschema` 那一路有个细节值得学：`exc.absolute_path` 告诉你错在第几层。

`["items", 0, "price"]` 会被拼成 `items.0.price`。

比一句「校验失败」有用一百倍。

最小版本有两个坑，得说清楚。

**坑一：`bool` 是 `int` 的子类。**

```python
isinstance(True, int)      # True
```

所以 `{"stock": True}` 在最小版本里会被当成整数放过。

真装了 `jsonschema` 就不会，它专门排除了 bool。

**坑二：它只查 type 和 required。**

`enum`、`minimum`、`maxLength`、`pattern`、`additionalProperties` 全都不管。

够用，但不要以为它在做完整校验。

### schema 怎么写，模型才不容易错

五条硬建议。

```text
一、必填字段越少越好
二、能用 enum 就别用自由文本
三、不要用 oneOf / anyOf 这种"二选一"结构
四、嵌套不超过两层
五、description 写单位，不写形容词
```

**必填越少越好。**

`required` 里每多一个字段，整体失败率就乘一次。

八个字段全必填，模型错一个就整体失败。

把「最好也有」的字段从 `required` 拿掉，失败率立刻降。

缺了再补，或者给默认值。

**能用 enum 就用 enum。**

```json
{"status": {"type": "string", "enum": ["待付款", "已付款", "已发货"]}}
```

三个选项摆在那，模型几乎不会错。

换成「状态，字符串」，它会写出「已支付」「付款完成」「PAID」。

**不要用 oneOf。**

它是 schema 里最容易把模型绕晕的结构。

```text
"要么是字符串，要么是对象" → 模型会给你两种的一半
```

真需要两种形状，拆成两次调用。

**嵌套不超过两层。**

第三层开始，模型漏字段的概率明显上升。

能拍平就拍平。

```text
{"user": {"city": "杭州"}}  →  {"user_city": "杭州"}
```

**description 写单位，不写形容词。**

```text
price: "价格，单位：分"     ← 有用
price: "价格，合理即可"     ← 没用
```

一句：

```text
schema 的复杂度，和失败率是绑在一起的。
每加一层结构，都要问一句"真的需要吗"。
```

## 6. repair()

第三段：把错误回给模型，让它自己改。

```python
def repair_prompt(raw: str, errors: list[str]) -> str:
    detail = "\n".join(f"- {e}" for e in errors)
    return (
        "你上一次的输出没有通过校验。\n"
        f"你上一次的原文：\n{raw}\n\n"
        f"校验错误：\n{detail}\n\n"
        "只输出一个 JSON 对象，不要解释，不要代码围栏。\n"
        "字段要求：name(string) / price(number) / stock(integer)。"
    )


def extract(model, messages, schema, max_retries: int = 3) -> dict:
    """解析 → 校验 → 修复。永远返回 dict，不抛异常。"""
    raw, errors = "", []
    for attempt in range(max_retries + 1):
        send = messages if attempt == 0 else messages + [
            Message("user", repair_prompt(raw, errors))
        ]
        raw = model.chat(send).content
        try:
            obj = parse_json_reply(raw)
        except ValueError as exc:
            errors = [f"不是合法 JSON：{exc}"]
            continue
        errors = validate(obj, schema)
        if not errors:
            return {"ok": True, "data": obj, "attempts": attempt + 1}
    return {
        "ok": False,
        "attempts": max_retries + 1,
        "error": "模型连续几次都没有给出合法结构",
        "last_reply": raw,
        "last_errors": errors,
    }
```

注意几件事。

**`continue` 之后 `raw` 已经被覆盖了。**

这是故意的：下一次修复要带上「最近一次」的原文，不是第一次的。

**修复是一次新的请求，不是重发。**

`messages + [repair_prompt]` 保留了原始任务上下文。

模型能看到「原本要干什么」和「这次错在哪」。

**函数签名里的 `model` 就是 L01 那个 `model.chat(messages)`。**

换真模型时这段不用改。

**它永远返回 dict。**

调用方不需要 `try/except`。

失败的那一路也带着信息：`last_reply` 和 `last_errors`，够你写日志。

跑一遍，给它三条按顺序返回的回复（和 `ScriptedModel` 一个思路，只是不看 messages、只看计数器）：

```text
第 1 条：围栏包着 JSON，price 写成字符串 "0.5"
第 2 条：price 对了，stock 又写成字符串 "120"
第 3 条：类型都对，但多给了一个 currency 字段
```

输出是 `{'ok': True, 'data': {...}, 'attempts': 3}`。

三次。

第一次围栏剥掉了，但 `price` 是字符串。

第二次类型改对了一个，`stock` 又成了字符串。

第三次通过了。

注意第三次多了一个 `currency` 字段，也通过了。

因为 schema 里没有写 `additionalProperties: false`。

要不要禁，是个业务决定：禁则结构严格、重试变多；不禁则宽容，但下游要能忽略未知字段。

### 修复失败的两种真实情况

三次都失败，通常掉进下面两个坑之一。

**坑一：模型在同一个字段上反复错。**

```text
第 1 次：{"price": "0.5"}
第 2 次：{"price": "0.50 元"}
第 3 次：{"price": "零点五"}
```

三次都错在同一个位置。

这不是「没看清错误」。

是你的 prompt 和 schema 在打架。

回到前面那句：你脑子里的类型、schema 里的类型、描述里的类型，是三种不同的东西。

修法不在重试次数，在统一这三处。

**坑二：模型把错误信息当成用户的问题。**

你的修复提示里写：

```text
校验错误：字段 'price' 应该是 number，实际是 str
```

它回你：

```text
看起来 price 的格式有问题，我帮你改成数字吧。
```

然后一段解释，没有 JSON。

原因是修复提示里「错误」和「任务」的边界不清。

修法是把指令放在末尾，并且写死。

```text
只输出一个 JSON 对象，不要解释。
不要复述上面的错误，直接给修正后的 JSON。
```

一句：

```text
修复提示不是"通知它错了"，是"给它一份新的任务说明"。
```

## 7. 校验用什么：jsonschema 还是 Pydantic

两个都是常规选择。

**jsonschema**：直接吃 JSON Schema。

优点：和给模型看的 schema 是同一份东西，跨语言，标准。

缺点：错误信息要自己整理，类型提示弱。

**Pydantic**：用 Python 类定义结构。

优点：写起来舒服，嵌套和默认值好处理，和 FastAPI 那套生态一致。

缺点：给模型看的 schema 要 `model_json_schema()` 导出一份。

真正的坑在中间：

```text
如果你给模型看的 schema，和你用来校验的 schema 不是同一份，
就会出现「模型按 A 输出，你按 B 校验」。
```

症状很典型：模型每次都失败，你看它的输出，觉得没问题。

它确实没问题。

是两份 schema 不一样。

所以规则只有一条：

```text
只有一份 schema。
给模型的那份，是从校验用的那份导出的。
```

用 Pydantic 的话，就是 `Schema.model_json_schema()`；用 jsonschema 的话，就是一个 dict 两处引用。

## 8. 修复提示怎么写

这一节是这一篇最值钱的部分。

先看错误写法。

```text
你刚才的输出格式不对，请重新输出 JSON。
```

这句话的信息量是零。

模型知道自己错了，但不知道错在哪。

它的下一次尝试，大概率是换一种错法。

再看正确写法。

```text
你上一次的输出没有通过校验。
你上一次的原文：
{"name": "螺丝", "price": "0.5", "stock": 120}

校验错误：
- 字段 'price' 应该是 number，实际是 str

只输出一个 JSON 对象，不要解释，不要代码围栏。
字段要求：name(string) / price(number) / stock(integer)。
```

三件事齐了。

```text
1. 原文（它自己写的，能对照）
2. 错误（具体到字段和期望类型）
3. 约束（再说一遍要什么）
```

**反直觉的点：修 JSON 最有效的手段，不是写更长的 prompt，是把报错原样还给它。**

因为模型的训练数据里，有大量「看到报错 → 修代码」的样本。

你给它一条人类工程师会写的错误信息，它就在那个分布里。

你给它一句「请重试」，它就只能瞎猜。

还有两个细节。

**不要把错误信息写得比原文还长。**

三条错误足够。

十条错误会让模型开始挑最容易改的那条，其他的继续错。

**错误信息里不要带你的内部实现。**

「Pydantic ValidationError at model.py:42」对模型没用。

「price 应该是数字」有用。

## 9. 重试上限与降级

三次。

不是十次。

理由很实在：

```text
第一次失败：模型没注意约束，改一下就好。
第二次失败：可能是它在某个字段上反复理解错。
第三次失败：多半是 schema 和任务本身不匹配，再来一百次也一样。
```

第三次还失败，要降级。

降级不是抛异常。

是返回一个**可读的失败**。

```python
{
  "ok": False,
  "attempts": 3,
  "error": "模型连续几次都没有给出合法结构",
  "last_reply": "...",
  "last_errors": ["字段 'price' 应该是 number，实际是 str"],
}
```

调用方拿到这个，可以做三件事：

```text
告诉用户：这次没整理出来，能不能换个说法。
写日志：把 last_reply 存下来，攒够样本再看是不是 schema 有问题。
降级成本地解析：正则抠一下，能抠出来就用，抠不出来再说。
```

三条路都比「死循环」好。

死循环的样子是这样的：`while True` 里发请求，`json.loads` 失败就 `continue`。

这段代码有三个问题。

没有上限。

没有退避。

`continue` 之后什么都没变，下一次请求和上一次一模一样。

模型大概率给你一模一样的错误答案。

还有一个更隐蔽的问题：**有些错误不该重试。**

```text
schema 本身写错了（required 里有个永远不存在的字段）→ 重试无用
任务本身没有答案（让它从空文档里抽取）→ 重试无用
超时、限流 → 该重试，但要退避，不是立刻
```

判断标准：

```text
这一次重试，和上一次有什么不同？
没有不同，就别重试。
```

### 把失败率做成指标

`attempts` 不只是一个返回值。

它是一个指标。

把每次调用的 `attempts` 和 `ok` 记下来，一周后能看到三条曲线。

```text
一次通过率：attempts == 1 的比例
修复成功率：从第 2 次开始改对的比例
最终失败率：ok == False 的比例
```

三条曲线指向三个不同的地方。

```text
一次通过率低  → schema 或 prompt 有问题
修复成功率低  → 错误信息写得不好，模型改了还是错
最终失败率高  → 这个任务本身不适合这种形状
```

没有这三个数，调 schema 只能靠「感觉好点了」。

有了它们，改动是有方向的。

```text
把 required 从 8 个减到 5 个 → 一次通过率 0.62 → 0.81
```

这就是 09 篇要讲的思路，只是对象换成了「结构化输出这一步」。

一句：

```text
先量出来，再改。
```

## 10. 模型常见破坏方式

按出现频率排。

```text
1. 外面包一层 json 代码围栏
2. 前后加解释：「好的，结果如下：」
3. 字段名翻译成中文：「名称」「价格」
4. 数字变字符串：{"price": "0.5"}
5. 多给字段 / 少给字段（少的多半在嵌套里）
6. 该是数组的地方给了单个对象
7. 用 null 表示"没有"，而 schema 里没允许 null
8. JSON 不合法：单引号、尾随逗号、注释、把 true 写成 "true"
```

前两种，`parse_json_reply` 能救。

中间几种，`validate` 能发现，但要靠 `repair` 才能修。

最后几种，很多时候是**你的 schema 没写清楚**。

举个例子。

```text
schema 里写：price: number
模型输出：{"price": "0.5"}
```

你觉得模型笨。

但你在 prompt 里可能写的是「价格用字符串表示，保留两位小数」。

模型照做了。

第四种和第八种错误的根源，常常在这里：

```text
你脑子里的类型，和你写在 schema 里的类型，和你写在 prompt 描述里的类型，
是三种不同的东西。
```

统一它们。

schema 里的 `type` 是唯一权威，描述文字只是补充。

还有一种破坏，值得单独说。

```text
该给对象的时候给了数组：[{"name": "螺丝"}]
```

你按对象取字段，拿到的是 list。

`data["name"]` 直接抛 TypeError。

修法有两种。

```text
严格要求：schema 写 type: object，校验拦住，触发重试
接受兼容：解析时判断 isinstance(obj, list)，取第一个
```

第一种更干净。

第二种更省调用。

选哪种，取决于你多在乎那一次重试。

### 多字段的大对象，怎么分批抽

字段一多，整体失败率就上去了。

一个 12 字段的对象，每次都可能错一两个。

```text
10 个字段，每个字段各自 97% 正确
整体全对 ≈ 0.97 的 10 次方 ≈ 74%
```

这是估算，不是定律。

它说明的是趋势：字段越多，一次全对的概率越低。

两种应对。

```text
一、一次抽完，失败就整体重试
二、拆成几次小抽取，各自校验，最后合并
```

第一种简单，重试成本高。

第二种稳，多几次调用。

按「字段之间的依赖」拆。

```text
第 1 次：基础信息（name, category, unit）
第 2 次：数值（price, stock, weight）
第 3 次：文本描述（summary, tags）
```

每次的 schema 都很小。

```python
PARTS = [
    ("基础", {"type": "object",
              "required": ["name", "category", "unit"],
              "properties": {"name": {"type": "string"},
                             "category": {"type": "string"},
                             "unit": {"type": "string"}}}),
    ("数值", {"type": "object",
              "required": ["price", "stock"],
              "properties": {"price": {"type": "number"},
                             "stock": {"type": "integer"}}}),
]

def extract_all(model, messages):
    out = {}
    for label, schema in PARTS:
        res = extract(model, messages, schema)
        if not res["ok"]:
            return {"ok": False, "failed_part": label,
                    "last_errors": res["last_errors"]}
        out.update(res["data"])
    return {"ok": True, "data": out}
```

注意失败时的返回值。

它告诉你**哪一段**失败了。

整体重试的做法，只会告诉你「失败了」。

多花的那几次调用，抵不上排查时省的时间。

合并之后还要再校验一次。

```text
分段通过 ≠ 合起来是一个合法对象。
validate(merged, FULL_SCHEMA)
```

它兜住的是跨字段约束。

比如 `price` 和 `currency` 必须一起出现。

还有两个细节。

```text
合并时不要覆盖已有键（后一段抽到同名键会把前面的冲掉）
每段 schema 只写必填，不要写"最好也有"
```

第二条尤其重要。

把描述字段写进 required，失败率立刻上去。

一句：

```text
宁可三次干净的抽取，不要一次勉强的全量。
```

## 11. 参数也是结构化输出

现在把镜头转到工具调用。

`check.py` 里有这么一段。

代码来源：

```text
labs/L01_agent_loop/check.py
```

```python
msgs = [Message("system", SYS), Message("user", "100 除以 4")]
model = ScriptedModel([
    tool_call("divide", call_id="a1", a=100, b=4),
    lambda m: Message("assistant", f"答案是 {last_tool_result(m)}"),
])
```

`divide(a=100, b=4)`。

在假模型里，这就是一个 Python 关键字参数。

它已经是 `{"a": 100, "b": 4}` 这个 dict 了。

看 `tool_call` 的实现。

代码来源：

```text
labs/L01_agent_loop/fake_llm.py
```

```python
def tool_call(name: str, call_id: str | None = None, **args) -> Message:
    call_id = call_id or f"call_{name}_{abs(hash((name, tuple(args.items())))) % 10000}"
    return Message(
        role="assistant",
        content="",
        tool_calls=[ToolCall(id=call_id, name=name, args=args)],
    )
```

`**args` 直接把关键字参数收成 dict。

Python 帮你做完了「解析」。

真实世界不这样。

真实 API 返回的是：

```json
{"role": "assistant", "content": null, "tool_calls": [
  {"id": "call_a1b2c3", "type": "function",
   "function": {"name": "divide", "arguments": "{\"a\": 100, \"b\": 4}"}}
]}
```

注意 `arguments` 是**字符串**。

里面才是 JSON。

所以你的代码里必须有这一步：

```python
args = json.loads(call["function"]["arguments"])
```

这一步就是 `parse_json_reply`。

再往下一步，是 `validate`：`a` 和 `b` 都应该是数字。

再往下一步，是修复：如果 `a` 是 `"100"`，要么重试，要么自己转。

```text
模型给的："100" / 4
Python 报的：TypeError: unsupported operand type(s) for /: 'str' and 'int'
```

这个报错会被 `agent.py` 的 `_execute` 兜住，变成一条观测：

```text
错误：TypeError: unsupported operand type(s) for /: 'str' and 'int'
```

模型看到它，下一轮可能就改对了。

也可能不改。

所以工具侧还要有第三道防线。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

只摘 `_execute` 的执行部分（docstring 略）：

```python
    tool = tools.get(call.name)
    if tool is None:
        return f"错误：没有名为 {call.name!r} 的工具。可用工具：{', '.join(tools)}"
    try:
        return str(tool(**call.args))      # 参数是模型给的，直接展开
    except Exception as exc:
        return f"错误：{type(exc).__name__}: {exc}"
```

它兜住了异常，但没校验类型。

一个改进版会在 `tool(**call.args)` 之前加一句：

```python
if not isinstance(call.args.get("a"), (int, float)):
    return "错误：参数 a 必须是数字"
```

更早报错，错误信息更准。

结论：

```text
工具调用不是"另一种东西"。
它就是结构化输出，外加一个执行器。
schema 管形状，你管执行。
```

[03 篇](/posts/agent-tool-protocol-json-schema/)讲过 schema 的写法，[04 篇](/posts/agent-tool-call-loop/)讲过回填。

这一篇补的是它们中间那一步：**模型给的参数，是字符串，你要自己解析和校验。**

## 12. 什么时候该用工具调用

既然工具调用就是结构化输出加执行器，那什么时候用哪个？

判断标准只有一条：

```text
要不要产生副作用？
```

要，用工具调用。

不要，用结构化输出。

展开成四种情况。

**情况一：要执行动作。**

读文件、查数据库、发请求、改状态。

必须走工具调用。

因为只有工具调用能带 `tool_call_id`，能把结果回填，能进循环。

**情况二：只是要一份数据。**

从一段文本里抽三个字段。

不需要工具。

让模型直接吐 JSON，你解析就行。

套一层工具调用，只会多一次往返。

**情况三：模型需要先看结果再决定下一步。**

「先查订单，看状态，再决定要不要退款」。

必须走工具调用。

因为它天然是多轮的。

**情况四：你想借平台的 schema 约束。**

有些接口的原生结构化输出约束更强。

有些接口的工具参数约束更成熟。

这时候选哪个，看你用的模型文档怎么说。

不要凭感觉。

一句总结：

```text
要"做"，走工具。
要"说"，走 JSON。
```

### 工具返回值也是字符串

一个容易被忽略的对称问题。

模型给你的参数，是字符串里的 JSON。

你的工具返回值，也一样。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
return str(tool(**call.args))
```

那个 `str()` 把返回值变成一条 `tool` 消息的 `content`。

工具返回 `{"ok": true, "count": 3}`，模型看到的就是这段文本。

它不会自动变成对象。

要让它稳定理解，两条路。

```text
一、返回人话："查到 3 条记录"
二、返回 JSON，并在 system 里说清字段含义
```

第一条更稳。

因为工具结果不是给你解析的，是给模型读的。

第二条适合「结果后面还要被程序处理」的场景。

那种情况下，真正消费它的是你的代码，不是模型。

还有一个习惯：报错也用同一个形状。

```json
{"ok": false, "error": "仓库接口超时", "retry_after": 30}
```

模型看到 `retry_after`，就知道该等一下再试。

看到一段自由文本的报错，它只能猜。

一句：

```text
结构化输出解决"模型给你什么"。
结构化输入解决"你给模型什么"。
两边都要有人负责。
```

## 13. 容易混淆的点

**JSON mode ≠ schema 校验。**

它只保证能被 `json.loads`。

字段名、类型、必填，它一样不管。

**「合法 JSON」≠「符合契约」。**

`{"名称": "螺丝"}` 是合法 JSON。

它只是不符合你的契约。

**校验失败 ≠ 模型不行。**

先怀疑三件事：schema 和 prompt 说的不一致、schema 太复杂、错误没回给模型。

**重试 ≠ 修复。**

重发一模一样的请求，叫重试。

带上错误再发，叫修复。

前者对模型几乎无效。

**结构化输出 ≠ 工具调用。**

前者是「输出形状」，后者是「输出形状 + 执行」。

工具调用的参数，本质就是一次结构化输出。

**「三次都失败」≠「该重试第四次」。**

**解析成功 ≠ 数据可用。**

`json.loads` 过了，只说明语法对。

字段值可能是错的、空的、编的。

**校验失败 ≠ 应该重试。**

如果 schema 本身写错了（`required` 里有个永远不存在的字段），重试一百次都一样。

先看最后一次的 `last_errors`，再决定是重试还是改 schema。

**校验通过 ≠ 下游能用。**

校验只保证形状。

单位是分还是元、时间是本地还是 UTC，schema 管不了。

那要靠字段说明和约定，不靠校验。

## 14. 回到真实工程

`labs/L01_agent_loop/` 里没有 JSON 解析代码。

原因很简单：假模型直接给你 `args: dict`。

这是 L01 和真实世界最大的形状差异。

接真模型的时候，你要在三个地方加东西。

```text
一、解析：arguments 是字符串，要 json.loads
二、校验：参数类型对不对，必填有没有
三、修复：解析或校验失败时，把错误回给模型
```

三处都不难。

难的是它们容易漏。

漏了第一处，你会得到 `TypeError: string indices must be integers` 这类看不懂的报错。

漏了第二处，工具会拿着 `"100"` 去算，报一个更深的错。

漏了第三处，agent 遇到坏 JSON 就直接崩，[05 篇](/posts/agent-tool-error-selfheal-fuse/)讲的自愈就白写了。

### 一处最小改动

最省事的改法，是在 `_execute` 里加一道参数校验。

```python
DIVIDE_SCHEMA = {
    "required": ["a", "b"],
    "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
}

def _execute(call, tools):
    errors = validate(call.args, DIVIDE_SCHEMA)
    if errors:
        return "错误：参数不合法 —— " + "; ".join(errors)
    # 剩下照旧：查工具、执行、兜异常
```

注意它返回的是错误字符串，不是抛异常。

这和 05 篇的原则一致：错误也是一种观测。

模型看到「参数不合法，a 应该是 number」，下一轮就会改。

如果你让它抛出去，循环就断了。

一道 schema，十行代码，挡住的是「字符串当数字用」这一整类问题。

15 篇会专门讲接真模型时的协议差异。

到时候你会发现，这一篇的三段循环，正好对得上那边的三处适配。

还有一个工程习惯值得现在就养成：

```text
把"模型原始输出"和"解析后的对象"都打进日志。
```

出问题时，你要能回答：

```text
它到底写了什么？
我解析成了什么？
校验器到底不满意哪一条？
```

三个问题答不上来，你就只能靠猜。

### extract() 的调用方怎么写

`extract()` 永远返回 dict，所以调用方没有 `try`。

但要做三件事。

```text
一、成功时只取 data，别把整个返回包丢给下游
二、失败时降级，并把原因带出来
三、无论成败，写一行日志
```

一个能直接用的外壳。

```python
def to_record(model, question, schema):
    res = extract(model, [Message("user", question)], schema)

    log.info("extract ok=%s attempts=%s", res["ok"], res["attempts"])

    if res["ok"]:
        return res["data"]

    log.warning("extract failed: %s | last=%r",
                res["last_errors"], res["last_reply"][:200])
    return {
        "error": "没法把结果整理成结构化数据",
        "hint": "换一种说法再试一次，或检查字段要求是否互相矛盾",
    }
```

几个细节。

**日志里只截前 200 字。**

完整原文另存一份，别把主日志刷爆。

**失败返回的不是 `None`。**

`None` 会让上游写 `if data:`，然后悄悄走错分支。

一个带 `error` 的 dict，会逼上游处理它。

**`attempts` 要记。**

它的分布能说明很多事。

```text
多数是 1     → schema 和 prompt 很稳
多数是 2 到 3 → 有某个字段总错，该改 schema
经常到 4（失败）→ 这个任务不适合结构化输出
```

**不要在调用方再重试一次。**

`extract` 内部已经试了三次。

外面再套一层，最坏是九次调用，而且错得一模一样。

一句：

```text
校验在里层，降级在外层。
两层都做重试，只会把账单做大。
```

批量时还有一个坑。

```python
records = [to_record(model, q, SCHEMA) for q in questions]
ok = [r for r in records if "error" not in r]
```

批量最怕的不是失败，是失败被吞掉。

`ok` 的数量和总数对不上，就该停下来看日志。

而不是拿着半份数据继续往下跑。

## 15. 小结

这一篇讲的是：怎么让模型的输出，能被程序直接用。

```text
自然语言不能进程序：它含糊、省略、自相矛盾。
三种手段强度递增：prompt 给 schema、JSON mode、原生结构化输出/工具强制调用。
它们都只管形状，不管内容。
工程形态是三段循环：解析 → 校验 → 修复。
解析处理围栏和前后解释，校验给出带路径的错误，修复把错误原样回给模型。
重试三次，然后降级成可读的失败，不要死循环。
最常见的破坏是围栏、类型漂移、字段改名，其中一部分是你自己的 schema 没写清。
工具参数也是结构化输出，只不过它的字符串藏在 arguments 里。
```

如果只记一句：

```text
模型会不会写 JSON，取决于你的校验有多严。
```

下一篇换一个方向。

前面八篇，你写的 agent 都能跑。

但你有办法证明「这一版比上一版好」吗？

```text
Agent 系统讲解 09：Evals，从感觉调到用数字调
```

那一篇会把「感觉它变好了」换成「20 条用例，通过数从 13 到 15」。
