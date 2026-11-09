---
title: "Agent 系统讲解 15：接真模型：把假模型换掉"
date: 2026-11-09 12:10:00 +0800
permalink: /posts/agent-connect-real-model/
categories: [Agent, 系统讲解]
tags: [agent, llm-api, tool-calling, adapter, retry, error-handling]
description: "把 L01 的 ScriptedModel 换成真模型：arguments 是字符串、content 可能是 null、schema 必须随请求发、消息顺序错就 400、429 和 5xx 要退避重试，全部差异收敛进一个适配器，循环本身一行不动。"
---

<!-- series-nav -->
> **系列位置**：Agent 系统讲解，第 15 篇 / 共 18 篇
> **总目录**：[学习地图](/posts/agent-systematic-learning-map/)
> **上一篇**：[14：可观测性与成本](/posts/agent-observability-and-cost/)
> **下一篇**：[16：综合项目：把 17 篇拼成一个成品](/posts/agent-capstone-checklist/)


你写了一个适配器。
三十行，把 `Message` 转成 dict，扔给 HTTP。

第一次请求回来了：

```text
400 Invalid type for 'messages[3].tool_calls[0].function.arguments':
    expected a string, but got an object

400 tools is required when messages contains tool_calls

400 messages with role 'tool' must be a response to a preceding
    message with 'tool_calls'
```

三条错误，你按顺序撞上。
每撞一次，改一个字段，觉得"就差这一点了"。

改到第三条的时候，你开始怀疑 `run_agent` 那 12 行写错了。
然后你盯着它看了半小时，发现它是对的。

问题在适配器：你把上一轮的 `tool` 消息塞在了一条新的 `user` 消息后面。

三发 400，没有一发是循环逻辑的错。

接真模型这件事，难点从来不在"模型变聪明了"。
难点在：你原来的代码，一直活在一个不会拒绝你的世界里。

## 1. 换模型那一刻，炸的是协议，不是逻辑

假模型（`ScriptedModel`）有一个你平时感觉不到的属性。

它永远接受你给的任何东西。

它不看 `role` 是不是合法。
它不管 `tool_call_id` 对不对得上。
它不知道什么叫 `arguments` 字符串。
它甚至不在乎你压根没告诉它有哪些工具。

它是你自己写的，它跟你一样宽容。

真模型那边站着一个校验器。
它在你看到回复之前，先把请求逐字段审一遍。
字段名错、类型错、顺序错，一律 400，一个 token 都不给你。

这一步的落差，比"换了个更强的模型"重要得多。

假模型是一面镜子，照出你的循环。
真模型是一道闸门，先验你的协议。

所以接真模型要做的事只有一半是"把模型接上"。
另一半是"把它的拒绝翻译成你能处理的异常"。

两件事都不在 `run_agent` 里。

有三类人栽在这里，栽的方式不一样。

第一类人，直接删掉假模型，在 `run_agent` 里写 `client.chat.completions.create(...)`。
循环活了，但从此和一家 SDK 绑死。

第二类人，把 SDK 的 response 对象整个塞进 `messages.append(...)`。
下一轮请求炸了，因为历史里躺着几个 `ChatCompletion` 对象。

第三类人，把重试写在最外层。
`try: run_agent(...) except: 重试`。
第四步 429，整个任务重来，前三步的工具副作用全部做了两遍。

三类人犯的是同一个错：把"世界的形状"直接塞进了"逻辑的骨架"。

这里还有一句要给假模型说清楚的话。

假模型能测的只有控制流：循环会不会退出、保险丝会不会切、工具结果有没有回填。
它测不出协议，因为它是照着你脑子里的协议写的。
你记错了 `arguments` 的类型，它也跟着你记错。

所以接真模型之后，你补的不是"更好的假模型"。
你补的是一层把真协议挡在外面的边界。

## 2. 为什么 `model.chat(messages) -> Message` 这个签名不能改

`agent.py` 里那句注释，是整门课埋得最深的一颗钉子。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
def run_agent(
    model,
    tools: dict[str, Tool],
    messages: list[Message],
    max_steps: int = 10,
    verbose: bool = True,
) -> str:
    """跑一个 agent，返回最终回答。

    model 只需要有一个方法：model.chat(messages) -> Message
      —— 这是整节课最重要的接口约定。L03 换成真模型时，这个签名不变。
    """
