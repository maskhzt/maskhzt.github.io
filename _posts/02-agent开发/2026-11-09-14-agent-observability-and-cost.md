---
title: "Agent 系统讲解 14：可观测性与成本"
date: 2026-11-09 12:00:00 +0800
permalink: /posts/agent-observability-and-cost/
categories: [Agent, 系统讲解]
tags: [agent, observability, trace, cost, logging, reproducibility]
description: "从一句「任务失败」讲起，说清 trace 与 span 的最小模型、每个 span 该记什么、成本账本怎么算，以及为什么让失败可复现比让它成功更难。"
---

<!-- series-nav -->
> **系列位置**：Agent 系统讲解，第 14 篇 / 共 18 篇
> **总目录**：[学习地图](./2026-11-09-00-agent-systematic-learning-map.md)
> **上一篇**：[13：安全：提示注入、权限和沙箱](./2026-11-09-13-agent-security-permissions-sandbox.md)
> **下一篇**：[15：接真模型：把假模型换掉](./2026-11-09-15-agent-connect-real-model.md)


用户报了一个错。

他说："昨天那个任务没跑完，你能看看为什么吗？"

我打开日志。

只有一行：

```text
2026-11-08 22:14:03 INFO  task finished  task_id=t_8f21  status=failed
```

没有消息历史。

没有它在第几步失败的。

没有最后一次工具调用返回了什么。

甚至没有它大概花了多少钱。

我知道它失败了。

除此之外什么都不知道。

## 1. 这个问题解决什么

这一篇解决的是：

```text
上线之后，你怎么知道刚才那一轮到底发生了什么、花了多少钱。
```

两个问题，一份答案。

因为答案都藏在同一份数据里：

```text
这一次任务的每一个动作，按时间顺序，带上输入、输出、token、状态。
```

这份数据有个名字，叫追踪（trace）。

为什么这件事必须在上线第一天就有？

因为 agent 的失败不留下痕迹。

```text
普通程序崩了，有堆栈。
agent 失败了，只有一句"我没能完成"。
```

它没有崩溃点。

它是"走了十步，每一步都合理，合起来是错的"。

这种失败只在过程中可见。

所以可观测性不是"加日志"。

它是"提前决定要留下哪些证据"。

证据留错了，出事的时候你手上就是一堆用不上的东西。

先说一个反直觉的判断，全篇都围绕它：

> **反直觉的点**：调 agent 最难的不是让它成功，是**让失败可复现**。
>
> 成功你只需要看结果对不对。
> 失败你要还原"当时它看到了什么、为什么那么想"。

成功是一行 `ok`。

失败是一棵树。

这棵树能不能被还原，决定你是能修它，还是只能猜。

## 2. trace 和 span 的最小模型

最小模型只有两个词。

```text
trace   一次任务的完整记录
span    其中的一个工作单元
```

关系是：

```text
一次任务 = 一个 trace
一次模型调用 = 一个 span
一次工具执行 = 一个 span
```

trace 是树，span 是节点。

一次"评估三个方案"的任务，展开是这样：

```text
trace t_8f21
├─ span  task            "评估三个方案，哪个能本周上线"
│  ├─ span  model step1       (1.2s, 1840 in / 210 out)
│  ├─ span  tool  read_file   (0.03s, "docs/plan_a.md")
│  ├─ span  model step2
│  ├─ span  tool  delegate    (8.4s)  ← 委派
│  │  ├─ span  model step1        (子 agent)
│  │  ├─ span  tool  search       (子 agent)
│  │  └─ span  model step2        (子 agent)
│  ├─ span  model step3
│  └─ span  task  end             "三个方案中 B 可行"
```

四个结构信息，比内容还重要。

```text
parent_id    谁生了我（决定树形状）
kind         model / tool / task
duration     我花了多久
status       ok / error / timeout
```

有这四样，你就能回答"时间花在哪"。

没有它们，你只有一堆按时间排的事件。

### 2.1 为什么必须显式建树

因为"按时间排序"不够用。

多 Agent 一并行，时间顺序就乱了。

```text
10:00:01  子 agent A 开始
10:00:02  子 agent B 开始
10:00:03  子 agent B 调工具
10:00:04  子 agent A 调工具
```

按时间看，你会以为 A 在 B 之后启动。

实际上它们是同时的。

只有 `parent_id` 能说清谁属于谁。

```text
时间回答"什么时候"，树回答"为什么"。
```

排查问题，你几乎总在问"为什么"。

还有一个实际后果：没有树，你就没法做聚合。

```text
"委派这件事平均花多久" —— 需要把 delegate 下面的子树单独算
"读文件的失败率"       —— 需要 tool span 有一个稳定的 name
```

平铺的事件流做不到这两件事。

### 2.2 trace_id 怎么穿到子 agent 里

[12 篇](./2026-11-09-12-agent-multi-agent-delegation.md)那个 `delegate` 有这个问题：

```python
def delegate(task: str, context: str = "") -> str:
    ...
    run_agent(make_model(), SUB_TOOLS, sub_messages, max_steps=max_steps)
```

子 agent 是另一个 `run_agent` 调用。

它默认会开一个新 trace。

那你就丢掉了父子关系。

修法只有一条：

```text
把 tracer（或 trace_id）作为参数传下去。
```

```python
def delegate(task: str, context: str = "", tracer=None) -> str:
    span = tracer.start_span("tool", "delegate", task=task)
    try:
        return _run_sub_agent(task, context, tracer)
    finally:
        tracer.end_span(span)
```

`tracer` 沿调用链传，子 agent 的 span 就挂在 `delegate` 这个 span 下面。

不用 `contextvar` 也能做，只是要记得每个函数都接一下。

### 2.3 粒度怎么定

一个原则：