```

"签名不变"不是一个偷懒的说法。
它是一条设计约束，换来三样东西。

第一样：循环不认识供应商。

`run_agent` 里没有 `openai`，没有 `anthropic`，没有 `base_url`。
它只知道两件事：`messages` 进，`Message` 出。

第二样：假模型可以一直留着。

写了真模型之后，`ScriptedModel` 不能删。
它是你的回归测试夹具（fixture）：不花钱、不联网、跑得比真的快一千倍。
[09 篇](/posts/agent-evals/)那套评测（eval）里，一半用例到现在还是用假模型跑的。

第三样：换供应商的时候，改动有边界。

你要在 DeepSeek、OpenAI、通义、月之暗面之间换，只改适配器里三行：`base_url`、`api_key`、`model`。
循环、工具、评测、trace 全都不动。

如果反过来，让 `run_agent` 直接调 SDK，上面这三样全部没有。
你的循环会变成一个"只对一家 API 有效的循环"。

那它就只是个脚本，不是 agent 骨架。

签名里还有一个隐性约定，很多人没注意到：同步、一次返回完整回复。

`chat` 进去一整段历史，回来一条完整消息。
没有回调，没有生成器，没有"边收边处理"。

这不是因为它简单，是因为它把"流式"和"工具调用（tool call）"这两件本来就难缠的事挡在了循环外面。
循环只需要在"有这一条消息"的时刻做判断。
至于这一条消息是流式拼出来的还是整块拿到的，循环不需要知道。

这个约定在接真模型时不改。
流式的取舍放到适配器里做，见第 11 节。

## 3. 十项差异，逐条摊开

这张表是这一篇的骨架。
后面每一节都在解释其中一行。

| # | 差异点 | 假模型 | 真模型 | 你要做的 |
|---|---|---|---|---|
| 1 | 工具参数 | `args` 是 `dict` | `arguments` 是 JSON 字符串 | `json.loads`，失败要分类 |
| 2 | `content` | 总是字符串 | 可能是 `null` | 把 `null` 当合法，别当错误 |
| 3 | 工具调用数 | 剧本写几个就几个 | 一轮可能 0 个、1 个、好几个 | 按列表处理，别假设唯一 |
| 4 | 调用编号 `id` | 你自己造 | 服务端生成 | 原样带回，绝不自己编 |
| 5 | 工具说明书 | 不需要 | 必须随请求发 `tools` | 维护 schema 注册表 |
| 6 | 消息顺序 | 不校验 | 硬校验，错了 400 | 严格按协议 append |
| 7 | 网络 | 没有 | 超时、断网、429、5xx | 分类 + 退避重试 |
| 8 | 上下文上限 | 没有 | 有，超了报错或截断 | 识别 + 裁剪，不硬重试 |
| 9 | 确定性 | 完全确定 | 同输入两次可能不同 | 记录请求、跑多次看通过率 |
| 10 | 计费 | 免费 | 输入输出分开算，重试也算 | 记账、预算、熔断 |

十行里，只有第 3 行和第 6 行可能让你想动循环。

而这两行的正解都是"别动循环"。

第 3 行：循环本来就是 `for call in reply.tool_calls`，它早就是按列表写的。
第 6 行：`agent.py` 里 `messages.append(reply)` 那行注释，已经写明了正确顺序。

L01 把这两件事做对了，所以你现在不用改。

剩下八行里，第 9 行和第 10 行的处理方式最容易被低估。
它们看起来是"运维问题"，实际决定你能不能用真模型调一个系统。
一个结果随机的系统，你没法定评测；一个账单不透明的系统，你没法定预算。
这两件事分别在 [09 篇](/posts/agent-evals/) 和 [14 篇](/posts/agent-observability-and-cost/) 里，接真模型之后才真正开始生效。

这张表还有一种记法。

第一、二、四行属于形状：字段长什么样，值是什么类型。
第三、五、六行属于协议：谁能看见谁，顺序怎么排，缺一条会怎样。
第七、八行属于环境：网络和窗口，不是你写的，但你得受着。
第九、十行属于账：一次多少钱，两次为什么不一样。

形状靠类型转换解决，协议靠 append 顺序解决，环境靠识别和退避解决，账靠记录解决。
四种解法，四种地方，一件都不能混。

## 4. 最小适配器：`OpenAICompatibleModel`

先说形状。

OpenAI 兼容接口的一次调用，就是往 `/chat/completions` POST 一个 JSON，拿回一个 JSON。
请求里有 `model`、`messages`，可选 `tools`、`tool_choice`、`temperature`。
回复在 `choices[0].message`，工具调用在 `message.tool_calls`。

适配器做的就是把这两头对上。
它要用的内部类型，还是 `agent.py` 开头那 30 行里的 `Message` 和 `ToolCall`，一个字段都不增。

```python
import json
import urllib.error
import urllib.request

from agent import Message, ToolCall


class ModelError(Exception):
    """模型层可预期的失败，全部收敛到这一族。"""
    retryable = False


class RetryableError(ModelError):
    """网络抖动、429、5xx：过一会儿再来可能就好了。"""
    retryable = True


class BadRequestError(ModelError):
    """400 / 401 / 参数错：重试一万次也还是错的。"""


class ContextOverflowError(BadRequestError):
    """上下文超限：也是 400，但处理方式和别的 400 完全不同。"""


class OpenAICompatibleModel:
    def __init__(self, model, api_key, base_url, tool_schemas=(), temperature=0.0,
                 timeout=60, transport=None):
        self.model = model
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.temperature = temperature
        self.timeout = timeout
        self.tools = [{"type": "function", "function": s} for s in tool_schemas]
        self._transport = transport or self._http

    def _http(self, payload):
        req = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + self.api_key},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise _map_http(exc.code, exc.read().decode("utf-8", "replace")) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RetryableError(f"网络失败：{exc}") from None

    def _encode(self, m):
        if m.role == "tool":
            return {"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content}
        if m.role == "assistant" and m.tool_calls:
            return {"role": "assistant", "content": m.content or None,
                    "tool_calls": [{"id": c.id, "type": "function",
                                    "function": {"name": c.name,
                                                 "arguments": json.dumps(c.args, ensure_ascii=False)}}
                                   for c in m.tool_calls]}
        return {"role": m.role, "content": m.content}

    def chat(self, messages) -> Message:
        payload = {
            "model": self.model,
            "messages": [self._encode(m) for m in messages],
            "temperature": self.temperature,
        }
        if self.tools:
            payload["tools"] = self.tools
            payload["tool_choice"] = "auto"
        data = self._transport(payload)
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        calls = [ToolCall(id=c["id"], name=c["function"]["name"],
                          args=_parse_args(c["function"].get("arguments")))
                 for c in msg.get("tool_calls") or []]
        return Message(role="assistant", content=msg.get("content") or "", tool_calls=calls)
```

两个工具函数在下面补。

```python
def _parse_args(raw) -> dict:
    if isinstance(raw, dict):                 # 少数实现直接给对象，兼容一下
        return raw
    if not raw:                               # null / 空串 = 无参工具
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BadRequestError(f"arguments 不是合法 JSON：{raw!r}（{exc}）") from None
    if not isinstance(value, dict):
        raise BadRequestError(f"arguments 必须是对象，实际是 {type(value).__name__}")
    return value


def _map_http(status: int, body: str) -> ModelError:
    if status == 408 or status == 429 or status >= 500:
        err = RetryableError(f"HTTP {status}：{body[:200]}")
    elif status in (400, 422) and ("context" in body.lower() or "too long" in body.lower()):
        err = ContextOverflowError(f"HTTP {status}：上下文超限（{body[:120]}）")
    else:
        err = BadRequestError(f"HTTP {status}：{body[:200]}")
    err.status = status
    return err
```

这段代码我实测过。
把 `transport` 换成一个假函数，它能在完全离线的机器上跑通，连 `run_agent` 一起跑完两轮。

`transport` 这个注入点就是为了这个。
注意 class 里那行 `self._transport = transport or self._http`，它不是花活。

它让"网络"变成一个参数。
于是断网、超时、429 都能在测试里被造出来，不需要真的等一个不存在的服务器。

工程上这叫可测性（testability）。
在 agent 项目里，它比代码整洁重要得多。

为什么不直接用 `openai` SDK？
可以，`requirements.txt` 里 L03 起就加 `openai>=1.30`，用起来更省事。

这里用标准库写，是因为 SDK 把四件事藏起来了：拼 payload、发 HTTP、分类错误、重试。
这四件事恰恰是你现在要看清的东西。

看完这九十行，你再回去用 SDK，会发现它也只是这四件事，包装得更舒服而已。
那时候出问题，你知道该去哪一层找。

## 5. 一次真调用的完整生命周期

把一个循环步骤放大，从里到外是四层。

```text
第 1 层  run_agent
        messages（内部 Message 列表）
            │
第 2 层  适配器 _encode
            │  每一条 Message 翻成 dict
            │  tool_calls 里的 args 翻回 JSON 字符串
            ▼
        payload（一次请求的全部内容，是一份无状态快照）
            │
第 3 层  HTTP
            │  POST /chat/completions
            │  ← 200 / 400 / 429 / 5xx / 超时 / 断网
            ▼
第 4 层  适配器 chat
            │  解析 choices[0].message
            │  arguments 字符串 → dict
            ▼
        Message（交回第 1 层）
```

第四层出来的是 `Message`，第一层吞进去的也是 `Message`。
中间那两层，就是"真实世界"。

这张图能解释三件平时想不明白的事。

一件：为什么每次都那么贵。
第 2 层那个 payload 是全量快照。
历史有多长，发出去就有多长。
`messages` 里的每一条，每一轮都重新计费。这就是 [02 篇](/posts/agent-token-context-window-budget/)说"上下文是单次预算"的实际含义。

二件：为什么同样的输入，账单会不一样。
第 3 层重试了一次。
你的代码只调了一次 `chat`，账上却是两次请求。

三件：为什么 trace 要记 payload。
第 4 层出错时，你手上只剩一个 `Message`。
如果没把 payload 存下来，你复现不了那一轮。

把一次失败的调用也画出来，你会更清楚重试落在哪。

第 3 步，payload 8.2k token 发出去。
TCP 连上了，服务端开始算。
27 秒后读超时，适配器抛 `RetryableError`。
`retry` 睡 0.5 秒（带抖动），重发同一个 payload。
这次 200，拿到 `tool_calls`。
循环继续，`messages` 里只多了一条 assistant。

重试对循环是完全透明的：它只看见一次成功的 `chat`。
所以循环里的 `step` 计数也不会被重试污染。

这就是"重试放在适配器"的具体好处。

## 6. `arguments` 是字符串，这是最大的形状差异

假模型里，`ToolCall.args` 是 `dict`。
你真模型回来的第一条，长这样。

代码来源：OpenAI Chat Completions 的响应形状（字段名真实存在）

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_a1b2c3",
      "type": "function",
      "function": {
        "name": "calculator",
        "arguments": "{\"expression\": \"12 + 8\"}"
      }
    }
  ]
}
```

`arguments` 是一个字符串。
字符串里面还是 JSON。

所以你照着假模型写的那行会当场炸。

`raw = call["function"]["arguments"]` 拿到的是字符串。
对 `raw` 直接取键，抛的是 `TypeError: string indices must be integers`。

正确做法只有两步：先 `json.loads(raw)` 得到 dict，再取 `args["expression"]`。
两步之间的那一次 `json.loads`，就是假模型世界里从来不存在的那一步。

为什么要设计成字符串？

因为工具的参数 schema 是任意的。
协议层不想知道你的 `expression` 是字符串还是嵌套对象，它只承诺"我把一段 JSON 文本原样带给你"。
解析归你，校验归你，报错也归你。

流式输出下这个设计更明显：参数是一小块一小块吐出来的，先拼成完整字符串，再解析一次。
如果一开始就是对象，拼接会难写得多。

顺带说一句 Anthropic 的差别，免得你换供应商时懵。
OpenAI 兼容接口用 `tools` + `tool_calls` + `role:"tool"`。
Anthropic 用 `tools` + `tool_use` / `tool_result` 内容块。
两套都真实存在，形状不一样，语义同源。
适配器存在的意义，就是让你不用同时记住两套。

### 6.1 解析失败不能装死

`json.loads` 会抛 `JSONDecodeError`。
三种常见原因：

- 模型把参数写成了 Python 字面量，比如 `{'expression': '1+1'}`，单引号不是合法 JSON
- 参数写到一半被 `max_tokens` 截断，比如 `{"expression": "1+1`
- 压根没给参数，`null` 或者空串

第一条在弱一点的模型上很常见。
第二条是你自己把输出上限设小了，这是最冤的一种：工具调用被截断，你还以为模型不会用工具。

三种都不该让进程崩。
也不该"猜一个能用的 dict 出来"。

猜是最坏的选择。
你把 `{"expression": "1+1"` 猜成 `{"expression": "1+1"}`，工具真的跑起来了，返回一个看起来对的结果。
然后你花两天查"为什么模型算错了"。

参数解析失败，是一等公民错误。
它要被明确分类，而不是被 `try/except` 顺手吞掉。

上面的适配器选了严格路线：抛 `BadRequestError`，由外层决定怎么处理。

还有一条宽松路线：把解析失败变成一条 `tool` 消息，让模型自己重试。
那条路要多改一处 `_execute`，是 [05 篇](/posts/agent-tool-error-selfheal-fuse/)讲的自愈（self-heal）。

两条都能用。
区别是：严格路线保证你拿不到"看起来对"的结果，宽松路线保证任务不中断。

生产里我倾向宽松，但只在参数解析这一处宽松。

## 7. `content` 为 `null` 也是合法的

这是接真模型第二天会撞上的事。

假模型里，`Message.content` 默认是 `""`。
你真模型回来的第一条，`content` 是 `null`。

很多人第一反应是加一句防御：`if not msg.get("content"): raise ValueError(...)`。

然后你的 agent 在每一个正常调用工具的轮次里都崩一次。

因为"我要调工具"这种回复，本来就没有正文。

协议里一次 assistant 回复有三种合法形态。

- 形态 A：只有 `content`，它在说话，没打算干活
- 形态 B：`content` 为 `null`，有 `tool_calls`，它只想干活，不想说话
- 形态 C：`content` 有字，也有 `tool_calls`，边说话边干活，真模型最常见

适配器里那行 `content=msg.get("content") or ""` 就是在兼容 A、B、C。
内部 `Message` 用空串表示"没有正文"，因为 `str` 比 `None` 少一层分支。

`or ""` 还有一个副作用你可能不喜欢：`content` 是 `0` 或 `false` 时也会变成空串。
在这里没问题，因为 `content` 只可能是字符串或 `null`。
但这个坑换到结构化输出（[08 篇](/posts/agent-structured-output/)）里就致命了，那里 `0` 是合法值，不能和"没有"混为一谈。

### 7.1 "只说话不调工具"和"一直调工具"

这两种都是真模型的高频行为，而且都不是 bug。

只说话不调工具，有两种情况。

一种是它真答完了，循环正常退出。
另一种是它该调工具却没调：你问"今天几号"，它凭训练数据里的时间瞎编了一个。

第二种在接真模型后会明显变多，因为假模型永远按剧本走。
识别方法很土：看它的回答里有没有"我无法获取实时信息"这类话，或者直接对答案。
处理方法是 [03 篇](/posts/agent-tool-protocol-json-schema/)那件事，把工具描述写清楚，把 `tool_choice` 用对。

一直调工具，也有两种情况。

一种是任务真的要很多步。
另一种是它在原地转圈：调同一个工具、同一组参数、连续四轮。

假模型的死循环是你写出来的。
真模型的死循环是它"礼貌地"转出来的。

所以 `max_steps` 这道保险丝（fuse），接真模型之后才真正开始工作。
L01 里它是演示，L03 里它是保命的。

如果你想提前发现转圈，不用等 `max_steps` 打满。
在循环外面记一个 `(name, args)` 的重复计数，同一个键出现第三次就当成卡住处理。

这个判断放在 05 篇那套刹车里，不要塞进 `run_agent` 的 12 行。
原因和整篇一样：循环只负责控制流，诊断属于外层。

还有一件和"一直调工具"配套的事：想清楚卡住之后给用户什么。

`max_steps` 触发的默认返回值是"（达到最大步数，强制停止）"。
这句话对程序够用，对人不够用。
用户想知道的是：它做到哪一步了，哪些结论已经确定，哪些还没有。

所以生产里那个兜底回答，通常是拿历史里最后几条观测拼出来的半成品，再加一句"我卡在第三步，需要你确认 X"。
这一点在 [10 篇](/posts/agent-planning-decomposition/)的规划器里会变成"未完成步骤清单"。

## 8. 一轮多个 `tool_calls`：`id` 和服务端对账

`ScriptedModel` 的 `tool_call()` 里有一行自己造 id 的代码，用 `hash((name, args))` 拼出一个 `call_名字_四位数`。
假模型里这样没问题，反正没有别人看。

真模型里，`id` 是服务端生成的，形如 `call_a1b2c3` 的一串。
你的职责只有一条：原样带回。

不要重写，不要截断，不要"我觉得这个 id 不好看换一个"。
`tool` 消息里的 `tool_call_id` 和 `assistant` 消息里的 `id` 是同一个字符串，少一个字符都是 400。

### 8.1 三条硬校验

这三条在 OpenAI 兼容接口上基本一致，Anthropic 的 `tool_use` / `tool_result` 形态不同但约束同源。

第一条：`role: "tool"` 的消息，前面必须有一条带 `tool_calls` 的 assistant。

第二条：一条 assistant 里有几个 `tool_calls`，后面就必须跟几条 `tool` 消息，一个都不能漏。
漏一个，下一轮 400。多一个没有对应 id 的，也 400。

第三条：`tool` 消息不能插在别人的 `assistant` 后面，也不能被 `user` 消息隔开。

`agent.py` 的 12 行循环，天然满足这三条。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
for call in reply.tool_calls:
    observation = _execute(call, tools)
    messages.append(
        Message(role="tool", content=observation, tool_call_id=call.id)
    )
```

`reply` 先进历史，然后每个 `call` 挨个执行、挨个 append。
顺序、数量、id 全部对得上。

第二条还有一个隐蔽的坑：`_execute` 永远返回字符串，永远不会抛。
所以"某个工具崩了"不会让那一条 `tool` 消息消失。
如果 `_execute` 改成抛异常，循环会中断在中间，历史里就只剩下前两条 `tool` 消息。
这个残缺历史在下一次请求时直接 400。

工具失败必须留下一条观测，这不只是"让模型自愈"。
它还是协议完整性的一部分。

### 8.2 并发执行会踩的坑

一旦你想"三个工具并行跑，快一点"，就会碰到顺序问题。

`asyncio.gather` 是保序的，按输入顺序返回结果，这样写没问题。
但换成 `as_completed` 或者回调，append 的顺序就变成完成顺序，不是调用顺序。

有些实现能容忍 `tool` 消息乱序，靠 id 对账。
有些不能。
你不知道下一家供应商站在哪一边。

安全写法是先按 `index` 收齐，再一次性顺序 append：用一个 `by_index` 字典存结果，最后 `for i in sorted(by_index)` 逐条写回 `messages`。
代价是多写四行。
收益是这套代码在换供应商时不用重写。

## 9. 工具 schema 必须随请求发出去

假模型"知道"有 `calculator`，因为剧本是你看过 `TOOLS` 之后写的。

真模型不知道。
它看不见你的 Python 文件，看不见 `TOOLS` 字典，也看不见 `def calculator(expression: str) -> str`。
它只看得见你这次请求里 `tools` 字段的内容。

不发的后果很干脆：它永远不调工具。

它不会报错，也不会提醒你。
它只会用自然语言回答："我无法进行精确计算。"

然后你以为是模型不行。

工具没注册，对应的是"模型看不见"。
schema 没发出去，对应的是"模型瞎了"。

这两种症状长得几乎一样，但排查顺序不一样。
先看请求体里有没有 `tools` 字段，再看 `name` 对不对得上注册表，最后看 `description` 是不是写得太含糊。

多数人一上来就改 system prompt。
改十遍也没用，因为模型不是不肯用工具，是压根不知道有工具。

`TOOLS` 里只有函数，没有说明书。
所以你要再维护一张 schema 表。

```python
TOOL_SCHEMAS = [
    {
        "name": "calculator",
        "description": "计算一个四则运算表达式，支持 + - * / 和括号，例如 (12+8)*3",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {"type": "string",
                               "description": "要计算的表达式，例如 (12+8)*3"}
            },
            "required": ["expression"],
        },
    },
]