```text
你能对它单独问"为什么慢 / 为什么错"的最小单位，就是一个 span。
```

太粗：

```text
整个 run_agent 一个 span
→ 只知道总耗时，不知道哪一步
```

太细：

```text
每次字符串拼接一个 span
→ 一万个 span，树深到看不动，写 trace 比干活还慢
```

合适的粒度就是第 2 节那三种：

```text
任务 / 模型调用 / 工具执行
```

再往下（比如"工具内部的 HTTP 请求"）只在排查特定问题时临时加。

### 2.4 trace 和指标的关系

```text
trace   一次任务的细节（高基数，贵，不能全存）
指标    很多任务的聚合（低基数，便宜，能长期存）
```

两者的关系是：

```text
指标发现问题，trace 解释问题。
```

只做指标，你知道"成功率掉了 5%"，但不知道为什么。

只做 trace，你有一堆细节，但不知道"和上周比是好是坏"。

两个都要。

一句话记住三者：

```text
trace 是显微镜，指标是仪表盘。
仪表盘告诉你"该检查了"，显微镜告诉你"问题在哪"。
```

## 3. 每个 span 必须记什么

六样，少一样就会在某个时刻卡住你。

```text
① 起止时间     start / end / duration_ms
② 输入摘要     input 是什么（不是全量，是能定位的那种）
③ 输出摘要     output 是什么
④ token 数     in / out / cached
⑤ 状态         ok / error / timeout / rejected
⑥ 错误         错误类型 + 消息（截断到 500 字）
```

逐个说为什么。

**① 起止时间**：没有它就没法算"慢在哪"。

```text
P95 时延、超时归因、并发度估算，全靠这一项。
```

**② 输入摘要**：要能定位，不要全量。

```text
好：{"path": "docs/plan_a.md"}                       ← 够定位
坏：{"content": "（8000 字的文件全文）"}              ← 撑爆 trace
```

模型 span 的输入摘要，记"messages 的条数 + 最后一条的 role + 总 token"。

工具 span 的输入，记参数（脱敏后）。

**③ 输出摘要**：同理。

```text
好：{"bytes": 812, "preview": "第一行……"}
坏：全量输出
```

**④ token 数**：成本的唯一来源。

模型的响应里通常带 usage。

```text
OpenAI：usage.prompt_tokens / usage.completion_tokens
Anthropic：usage.input_tokens / usage.output_tokens
```

字段名不一样，落库前先归一化成 `input_tokens` / `output_tokens`。

不归一化，你的账本就会有一半是空的。

**⑤ 状态**：四种，不要只记 ok / error。

```text
ok       成功
error    失败（工具抛错、解析失败）
timeout  超时（要单独统计，它和 error 的修法完全不同）
rejected 被策略/审批拒绝（[13 篇](./2026-11-09-13-agent-security-permissions-sandbox.md)那套）
```

`rejected` 单独一类，是因为它不是 bug。

它是设计的正常行为，但它涨得快就说明有人在试探边界。

**⑥ 错误**：类型 + 消息，不要堆栈全文。

```text
ValueError: 不支持的表达式片段: Call(...)
```

堆栈进另一个文件，trace 里只留定位信息。

为什么错误类型要单独一个字段？

因为它是你唯一能聚合的东西。

```text
按 error.type 分组 → "这周 60% 的失败是 JSONDecodeError"
```

按错误消息分组，每条长得都不一样，聚不出东西。

### 3.1 一个具体的 span

```json
{
  "span_id": "b7c1d2e3",
  "parent_id": "a1b2c3d4",
  "kind": "tool",
  "name": "calculator",
  "start": 1762700043.221,
  "duration_ms": 1.8,
  "status": "ok",
  "input": {"expression": "10 / 0"},
  "output": {"preview": "错误：ZeroDivisionError: division by zero"},
  "tokens": null,
  "error": null
}
```

这个 span 一眼就能看出发生了什么：

```text
除零，工具没崩，错误被当成观测返回了。
```

不需要看别的日志。

### 3.2 attributes 里放什么

一个简单的判断：

```text
这个问题，你会不会想按它筛选？
会   → 放进结构化字段
不会 → 放进字符串摘要
```

会想筛的：

```text
model      按模型看成本
tool       按工具看失败率
status     按状态看分布
step       按步数看膨胀
feature    按功能看成本
```

不会想筛的：

```text
"它当时读了哪个文件" —— 值太散，放 input 里就够
```

字段设计错了，后面每次查询都要写正则去凑。

## 4. run.py 的 verbose 输出：最原始的 trace

在写 Tracer 之前，先看看你手里已经有什么。

代码来源：

```text
labs/L01_agent_loop/run.py
```

跑 `python run.py`，场景 1 输出：

```text
── 第 1 步 ──
  模型 → 调用 calculator(expression='12 + 8')
  工具 ← 20

── 第 2 步 ──
  模型 → 调用 calculator(expression='20 * 3')
  工具 ← 60

── 第 3 步 ──
  模型 → 最终回答：结果是 60。
```

这就是一份 trace。

只是它长在终端里。

它已经具备了三样东西：

```text
顺序      第几步
动作      调了什么工具、参数是什么
结果      观测是什么
```

场景 2 更能说明它的价值：

```text
── 第 1 步 ──
  模型 → 调用 calculator(expression='10 / 0')
  工具 ← 错误：ZeroDivisionError: division by zero

── 第 2 步 ──
  模型 → 调用 calculator(expression='10 / 2')
  工具 ← 5
```

你看完就知道："模型看到错误后换了个式子。"

这就是 trace 在做的事：把"它当时看到了什么"记下来。

### 4.1 它缺什么

缺六样，正好对着第 3 节那六项。

```text
时间    没有起止时间，不知道哪一步慢
token   没有 usage，算不出成本
状态    只有文本，没有结构化的 ok / error
错误    工具错误混在正常观测里，程序读不出
父子    多 agent 一上，缩进就乱了
模型    不知道这一步用的是哪个模型
```

这六项不是"锦上添花"。

少一项，就有一类问题你答不了。

```text
少时间   → 答不了"慢在哪"
少 token → 答不了"钱花在哪"
少状态   → 答不了"成功率"
少错误   → 答不了"为什么失败"
```

还有一个更隐蔽的缺失。

它只写到 stdout，没写到任何可查询的地方。

stdout 是给"当时在看的人"的。

事后的人不在场。

### 4.2 为什么不能直接 print 上生产

三个原因。

第一个：`print` 是同步 I/O。

```text
工具执行 3ms，打印 30ms。
```

高并发下，日志成了瓶颈。

第二个：没有结构。

```text
要统计"平均几步"，你得用正则去解析自由文本。
```

第三个：没法关联。

```text
两个用户同时跑，两段输出交错在一起。
```

所以要换一个形态：

```text
结构化 + 带 id + 异步写。
```

### 4.3 用 verbose 排查一次真实的卡住

一个典型场景：任务跑了 40 秒还没结束。

verbose 输出长这样：

```text
── 第 5 步 ──
  模型 → 调用 search(query='CSV 表头重复')
  工具 ← （空）
── 第 6 步 ──
  模型 → 调用 search(query='CSV header duplicate')
  工具 ← （空）
── 第 7 步 ──
  模型 → 调用 search(query='csv export header')
  工具 ← （空）
```

你立刻得到三个信息。

```text
它在换措辞重试同一个搜索
搜索一直返回空
已经三步了
```

这三条足够判断：检索侧有问题，或者知识库里根本没有这个内容。

换句话说：

```text
verbose 能定位"病在哪"，但定位不了"为什么"。
```

想知道为什么，你得看那三次搜索的真实参数和后端返回。

那就不在 stdout 里了。

## 5. 日志不是 trace

这一节要把两个东西分开，因为太多人混着用。

```text
日志（log）   散点。一行一个事件，谁也不知道谁。
trace        树。一个节点知道自己属于谁。
```

看一段真实日志：

```text
22:14:01 INFO  tool call calculator {"expression": "10 / 0"}
22:14:01 ERROR tool error ZeroDivisionError
22:14:02 INFO  tool call calculator {"expression": "10 / 2"}
22:14:02 INFO  tool result 5
22:14:03 INFO  task finished status=ok
```

这段日志读完，你能回答"发生了什么"。

但你回答不了这几个问题：

```text
这两次 calculator 是同一个任务吗？
它们是同一个 step 里的两个并发调用，还是两个 step？
最后那个 ok 是哪个任务的 ok？
如果同时有 100 个任务在跑，这些行怎么分组？
```

日志天然缺少三样东西：**归属、层级、上下文**。

trace 补的正是这三样。

```text
span 有 parent_id → 归属和层级
span 有 trace_id  → 分组
span 有 input/output → 上下文
```

### 5.1 那日志还要不要

要。

两者解决的问题不同。

```text
trace   回答"这一次任务里发生了什么"
日志    回答"系统整体在发生什么"
```

日志该记的是：

```text
启动、配置变更、限流、降级、异常退出、审计
```

这些是"系统事件"，不属于任何一次任务。

trace 该记的是：

```text
这一次任务的每一步
```

两者用一个 `task_id` 关联就够了。

```text
日志里带上 task_id，就能从一条系统日志跳到对应的 trace。
```

一个判断标准：

```text
这条信息，只按时间查能不能找到对得上的那条？
能   → 日志
不能 → trace
```

"它属于哪一步"这个问题，日志永远答不了。

### 5.2 一个常见的错误做法

```text
把 trace 打成 JSON，然后用 grep 找。
```

小规模能用。

规模一大就废：

```text
一次任务 40 个 span，一天 5000 次任务 = 20 万行。
```

你需要的是查询，不是搜索。

```text
"最近一小时，第 3 步失败的任务有几个？"
"P95 时延最差的是哪个工具？"
```

这两个问题，grep 答不了。

### 5.3 一个只有日志的排查记录

真实对话大概长这样。

```text
你：这个任务为什么失败？
日志：status=failed
你：哪一步失败的？
日志：没有记录。
你：它最后调了什么工具？
日志：tool call search。
你：那个工具的返回是什么？
日志：没打。
你：那次调用花了多久？
日志：不知道。
```

五轮问答，零信息。

这不是"日志写得不够多"。

是日志这种结构，天生答不了"归属"和"顺序"。

加字段也补不上，因为缺的是父子关系。

## 6. 最小代码：Tracer

三十多行，够用。

```python
import json
import time
import uuid

class Tracer:
    """一次任务一个 Tracer，span 用栈维护父子关系。"""

    def __init__(self, task_id: str | None = None, user_id: str = ""):
        self.task_id = task_id or f"t_{uuid.uuid4().hex[:8]}"
        self.user_id = user_id
        self.spans: list[dict] = []
        self._stack: list[dict] = []

    def start_span(self, kind: str, name: str, **attrs) -> dict:
        span = {
            "span_id": uuid.uuid4().hex[:8],
            "parent_id": self._stack[-1]["span_id"] if self._stack else None,
            "kind": kind,              # "model" / "tool" / "task"
            "name": name,
            "start": time.time(),
            "status": "running",
            "attrs": attrs,
        }
        self.spans.append(span)
        self._stack.append(span)
        return span

    def end_span(self, span: dict, status: str = "ok", **out) -> None:
        span["end"] = time.time()
        span["duration_ms"] = round((span["end"] - span["start"]) * 1000, 1)
        span["status"] = status
        span["out"] = out
        if self._stack and self._stack[-1] is span:
            self._stack.pop()

    def to_json(self) -> str:
        return json.dumps(
            {"task_id": self.task_id, "user_id": self.user_id, "spans": self.spans},
            ensure_ascii=False,
            default=str,
        )
```