model = OpenAICompatibleModel(
    model=os.environ["DEEPSEEK_MODEL"],
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url=os.environ["DEEPSEEK_BASE_URL"],
    tool_schemas=TOOL_SCHEMAS,
)
```

`os.environ` 那三行对应 `.env.example` 里的三个变量名。
不要把它们写死在代码里，也永远不要把 `.env` 提交进 git。

03 篇讲的就是这张 schema 表怎么写。
这里只提醒三件和成本有关的事。

一件：schema 每一轮都发。
工具越多，每次请求的输入 token 越多。二十个工具的说明书能占掉几千 token，而你只用到其中一个。

二件：`description` 是给模型看的 prompt。
写"计算表达式"和写"计算四则运算表达式，支持括号，输入必须是字符串"，模型的调用准确率不一样。
这部分字不是白花的。

三件：`name` 必须和 `TOOLS` 的键完全一致。
差一个下划线，模型会调一个不存在的工具，`_execute` 返回"没有这个工具"的观测，模型再猜一次，来回烧钱。

工具到十几个之后，还有一条路：按场景分组，只暴露当前需要的几个。
或者用 `tool_choice` 强制它在某一轮调指定的工具，把选择空间压到零。

这两种做法都牺牲灵活性，换回合数和费用。
09 篇的做法是先量出来再决定。
多数场景其实不需要二十个工具，需要的是一个写得好的。

## 10. 网络层：哪些能重试，哪些重试就是浪费

到这里，协议已经对上了。
接下来是"真实世界会教你的事"。

假模型不会超时。
真模型会，而且会在你最不希望的时候超时。

失败可以分成两类。

- 可重试：连接失败、DNS 失败、读超时、429 限流、500 / 502 / 503 / 504
- 不可重试：400 参数错、401 / 403 密钥或权限、404 路径或模型名错、上下文超限、工具 schema 不合法

判断依据很简单：换个时间点再发一次，结果会不会变。

会变，就重试。
不会变，就立刻把错误抛给人。

400 重试一百次，你只是把同一条错误日志打印了一百遍，顺便把账单乘以一百。

### 10.1 指数退避 + 抖动

如果 429 之后立刻重试，你会把限流打成更严重的限流。
服务端刚说"慢点"，你立刻又冲上去。

所以要退避：每次失败，等的时间翻倍。

再要抖动：等的时间加一点随机。
不然一百个客户端会在同一毫秒一起重试，形成新的尖峰。

```python
import random
import time
from functools import wraps