三个设计决定值得说。

第一个：用栈维护父子关系。

```python
"parent_id": self._stack[-1]["span_id"] if self._stack else None
```

调用是嵌套的，栈天然匹配嵌套。

你不需要手动传 parent。

只要保证 `start` 和 `end` 成对出现。

第二个：`end_span` 只弹出栈顶。

```python
if self._stack and self._stack[-1] is span:
    self._stack.pop()
```

如果传进来的不是栈顶，说明 start/end 没配对。

这时候不弹，让栈保持可观察的状态，而不是悄悄弄乱。

第三个：`default=str`。

```text
span 里可能混进 datetime、Path、异常对象。
```

没有它，`json.dumps` 会在写 trace 的时候抛异常。

**日志代码抛异常，是最讽刺的一类线上事故。**

### 6.1 套进循环

```python
def run_agent(model, tools, messages, max_steps=10, tracer=None):
    tracer = tracer or Tracer()
    task_span = tracer.start_span("task", "run_agent", max_steps=max_steps)
    for step in range(1, max_steps + 1):
        span = tracer.start_span("model", "chat", step=step, model=getattr(model, "name", "?"))
        reply = model.chat(messages)
        tracer.end_span(
            span,
            status="ok",
            tool_calls=[c.name for c in reply.tool_calls],
            tokens=get_usage(reply),          # 真模型的 usage，假模型返回 None
        )
        messages.append(reply)
        if not reply.tool_calls:
            tracer.end_span(task_span, answer_len=len(reply.content or ""))
            return reply.content
        for call in reply.tool_calls:
            tspan = tracer.start_span("tool", call.name, args=redact(call.args))
            observation = _execute(call, tools)
            ok = not observation.startswith("错误：")
            tracer.end_span(tspan, status="ok" if ok else "error",
                            preview=observation[:200])
            messages.append(Message(role="tool", content=observation, tool_call_id=call.id))
    tracer.end_span(task_span, status="error", reason="max_steps")
    return f"（达到最大步数 {max_steps}，强制停止）"
```

`max_steps` 那一支必须记 `status="error"`。

很多实现把它当成正常结束。

结果你的成功率指标永远 100%。

而"撞上限"恰恰是最该被关注的信号之一。

`get_usage(reply)` 这个函数值得单独写。

```python
def get_usage(reply) -> dict | None:
    """把不同供应商的 usage 归一化。假模型返回 None。"""
    u = getattr(reply, "usage", None)
    if u is None:
        return None
    return {
        "input_tokens": u.get("prompt_tokens", u.get("input_tokens", 0)),
        "output_tokens": u.get("completion_tokens", u.get("output_tokens", 0)),
        "cached_input_tokens": (
            u.get("prompt_tokens_details", {}).get("cached_tokens", 0)
            or u.get("cache_read_input_tokens", 0)
        ),
    }
```

一层归一化，后面所有代码只认这三个字段。

不做归一化，你会为第二家供应商的字段名改十个地方。

还有一个字段：`step`。

它让"这个任务在第几步结束"变成可查询的。

```text
成功率按 step 分组 → 你能看到"任务越往后越容易失败"
```

如果失败集中在第 8 步之后，那不是模型笨。

是你的上下文在第 8 步之后开始劣化了。

[06 篇](./2026-11-09-06-agent-context-engineering.md)整篇都在处理这件事。

### 6.2 用 try/finally 保证 span 闭合

```python
span = tracer.start_span("tool", "fetch_url", url=url)
try:
    result = fetch(url)
finally:
    tracer.end_span(span, status="error" if sys.exc_info()[0] else "ok")
```

不写 `finally`，异常一抛，这个 span 就永远停在 `running`。

而 `running` 的 span 会污染所有指标：它没有 duration，也没法算成功还是失败。

```text
trace 里出现 running，等于这一段数据是坏的。
```

### 6.3 span 命名要能被聚合

```text
好：calculator / read_file / delegate / chat
坏：计算 (12+8) / 读取 plan_a.md
```

坏的那个把参数写进了名字。

后果很具体：

```text
你想统计"calculator 的平均耗时"，
结果发现库里有 200 个不同的 span 名字。
```

规则很简单：

```text
name 放"是什么"，参数放 attrs。
```

同一个原则，日志的 `event` 字段也适用。

## 7. 结构化日志：一行一个 JSON

trace 和日志都要结构化。

要么一行一个 JSON，要么别写。

```python
import json, logging

def log_json(logger, event: str, **fields):
    logger.info(json.dumps({"event": event, **fields}, ensure_ascii=False, default=str))
```

一次输出：

```json
{"event": "tool_error", "task_id": "t_8f21", "span_id": "b7c1d2e3", "tool": "calculator", "error": "ZeroDivisionError", "duration_ms": 1.8}
```

为什么"一行一个 JSON"这么重要？

因为日志系统是按行读的。

```text
一行一个 JSON → 每行都能独立解析
一个 JSON 跨多行 → 解析器会把它切成十条，十条都是坏的
```

这就是为什么 `json.dumps(..., indent=2)` 不能用在日志里。

它好看，但会毁掉可解析性。

### 7.1 哪些字段必须有

```text
ts         时间（ISO8601，带时区）
level      info / warn / error
event      事件名，不要写成人话（tool_error 而不是"工具出错了"）
task_id    关联到 trace
span_id    关联到具体一步
```

`event` 用人话写，你的统计脚本就得写一堆字符串匹配。

```text
差：msg="工具 calculator 出错了"
好：event="tool_error" tool="calculator"
```

人话留给 `msg`，机器读的用 `event`。

还有一个必须统一的：时间格式。

```text
2026-11-08T22:14:03.221+08:00
```

带时区、带毫秒、ISO8601。

不带时区的日志，跨机器一对比就全乱。

### 7.2 日志级别怎么定

```text
INFO    正常事件（任务开始、任务结束、工具调用）
WARN    可恢复的异常（重试成功、被拒绝、超时后重试）
ERROR   需要人看的（任务失败、连续重试失败、审批超时）
```

一个具体的规矩：

```text
预期内的失败，不要打 ERROR。
```

```text
模型第一次参数写错，第二次改对了 —— 这是 INFO/WARN。
```

打 ERROR 的后果是告警疲劳。

一周之后没人看告警了，真正的事故也就没人管了。

### 7.3 日志怎么和 trace 关联

一条规矩：

```text
每条日志都带 task_id，工具相关的再带 span_id。
```

有了这个，排查路径变成：

```text
告警 → 找到 task_id → 打开 trace → 定位 span → 回到那条日志
```

没有这个，路径是：

```text
告警 → 按时间去 grep → 在一万行里找对得上的那三行
```

第一种是分钟级。

第二种是小时级，而且经常找错。

至于采样：

```text
INFO 可以采样（10% 够看趋势）
WARN / ERROR 不能采样
审计日志绝对不能采样
```

## 8. 成本账本

成本这件事，agent 和普通接口不一样。

普通接口一次请求一次计费。

agent 一次任务，可能是 10 次请求。

```text
一次任务的成本 = Σ(每次模型调用的输入成本 + 输出成本)
```

先给骨架。

```python
# 单价按你的供应商文档填，这里只放结构，不写具体数字
PRICE_IN_PER_1K = 0.0          # 输入 token 每千个的单价
PRICE_OUT_PER_1K = 0.0         # 输出 token 每千个的单价
PRICE_CACHED_IN_PER_1K = 0.0   # 命中缓存的输入单价；没有缓存就填成和上面一样

def estimate_cost(usage: dict) -> dict:
    """usage 的字段名按你的供应商来，这里假设已经归一化成下面三个。"""
    inp = usage.get("input_tokens", 0)
    out = usage.get("output_tokens", 0)
    cached = usage.get("cached_input_tokens", 0)
    billable_in = max(inp - cached, 0)
    cost = (
        billable_in / 1000 * PRICE_IN_PER_1K
        + cached / 1000 * PRICE_CACHED_IN_PER_1K
        + out / 1000 * PRICE_OUT_PER_1K
    )
    return {"input": inp, "output": out, "cached": cached, "cost": round(cost, 6)}
```

三个常量都是 `0.0`，故意的。

```text
价格会变，各家的计价方式也不一样（按 token、按缓存命中分层、按批处理打折）。
写死一个数字，三个月后它就是错的。
```

从供应商文档里查，填进来，写个注释记下查询日期。

### 8.1 三个容易漏的成本项

**第一项：重试。**

```text
失败的那次调用，也是要付钱的。
```

一次任务重试 3 次，成本是 4 次。

账本要按"尝试"记，不是按"成功"记。

```python
for attempt in range(1, max_retries + 1):
    span = tracer.start_span("model", "chat", attempt=attempt)
    ...
```

`attempt` 这个字段，让"重试成本"变成可查询的。

**第二项：输入侧的固定成本。**

```text
system prompt + 工具说明书，每一轮都要重发。
```

一个 1500 token 的工具说明书，跑 10 步就是 15000 token 的输入。

这就是为什么"工具太多"不只影响准确率，还直接影响钱。

**第三项：委派。**

```text
子 agent 的所有调用，都算这次任务的成本。
```

只要有 `parent_id`，这个求和就是免费的。

没有 `parent_id`，你只能靠估算。

### 8.2 按什么维度聚合

三个维度，各有各的用途。

```text
按任务   看"这次任务为什么这么贵"
按用户   看"谁在烧钱"（也是限流和定价的依据）
按功能   看"哪个功能最不划算"
```

第三个最有价值，也最少人做。

```text
同一个 agent，用户 A 用来做简单查询，用户 B 用来做长文档分析。
平均成本没意义，要按功能拆。
```

一个具体的做法：在 `Tracer.__init__` 里收一个 `feature` 字段，落库时带上。

```text
feature="chat"        单任务成本 0.002
feature="deep_research" 单任务成本 0.08
```

你马上会看到：80% 的钱花在 20% 的功能上。

### 8.3 缓存命中要看，但别迷信

命中缓存的输入，单价通常低很多。

```text
cached_input_tokens 是 usage 里的一个字段（各家名字不同）。
```

它能省钱的场景很明确：

```text
同一段长 system prompt，被很多次请求重复使用。
```

它不能省钱的场景也很明确：

```text
每次都是全新的文档，缓存命中率接近 0。
```

所以看账本时，要分开看两个数：

```text
总成本
"如果没有缓存，成本会是多少"
```

第二个数才是你"缓存策略做得好不好"的答案。

### 8.4 一次任务的钱是怎么长出来的

看一个十步任务。

```text
system prompt        1200 token × 10 次 = 12000 输入
工具说明书            800 token × 10 次 =  8000 输入
历史累积             平均 3000 × 10 次 = 30000 输入
模型输出             平均 150  × 10 次 =  1500 输出
```

读出一个规律：

```text
输入成本随步数"平方"增长。
```

因为第 N 步的输入里，包含了前 N-1 步的全部内容。