def retry(max_attempts=5, base=0.5, cap=20.0):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            for attempt in range(1, max_attempts + 1):
                try:
                    return fn(*args, **kwargs)
                except ModelError as exc:
                    if not exc.retryable or attempt == max_attempts:
                        raise
                    delay = min(cap, base * 2 ** (attempt - 1))
                    delay = max(random.uniform(delay / 2, delay),
                                getattr(exc, "retry_after", 0))
                    time.sleep(delay)
        return wrapper
    return deco
```

五行关键逻辑，说清就够。

`exc.retryable` 是分类开关，定义在异常类上，不用在 `if status == 429` 里硬编。

`2 ** (attempt - 1)` 是指数，`cap` 封顶，不然第 8 次要等两分钟。

`random.uniform(delay / 2, delay)` 是抖动，把"同时重试"打散。

`retry_after` 是服务端在 429 响应头里给的提示，有就听它的，别自作聪明。

用法是套在 `chat` 上，也就是第 4 节那个 class 里加一行装饰器：`@retry(max_attempts=4, base=0.5, cap=8.0)`。

### 10.2 一个容易搞反的点

重试的单位是"一次 chat 调用"，不是"整个 agent"。

把 `retry` 套在 `run_agent` 外面，是最常见的错误。
一次任务五步，第四步 429 了，退避重试整个任务，前三步的工具会被再执行一遍。

如果那些工具有副作用（发邮件、写数据库、删文件），你就真的发了两封邮件。

重试一次模型调用，最坏是多花一次钱。
重试一次有副作用的工具调用，最坏是把事情做坏两遍。

所以重试只套在模型调用上。
工具的重试是另一回事，要按 05 篇和 [13 篇](/posts/agent-security-permissions-sandbox/)的规矩单独设计。

### 10.3 超时怎么设

`urllib` 的 `timeout` 参数是一个总时长。
更讲究的做法是连接超时和读超时分开，多数 HTTP 客户端支持。

连接超时三到五秒就够，连不上就是连不上，别等。
读超时给到六十到一百二十秒，模型在算，你得等它。

读超时设得太短，是新手最常犯的错。
长输出的请求本来就慢，三十秒可能刚到一半。
于是你的程序一直在超时、重试、再超时，看起来像"网络不好"，实际是超时设错了。

反过来，读超时设成六百秒也不对。
用户端早就断了，你还在烧 token。

还有一个兜底：熔断。
连续 N 次重试都失败，就别再重试了，直接把错误抛给人。
不然一次供应商故障会让你的进程卡在退避睡眠里，一卡半小时。

重试之外还有一头要管：你自己的并发。
一次任务开三十路并发，就算供应商的限额够，你也会把自己打成 429。
限流不是"别人太忙"，多数时候是"你太急"。

并发上限和重试次数要一起定。
并发 30、每路重试 4 次，最坏情况是 120 个请求同时压上去。
把并发压到 3、重试 3 次，总请求量一样，峰值低一个数量级。

## 11. 四件上生产才会遇到的事

### 11.1 上下文超限：两种表现，别混

第一种是报错，响应体里写着 "maximum context length" 和两个数字：上限、你请求了多少。
`finish_reason` 这种时候根本没有，因为请求压根没成功。

第二种是没那么明显的：`finish_reason` 是 `"length"`。
请求本身成功了，但输出被你自己的 `max_tokens` 截断。

两者完全不是一回事。

前者是输入太长，要裁剪历史。后者是输出不够长，要调大上限或者让它少说点。

识别前者只能靠看响应体里的错误信息。
不同供应商措辞不同，`context`、`maximum context`、`too long` 都可能出现。

字符串匹配不优雅，但它是目前唯一通用的办法。
具体关键字以你要用的供应商文档为准。

识别之后的处理，一定不是重试。
重试只会再超限一次。

处理是把历史裁到窗口以内：丢最早的、保留最近的、或者把中间一段摘要成一句。
这是 [06 篇](/posts/agent-context-engineering/)的全部内容。

这里只补一句取舍，因为它在接真模型的第一周就会碰到。

丢最早的，最容易实现，代价是系统提示之外的第一句用户需求会消失，agent 忘了目标是什么。
保留最近的，最符合直觉，代价是长任务的早期结论全丢。
摘要中间那段，效果最好，代价是你又要多调一次模型，而且摘要本身也会丢细节。

三种都要留痕：裁掉了多少条、留下了多少条、这次请求估算多少 token。
不然你只会在下一次超限时重新猜一遍。

### 11.2 流式输出的取舍

流式（streaming）的好处是首字延迟低。
用户看到字一个个出来，感觉快。

代价在工具调用上。

非流式时，`arguments` 是一个完整字符串，一次给你。
流式时，它是增量的：一小块一小块，分散在多个 chunk 里，还要按 `index` 聚合成一条完整调用。

第一个 chunk 里可能只有 `tool_calls[0].index=0` 和 `name="calculator"`。
第二个 chunk 补上 `arguments="{\"expr"`。
第三个 chunk 才把 `arguments` 补成 `"ession\": \"1"`，第四个收尾 `"2+8\"}"`。

你得自己拼。
拼错了，解析就错；解析错了，工具就调错。

还有一个细节：流式的最后一帧里可能有 `usage`，也可能没有，取决于供应商的选项。
所以流式下的计费统计，常常要靠你自己数 token，或者事后拉账单。
这也是 14 篇建议"先按非流式把账记准"的原因。

所以取舍很清楚。

面向人的问答，打字机效果有感知价值，开流式。
工具密集的 agent，一轮好几个调用，先别开。

还有一个更硬的理由：流式一旦断了，重试很别扭。
你已经吐出 200 个字，用户看到了，重试会把前 200 字再说一遍。

非流式的重试是干净的：整次调用失败，整次调用重来。

### 11.3 非确定性：`temperature=0` 不是保证

同一个输入，两次调用，结果可能不一样。

`temperature=0` 会让采样变得几乎确定。
"几乎"这两个字很重要。

公开资料里的说法不完全一致：批处理顺序、浮点累加顺序、后端版本、缓存命中，都可能让同一份输入走出不同的结果。
工程上你只要记住一句：`temperature=0` 把方差压小，不等于把方差清零。

所以调试要可复现，不能靠"再跑一次它应该还会这样"。

三个办法，按成本排。

第一个：把每次请求的完整 payload 存下来。
出问题时，你能拿原始请求离线重放，而不是凭记忆重建。
这也是 14 篇 trace 里最该存的那个字段。

第二个：把模型名和版本固定住。
`model` 写死到具体版本号，别用会漂移的别名。供应商升级后端时，这是你唯一的锚点。

第三个：评测用例跑多次，看通过率。
一条用例跑一次过，说明不了什么；跑十次过九次，才是一个数。

09 篇那套评测，就是为这件事准备的。

### 11.4 计费：输入和输出不是一个价

按 token 计费，输入和输出单价不同。
具体数字不写，因为会变，写下来就是过期信息。

要记住的是四件会计入账单的事。

- 每一轮都重发全部历史，输入 token 随轮次线性增长
- system prompt 和工具 schema 每轮都发，是固定开销，工具越多越贵
- 重试也计费，一次重试就是一次完整请求
- 输出通常比输入贵，让它少说废话，真能省钱

第一条最容易被低估。
十轮的对话，输入量不是第一轮的十倍，而是接近累加和。
这就是 14 篇里"账本"要按轮记、而不是按任务记的原因。

`usage` 里能拿到输入和输出的 token 数，OpenAI 兼容接口一般给 `prompt_tokens` 和 `completion_tokens`。
有的供应商还会给缓存命中的部分，价格更低。
这些字段名以你要用的供应商文档为准，别照着这篇文章硬背。

把钱记成两列，你的成本估算才有意义。
记成一列总数，你永远不知道自己该优化哪一半。

## 12. 为什么是适配器，不是改 `run_agent`

现在回到那句反直觉的话。

> **接真模型时要改的代码，几乎全在适配器和错误处理里。循环本身一行都不用动。**
>
> 这不是巧合，是 L01 那 12 行写对了的证据。

把常见的错误改法列一下，你就知道为什么。

错误改法一：在循环里判断供应商。
`if provider == "openai": ... else: ...`。
循环变成了"供应商路由器"，每接一家新的，你都在改最不该改的那段代码。

错误改法二：在循环里解析参数。
`args = json.loads(call.args)` 看起来只加了一行。
实际上你把"协议差异"和"控制流"焊在了一起。
假模型回来的是 dict，这行会崩；真模型回来的是字符串，这行能过。
于是你需要再加一个 `isinstance` 分支。

错误改法三：在循环里 catch 网络异常，然后 `time.sleep(1); continue`。
这行 `continue` 看起来像重试。
实际上它把"这一轮失败"变成了"这一轮重来"，而 `step` 已经被消耗掉了。
而且它连 400 也一起重试了。

三种改法有同一个病根：把"世界的形状"塞进了"逻辑的骨架"。

三层结构应该是这样的。

```text
┌──────────────────────────────────────────┐
│  run_agent       只认 Message             │  你写的逻辑
├──────────────────────────────────────────┤
│  适配器          翻译 + 分类 + 重试        │  供应商的形状
├──────────────────────────────────────────┤
│  网络 / 供应商    HTTP、限流、超时         │  真实世界
└──────────────────────────────────────────┘
```

好处不只是"代码干净"。

它还意味着这三层可以各自被替换、各自被测试。
适配器换一家供应商，循环和评测不动。
循环加一个新特性，适配器不动。
网络出问题，你只在第三层看日志。

反过来，三层糊在一起的时候，一个 429 能让你同时怀疑循环、怀疑 prompt、怀疑工具。

那才是接真模型最耗时间的部分。

适配器的边界也要划清。
它该做的事：编码、解码、错误分类、重试、记录原始请求。
它不该做的事：决定要不要调某个工具、判断用户有没有权限、修改历史顺序、写业务逻辑。

后四件事，一件属于循环，两件属于 13 篇的权限层，最后一件属于你自己的代码。
塞进适配器，你就又有了一层"看起来能跑但说不清在哪出错"的东西。

## 13. 回到真实工程：L03 的验收线

`路线图.md` 给 L03 定的产出和过关标准很具体。

产出是一个能跑真模型的命令行 agent。
过关标准是断网、超时、限流都不崩。

"都不崩"这三个字，比"能跑通"难得多。

因为它要求你在没有网络故障的时候，也能证明网络故障被处理了。

这就是 `transport` 注入点的价值。

```python
class FakeTransport:
    """把网络换成剧本 —— 和 L01 的假模型是同一个思路。"""

    def __init__(self, replies):
        self.replies = list(replies)
        self.payloads = []

    def __call__(self, payload):
        self.payloads.append(payload)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply
```

用它就能写五个不花钱的验收项。

- 正常一轮：工具调用、观测、最终回答，历史顺序对
- `arguments` 是字符串：内部拿到的是 dict
- 断网：`RetryableError` 被抛出，且只重试了 `max_attempts` 次
- 429：同样重试，把 `time.sleep` 打桩后能看到等待时间递增
- 400 参数错：一次都不重试，直接抛给调用方

第三条和第五条要一起看。
一个是"该重试的重试了"，一个是"不该重试的没重试"。
少了任何一条，你的重试逻辑都只算写了一半。

`check.py` 那种"5 项全绿 = 过关"的形式，L03 可以照抄。
把上面五项写进去，你的命令行 agent 就有了一个不依赖网络的验收脚本。

最后是入口。
`.env.example` 里那三个变量，就是这里读的三个。

```python
import os
import sys

from agent import Message, run_agent
from tools import TOOLS


def main() -> int:
    model = OpenAICompatibleModel(
        model=os.environ["DEEPSEEK_MODEL"],
        api_key=os.environ["DEEPSEEK_API_KEY"],
        base_url=os.environ["DEEPSEEK_BASE_URL"],
        tool_schemas=TOOL_SCHEMAS,
    )
    messages = [Message("system", SYSTEM), Message("user", sys.argv[1])]
    try:
        print(run_agent(model, TOOLS, messages, max_steps=8))
    except ContextOverflowError:
        print("上下文超限：先裁剪历史（见 06 篇），重试没用")
        return 2
    except BadRequestError as exc:
        print(f"请求本身有问题，重试没用：{exc}")
        return 1
    except RetryableError as exc:
        print(f"网络或限流，重试已用尽：{exc}")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