```text
10 步的累计历史量 ≈ 55 个"轮次"
20 步 ≈ 210 个
```

步数翻倍，输入成本大约翻四倍。

所以[06 篇](./2026-11-09-06-agent-context-engineering.md)讲的上下文裁剪，不只为了不超窗口，也为了省钱。

把历史从 3000 压到 1500，输入成本直接减半。

比换一个更便宜的模型立竿见影。

### 8.5 预算要写进循环

```python
class Budget:
    def __init__(self, max_tokens: int):
        self.max_tokens = max_tokens
        self.used = 0

    def charge(self, tokens: int) -> None:
        self.used += tokens

    def exhausted(self) -> bool:
        return self.used >= self.max_tokens
```

每步之后 `charge`，下一次调用之前检查。

超了怎么办？

```text
不是抛异常，是让模型收尾：
messages.append(Message("user", "预算已到上限，请用现有信息给出结论。"))
```

这和 `max_steps` 是同一个思路。

```text
保险丝不是"炸掉"，是"体面地停下"。
```

[05 篇](./2026-11-09-05-agent-error-selfheal-fuse.md)讲过这个设计。

区别只在于：一个是步数预算，一个是 token 预算。

## 9. 三个必看指标，两个告警

指标不要多，三个就够。

```text
成功率      成功的任务 / 总任务
P95 时延    95% 的任务在这个时间内完成
单任务成本  总成本 / 任务数（按功能拆分看）
```

为什么是 P95 不是平均？

```text
平均值会被长尾吃掉。
100 个任务，95 个 2 秒，5 个 90 秒。
平均 6.4 秒，看起来还行。
但那 5 个用户会觉得"这东西根本不能用"。
```

P95 才是用户的真实体验。

### 9.1 两个告警

**告警一：步数异常。**

```text
本次任务的步数 > 过去 7 天同功能 P95 步数 × 2
```

为什么这个信号好用？

因为步数膨胀几乎总是同一个原因：

```text
模型在某个地方打转，反复试同一个失败的动作。
```

而 token 和成本是滞后的（任务跑完才知道），步数是实时的。

```text
步数异常往往在成本爆炸之前就能报出来。
```

**告警二：成本异常。**

两级别。

```text
单任务成本 > 阈值         → 这一条可疑，采样看 trace
单用户日成本 > 阈值 × 3   → 可能是滥用，也可能是 bug
```

第二级必须有，因为第一级挡不住"一万次便宜任务"。

### 9.2 阈值怎么定

不要拍脑袋。

```text
先跑两周，把实际分布拿出来。
```

```text
步数阈值   = 同功能最近 7 天的 P95 步数 × 2
成本阈值   = 同功能最近 7 天的 P95 单任务成本 × 3
```

用倍数不用绝对值，是因为绝对值会随模型和价格变。

倍数只随行为变。

而告警要抓的正是行为变化。

### 9.3 指标要能按版本切

```text
改了 prompt 之后，成功率变了没？
```

这个问题只有在指标带 `version` 字段时才答得了。

```text
version = prompt 版本 + 工具版本 + 模型名
```

三者任一变了，就是新版本，指标要分开看。

否则你会把"模型供应商悄悄升级了"记成"我改的 prompt 有用"。

### 9.4 成功率的定义很容易被做假

三种常见的假成功。

```text
① 撞 max_steps 但返回了一段话   → 被记成成功
② 模型说"我完成了"但没说清      → 被记成成功
③ 用户放弃了，任务算"无结论"     → 被从分母里去掉
```

第二种最普遍。

所以要给"成功"一个可验证的定义：

```text
任务正常结束 + 输出满足 schema + 关键字段非空
```

不满足的记 `partial`，单独一类。

```text
成功 / 部分成功 / 失败 / 中断
```

四类分开统计，你才能看到"看起来成功但没用"的那一批。

[09 篇](./2026-11-09-09-agent-evals.md)的评测讲的是离线怎么定义成功。

这里讲的是线上怎么记。

## 10. 可复现：存下 messages 才能重放

回到开篇那个问题：

```text
"昨天那个任务为什么没跑完？"
```

要回答它，你需要四样东西。

```text
① 完整的 messages（每一步，进模型之前的样子）
② 每一次工具调用的参数和返回
③ 模型名 + 温度 + 版本 + 工具 schema 版本
④ 时间戳
```

第 ① 项是最容易被省掉的，也是最关键的。

因为 agent 的行为完全由 messages 决定。

```text
模型是无状态的。
所以同样的 messages，理论上应该有同样的行为。
```

这句话给了你一个极强的能力：重放。

### 10.1 两种重放

**第一种：用真模型重放。**

```text
把存下来的 messages 原样再发一遍。
```

问题：模型是概率的。

```text
temperature > 0 时，两次结果可能不同。
即使 temperature = 0，供应商侧的模型更新也会让结果变。
```

所以这种方式只能验"这个输入下它会怎么想"，不能验"那次为什么那么想"。

一个折中：把 temperature 和 seed（如果供应商支持）一起记下来。

```text
它不保证复现，但它让"两次差异很大"这件事变得可解释。
```

复现不了，至少能说清为什么复现不了。

**第二种：用录制的模型响应重放。**

```text
把当时模型的每一条返回都存下来。
重放时，模型换成 RecordedModel，按顺序吐回去。
```

这就是 L01 里 `ScriptedModel` 的工业版。

代码来源：

```text
labs/L01_agent_loop/fake_llm.py
```

```python
class ScriptedModel:
    """按剧本逐条吐回复的假模型。剧本用完就报错（说明你的循环步数和预期不一致）。"""

    def __init__(self, script: list):
        self._script = list(script)
        self._turn = 0

    def chat(self, messages: list[Message]) -> Message:
        if self._turn >= len(self._script):
            raise RuntimeError(
                f"剧本只有 {len(self._script)} 幕，但循环还要第 {self._turn + 1} 幕。"
                "（多半是工具没执行成功，或循环没退出）"
            )
        item = self._script[self._turn]
        self._turn += 1
        return item(messages) if callable(item) else item
```

把 `script` 换成"当时录下来的模型响应列表"，你就得到了一个**完全确定的**回放。

```text
模型那一步固定了，剩下的不确定性就只剩工具。
工具再固定（把工具返回也录下来），整个任务就成了一个纯函数。
```

这时候你才能说：

```text
"这个 bug 我能稳定复现。"
```

这句话是修 bug 的前提。

### 10.2 重放能回答三个问题

```text
① 换一个 prompt，这次任务会不会成功？（反事实）
② 换个更小的模型，结论会不会变？（降本验证）
③ 把工具的超时调大，还会不会失败？（归因）
```

三个问题都不用重新跑真实环境。

这三个问题的共同点是：它们都在问"如果当时换个做法会怎样"。

日志回答不了这种问题。

因为日志里只有"发生了什么"，没有"输入是什么"。

而反事实需要输入。

这就是 trace 的真正价值：

```text
它不是"记录过去"，是"让过去可以再跑一遍"。
```

### 10.3 存多少

全存，但分层。

```text
热数据（7 天）    完整 messages + 完整 span，可重放
温数据（30 天）   完整 span，messages 只留摘要
冷数据（180 天）  统计指标 + 失败样本
```

分层的关键是**失败样本不能丢**。

```text
成功的 traces，采样 1% 就够。
失败的 traces，100% 保留。
```

因为失败样本是唯一能让你变好的数据。

### 10.4 重放的三个坑

**坑一：工具有副作用。**

```text
重放一次"发邮件"的工具调用，就真的又发了一封。
```

重放时工具必须进干跑（dry-run）模式：

```text
直接返回当时的录制结果，不真的执行。
```

**坑二：时间是活的。**

```text
当时 date.today() 是周三，今天是周日。
```

凡是读时间的工具，重放时都要固定时钟。

**坑三：外部系统变了。**

```text
当时那个文件还在，现在被删了。
当时那个接口返回 200，现在 404。
```

所以重放要么全录制，要么别声称"可复现"。

```text
半个录制 = 半个复现 = 又一个不可信的结论。
```

## 11. 脱敏、采样与隐私

trace 里有用户的原文。

这是绕不过去的：你要复现，就得存它看到了什么。

所以要处理三件事。

### 11.1 脱敏在写入前做

不是查询时做，是**写入前**做。

```python
def redact(obj):
    """递归脱敏：键名命中敏感词的值，整体替换；字符串过正则。"""
    if isinstance(obj, dict):
        return {
            k: ("[已脱敏]" if SENSITIVE_KEYS.match(k) else redact(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    if isinstance(obj, str):
        return _scrub_patterns(obj)
    return obj
```

为什么必须在写入前？

```text
写进去了，就有人能读。
```

访问控制能挡住一部分人，挡不住备份、导出、误配的权限、以及三个月后忘了这回事的你。

[13 篇](./2026-11-09-13-agent-security-permissions-sandbox.md)那套 `redact` 可以直接复用。

区别是：[13 篇](./2026-11-09-13-agent-security-permissions-sandbox.md)拦的是"回显给模型"，这里拦的是"落下磁盘"。

两边都要做。

两种匹配要一起用。

```text
按键名匹配  → 知道这里可能是密钥（"api_key": "..."）
按值匹配    → 不知道键名，但值的形状像密钥（sk- 开头）
```

只用按值匹配，会漏掉 `password` 这种不带形状的字段。

只用按键名匹配，会漏掉"用户随手粘进对话里的 key"。

### 11.2 采样怎么做

```text
成功   → 1% ~ 5%（够算指标就行）
失败   → 100%
慢请求 → 100%（P95 超过阈值的）
```

三条规则，覆盖了 95% 的排查需求。

参数别照抄，以你的部署环境和流量为准。

还有一条：采样决策要跟着 trace 一起落库。

```text
sampled = true / false
```

不然你永远不知道"这个指标是全量的还是 5% 的"。

分母错了，比没有指标更危险。

### 11.3 隐私的三条底线

```text
① 用户能要求删除自己的 trace（要能按 user_id 删干净）
② trace 里不放不必要的原文（能存摘要就不存全文）
③ 跨用户的数据不能进同一个上下文（这是 [07 篇](./2026-11-09-07-agent-memory-and-recall.md)记忆的坑）
```

第三条是 agent 特有的。

因为 trace 常常被拿去做"改进 prompt 的素材"。

素材一混，A 用户的数据就进了 B 用户的上下文。

## 12. 把 trace 读成一次复盘

trace 存下来是给人读的。

读的顺序固定，才不会被细节带走。

看一次失败的任务。

```text
trace t_9a3c
├─ task   "评估三个方案"                      12.4s  error
│  ├─ model  step1                 1.1s  1840/210
│  ├─ tool   read_file plan_a.md   0.03s ok
│  ├─ model  step2                 1.4s  2610/180
│  ├─ tool   delegate 方案A        8.2s  ok
│  │  ├─ model step1               2.0s ok
│  │  ├─ tool  search              0.4s ok
│  │  └─ model step2               3.1s ok
│  ├─ model  step3                 1.6s  3900/140
│  └─ tool   delegate 方案B        error 参数缺失
└─ end     "无法完成评估"                      12.4s error
```

五个问题，按顺序问。

第一个：时间花在哪？

```text
12.4 秒里，8.2 秒在方案 A 的委派上。
```

第二个：第一次异常出现在哪？