三个 `except` 对应三种命运。
三种都用不同的退出码，因为线上你要靠退出码区分"用户的错"和"我们的错"。

日志也要分三种写。
400 那一条要把响应体原样打出来，因为它告诉你哪个字段错了。
429 那一条要记"第几次重试、等了多久"，不然你分不清是限流还是退避策略写坏了。
上下文超限那一条要记当时的 token 估算和消息条数，那是你下次裁剪历史的依据。

这三种日志格式不统一，出了事你还是要人肉翻。

这一篇的验收，到这里就闭环了。
一个能跑真模型的命令行 agent，五个不联网的测试，三个明确分类的异常。

再加一条 L01 的老朋友当回归：把 `max_steps` 从 10 调到 3 跑一遍，看保险丝会不会触发。
会触发，说明它在真模型下也真的在工作。

## 14. 小结

这一篇讲的是同一件事的十个侧面。

```text
arguments 是字符串            content 可能是 null
一轮可以多个 tool_calls        id 由服务端生成，原样带回
schema 必须随请求发            消息顺序硬校验
网络会抖，重试要分类           上下文有上限，超了不能硬重试
temperature=0 不保证确定性     输入输出分开计费

十个侧面，一个落点：
全部收敛进适配器，循环一行没动。
```

接真模型的正确姿势，不是"把假模型删掉换成 SDK 调用"。
是"加一层，让循环继续只看见 `Message`"。

假模型留着。
它现在是你的回归夹具，不再只是教学道具。

下一篇是这一系列的最后一篇。

它不再讲某个机制。
它讲怎么把前面 16 篇拼成一个能交给别人用的东西：场景怎么选，需求怎么映射到能力，十步按什么顺序走，每一步的验收标准是什么，上线前必须回答哪十个问题。

那一篇里会有一张清单。
清单的每一项，都能在这套 `labs/` 代码里找到对应的位置。