```text
方案 B 的 delegate，参数缺失。
```

第三个：错误之前的输入是什么？

```text
step3 的输出里，task 字段是空的。
```

第四个：有没有重复动作？

```text
没有。说明不是打转，是单点错误。
```

第五个：成本尖峰在哪一步？

```text
step3 的输入 3900，比 step2 多出 1290。
多的部分正好是方案 A 的委派摘要。
```

五个问题问完，结论清楚了：

```text
模型拿到方案 A 的长摘要之后，
上下文里"要评估三个方案"这件事被挤掉了，
于是给方案 B 的 task 传了空值。
```

这是一个典型的"上下文被挤占"型 bug。

它只在 trace 里可见。

单看日志，你只会看到"delegate 参数缺失"。

然后你去加参数校验，加完还是错。

因为根因不在参数上。

这就是 trace 的用法：

```text
不是"看发生了什么"，是"按固定顺序问五个问题"。
```

顺序固定，你才不会在两百个 span 里迷路。

再说一句读法。

先看宽，再看深。

```text
第一遍  只看 task 和 kind=tool 的 span，看骨架
第二遍  只看 status != ok 的 span
第三遍  才看 model span 的 token 和输入
```

反过来，一上来就逐条读 model span。

你读到第二十条就分不清自己看到哪了。

## 13. 回到真实工程

回头看 `run.py` 的三个场景，它们各自缺一样东西。

```text
场景 1（正常）    缺 duration 和 usage
场景 2（自愈）    缺"这是第几次尝试"
场景 3（保险丝）  缺一个显式的 error 状态
```

场景 3 最值得改。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
    # 4. 保险丝：模型一直不肯收尾时强制停止，否则它会烧你的钱
    if verbose:
        print(f"\n** 达到最大步数 {max_steps}，强制停止 **")
    return f"（达到最大步数 {max_steps}，强制停止）"
```

这行 `print` 是给人看的。

生产环境要在同一个位置补一条结构化事件：

```python
logger.warning(json.dumps({
    "event": "max_steps_reached",
    "task_id": tracer.task_id,
    "max_steps": max_steps,
    "steps_used": step,
}, ensure_ascii=False))
```

注意这里用 `warning` 不是 `error`。

```text
撞上限不一定是 bug（有些任务本来就该被叫停）。
但它一定要能被统计到。
```

### 13.1 一个最小可用的落库形状

```text
tasks 表     task_id, user_id, feature, version, status, steps, cost, started_at, ended_at
spans 表     span_id, task_id, parent_id, kind, name, status, duration_ms, tokens_in, tokens_out, error
messages 表  span_id, seq, role, content(脱敏), tool_calls
```

三张表，够你做绝大多数查询。

```text
成功率、P95、成本 → tasks 表
慢在哪一步         → spans 表
那一步它看到了什么 → messages 表
```

`messages` 表按 `span_id` 关联，不要按 `task_id`。

因为模型调用是有顺序的，`span_id` 才能定位"第几步看到的"。

为什么拆三张表，而不是塞进一个 JSON 字段？

因为查询形状不一样。

```text
"最近一小时失败率"        → 扫 tasks
"哪个工具最慢"            → 扫 spans
"这次任务第 3 步的输入"    → 点查 messages
```

塞成一个 JSON，三种查询里两种要全表扫。

## 14. 读代码时怎么判断

看到一段 agent 代码，问五个问题。

第一个：

```text
有没有 trace_id 贯穿整个任务？
```

没有的，你只能靠日志猜。

第二个：

```text
每个 span 有 parent_id 吗？
```

没有的，多 agent 一上线，数据就变成平铺的事件流。

第三个：

```text
失败的那一次，输入被完整记录下来了吗？
```

只记"失败"两个字的，等于没记。

第四个：

```text
token 是从响应的 usage 里读的，还是你自己估的？
```

估的会有系统性偏差，账本对不上账。

第五个：

```text
trace 是写 stdout，还是写到了能查询的地方？
```

写 stdout 的，就是给"当时在场的人"看的。

五个问题都能答"是"，这套系统才具备"事后能查"的能力。

答不上来的，通常不是不会写。

是没想过"三个月后有人会来问为什么"。

## 15. 小结

这篇只回答两个问题。

```text
刚才那一轮发生了什么？
花了多少钱？
```

trace 的最小模型：

```text
一次任务 = 一个 trace
一次模型调用 = 一个 span
一次工具执行 = 一个 span
```

六个必记字段：

```text
起止时间 / 输入摘要 / 输出摘要 / token 数 / 状态 / 错误
```

三句要一直记着的话：

```text
日志是散点，trace 是树。
成本要按尝试记，不是按成功记。
存下完整 messages，失败才能重放。
```

以及那个反直觉的判断：

```text
让它成功，你只需要一个好 prompt。
让失败可复现，你需要一整套 trace + 重放。
```

三个指标、两个告警、一个复盘顺序：

```text
成功率 / P95 时延 / 单任务成本
步数异常 / 成本异常
时间 → 第一个错误 → 错误前的输入 → 重复动作 → 成本尖峰
```

下一篇是接入真实世界的第一步：

```text
Agent 系统讲解 15：接真模型：把假模型换掉
```

后面会讲：

```text
假模型和真模型的协议差在哪？
arguments 为什么是字符串？
429、超时、断网分别怎么处理？
流式输出怎么和工具调用共存？
```

到那一篇，你的 agent 才第一次见到真的模型。

而这一篇的东西，会在第一次真模型失败的时候救你。

最后一句。

可观测性不是给"线上出事"准备的。

是给"你想改进它"准备的。

```text
没有 trace，你只能凭感觉改 prompt。
有 trace，你能看见它在哪一步开始不对。
```

前者是调参。

后者是工程。
