---
title: "Agent 系统讲解 01：Agent、模型和消息契约"
date: 2026-11-09 10:05:00 +0800
permalink: /posts/agent-model-message-contract/
categories: [Agent, 系统讲解]
tags: [agent, llm, message, role, tool-call, tool-call-id, protocol]
description: "把 agent 拆成模型、循环、工具和消息四部分，逐字段拆解 Message 与 ToolCall，并解释消息顺序、tool_call_id 对账和四种角色的协议约束。"
---

<!-- series-nav -->
> **系列位置**：Agent 系统讲解，第 01 篇 / 共 18 篇
> **总目录**：[学习地图](./2026-11-09-00-agent-systematic-learning-map.md)
> **上一篇**：[00：从零建立 Agent 知识地图](./2026-11-09-00-agent-systematic-learning-map.md)
> **下一篇**：[02：token、上下文窗口和单轮预算](./2026-11-09-02-agent-token-context-window-budget.md)


一个 agent 跑不起来，十次里有八次不是模型笨。

是消息不对。

而且不对的地方往往很小：

```text
少了一个 tool_call_id
assistant 和 tool 的消息顺序反了
system 塞进了 user 里
工具结果写成了 assistant
```

假模型里这些都能跑。

真模型里，API 会直接甩你 400，或者更糟：不报错，但模型开始胡说。

这一篇只做一件事：

```text
把「一条消息」彻底拆开。
```

拆完之后你会发现，所谓 agent 开发，很大一部分就是在维护一个长得对的列表。

## 1. 先把三个词分开

日常说话，「模型」「Agent」「框架」经常混着用。

写代码的时候必须分开。

```text
模型（model）
    一个无状态的函数。
    输入 messages，输出一条 message。
    它不会执行代码，不会读文件，不认识你的数据库。

Agent
    模型 + 一个循环 + 一套工具 + 终止条件。
    它是一个程序，不是一个模型。

框架（framework）
    别人把上面那个循环、工具注册、重试、序列化
    打包成的一堆类。
```

三种东西的边界很清楚。

不清的后果是：

```text
agent 不调工具，你去换模型。
```

但问题根本不在模型。

模型只能做两件事：

```text
生成文本
按你给的 schema 生成一个"我要调工具"的结构
```

它不能做第二件事以外的任何动作。

「调用工具」这个说法其实是人类事后附会的。

模型没有调用任何东西。

它只是**输出了一段格式正确的 JSON**。

真正执行的是你的代码。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
observation = _execute(call, tools)
```

这一行，才是工具真正被执行的地方。

它跑在你自己的进程里，跑在模型之外。

**反直觉的点在这里：**

```text
Agent 的能力上限，不是模型的上限，
是你能安全地让它执行什么的上限。
```

模型再强，你的工具只有 `calculator`，它就只会算数。

## 2. 模型是无状态的

这句话值得单独一节。

因为它推翻了大多数人对「聊天」的直觉。

你在网页版里跟模型聊了半小时，它好像一直记得。

那是网页版在帮你做一件事：

```text
每一次请求，把整段历史重新发过去。
```

不是模型记住了。

是客户端每次都重发。

接口层面，模型完全无状态。

```text
第 1 次请求：你发 [A]
第 2 次请求：你发 [A, B]
第 3 次请求：你发 [A, B, C]
```

如果第 3 次你只发了 `[C]`，模型就只看得到 `[C]`。

它不知道 `A` 和 `B` 存在过。

这不是缺陷，是设计。

无状态意味着：

```text
可以水平扩容
可以重放
可以随时换一台机器
```

代价是：

```text
状态管理变成了你的责任。
```

所以后面你会反复看到这句话：

```text
所谓记忆，就是你往 messages 里塞了什么。
所谓遗忘，就是你这次没塞进去。
```

这一篇剩下的内容，都可以看成它的推论。

## 3. 一条消息有四个字段

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
@dataclass
class Message:
    role: str
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
```

就这四个字段。

看起来很少，但每个都有严格含义。

```text
role          这条消息是谁说的
content       说了什么
tool_calls    模型要求执行哪些工具（只有 assistant 用）
tool_call_id  这条工具结果对应哪次调用（只有 tool 用）
```

真实 API 的字段名略有不同，但形状是一样的。

代码来源：OpenAI Chat Completions 的 message 形状

```json
{"role": "assistant", "content": null, "tool_calls": [...]}
{"role": "tool", "tool_call_id": "call_a1b2c3", "content": "20"}
```

注意第一行：`content` 是 `null`，不是空字符串。

这是真模型和假模型的第一个差异。

后面 15 篇会专门讲。

现在先记住：

```text
一条消息 = 谁说的 + 说了什么 + 要不要调工具 + 对应哪次调用。
```

四个字段，四种角色，一张表就能说清。

## 4. 四种角色

`role` 只有四种合法值。

```text
system
user
assistant
tool
```

每一种都在协议里有一个明确的位置。

### 4.1 system：规则层

```python
Message("system", "你是一个会使用工具的中文助手。需要算数时调用 calculator 工具。")
```

代码来源：

```text
labs/L01_agent_loop/run.py
```

```python
SYSTEM = "你是一个会使用工具的中文助手。需要算数时调用 calculator 工具。"
```

`system` 消息不是「模型的性格」。

至少在工程上，它应该被当成：

```text
这个 agent 的岗位说明书。
```

里面放什么：

```text
它是谁
它能做什么
它不能做什么
输出格式要求
工具的使用约定
```

不放什么：

```text
用户的临时请求（那是 user）
工具的执行结果（那是 tool）
模型的回答（那是 assistant）
```

最常见的错误，是把 system 和 user 混在一起。

```python
# 错
messages = [Message("user", "你是助手。帮我算 1+1")]
```

这能跑。

但你会失去两个东西：

```text
1. 后面想改规则时，你找不到它藏在哪条 user 里了
2. 多轮之后，这条"规则"会被当成用户说过的一句话，被摘要、被裁剪
```

规则和请求，生命周期不一样。

规则应该一直存在，请求只存在一轮。

所以它们必须是不同的角色。

### 4.1.1 system 的寿命，和裁剪的关系

这一点在后面会变重要。

06 篇讲裁剪时会说：

```text
裁剪 history 时，system 永远保留。
```

为什么？

因为 system 是唯一一条**每轮都必须一模一样**的消息。

如果你把它当成一条普通消息，裁掉它，模型就失去了规则。

如果你每次重新生成它，就可能前后不一致。

所以正确的做法是：

```text
system 在 messages[0]，只写一次。
裁剪只动 [1:]。
```

代码来源：

```text
labs/L01_agent_loop/run.py
```

```python
messages = [
    Message("system", SYSTEM),
    Message("user", "帮我算一下 (12 + 8) * 3 等于多少？"),
]
```

index 0 是 system。

后面所有的 append，都排在它后面。

这个位置约定，比任何裁剪算法都重要。

### 4.1.2 system 里写什么，不写什么

一个能用的 system，通常只有三到五句。

```text
你是什么角色。
你有哪些工具，什么时候用。
你的输出格式。
你的硬边界（不能做什么）。
```

不写：

```text
几百字的"人设"
大量示例
整份文档
```

原因在 02 篇讲过：

```text
system 每轮都发，越贵越长。
而且长 system 会稀释注意力，让真正的规则变模糊。
```

一句话总结：

```text
system 是规矩，不是知识库。
知识库该去检索。
```

### 4.2 user：输入层

```python
Message("user", "帮我算一下 (12 + 8) * 3 等于多少？")
```

`user` 是「这一轮要处理的东西」。

它可以是：

```text
一句话
一段粘贴的报错
一份文档的内容
一个工具的执行结果（如果你不用 tool 角色）
```

最后一条要小心。

工具结果**必须**用 `tool` 角色。

原因在 4.4 节。

### 4.3 assistant：模型说过的话

这是唯一一条**由模型产生**的消息。

```python
Message("assistant", "结果是 60。")
```

它有两种形态。

第一种：纯文本回答。

```json
{"role": "assistant", "content": "结果是 60。"}
```

第二种：要求调工具。

```json
{"role": "assistant", "content": null, "tool_calls": [...]}
```

第二种里，`content` 经常是 `null`。

很多新手在这里写代码写错：

```python
answer = reply.content.strip()   # 如果 content 是 None，这里炸
```

必须写成：

```python
answer = (reply.content or "").strip()
```

还有一种混合形态：

```json
{"role": "assistant", "content": "我先算括号里的。", "tool_calls": [...]}
```

模型一边说话一边要求调工具。

协议允许。

你的循环必须能处理：

```text
有 content 也有 tool_calls → 仍然要执行工具
```

不能因为 `content` 不为空，就以为这是最终答案。

判断循环是否结束，永远只看一件事：

```text
tool_calls 是不是空的。
```

### 4.4 tool：观测结果

```python
Message(role="tool", content=observation, tool_call_id=call.id)
```

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
messages.append(
    Message(role="tool", content=observation, tool_call_id=call.id)
)
```

这条消息不是「用户说的」，也不是「模型说的」。

它是：

```text
系统对模型的一次请求的执行结果。
```

放在 `user` 里会怎样？

模型会把工具结果当成用户在跟它说话。

大多数时候它也能继续。

但你会失去三样东西：

```text
1. 对账能力（哪条结果对应哪次调用）
2. 可审计性（哪些内容是外部事实，哪些是用户主张）
3. 协议兼容性（真模型的 API 对 tool 消息有硬校验）
```

第三条最致命。

真模型会检查：

```text
每一条 role=tool 的消息，
前面必须有一条 assistant 消息，
里面有一个 tool_calls 项，id 与它相同。
```

对不上，400。

## 5. ToolCall 有三个字段

```python
@dataclass
class ToolCall:
    id: str
    name: str
    args: dict[str, Any]
```

三个字段，对应三件事。

```text
id     这次调用的唯一编号
name   要调哪个工具
args   参数
```

看起来简单。

但真实 API 里，`args` 不是一个对象。

它是一个**字符串**。

代码来源：OpenAI Chat Completions 的 tool_calls 项

```json
{
  "id": "call_a1b2c3",
  "type": "function",
  "function": {
    "name": "calculator",
    "arguments": "{\"expression\": \"12 + 8\"}"
  }
}
```

注意 `arguments` 的类型。

它长这样：

```text
"{\"expression\": \"12 + 8\"}"
```

是一段被转义过的 JSON 文本。

为什么？

因为模型生成的是 token 序列，不是对象。

它只能生成文本。

「结构化输出」是事后把它解析成对象的结果。

所以你的适配器必须做这一步：

```python
args = json.loads(call["function"]["arguments"])
```

这一步会失败。

模型可能生成：

```text
{"expression": "12 + 8"}          ← 合法
{"expression": 12 + 8}            ← 不合法，值不能是表达式
{"expression": "12 + 8"           ← 少了括号
expression: "12 + 8"              ← 不是 JSON
```

所以真实代码里，这一步一定要兜住：

```python
try:
    args = json.loads(raw_arguments)
except json.JSONDecodeError as exc:
    observation = f"错误：参数不是合法 JSON（{exc}）。请重新生成，只输出 JSON。"
```

假模型不需要这层。

因为 `tool_call()` 直接给你一个 dict。

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

`args=args`，直接是 dict。

**这是 L01 教学里最大的一个"善意的谎言"。**

它让你专心学循环。

代价是你接真模型时会漏掉 `json.loads`。

15 篇会把这一层补上。

现在只需要记住：

```text
假模型给你的 args 是 dict。
真模型给你的 arguments 是字符串。
```

这两个东西中间隔着一个 `json.loads`。

## 6. tool_call_id 到底在给谁对账

`id` 看起来是个无意义的随机串。

```text
call_a1b2c3
```

它其实解决一个很具体的问题：

```text
一轮里模型可能同时要调三个工具。
```

代码来源：

```text
labs/L01_agent_loop/check.py
```

```python
parallel = Message(role="assistant", content="", tool_calls=[
    ToolCall(id="c1", name="calculator", args={"expression": "1+1"}),
    ToolCall(id="c2", name="calculator", args={"expression": "2+2"}),
])
```

一轮两个调用。

执行完，你要往历史里塞两条结果。

```text
c1 的结果是 2
c2 的结果是 4
```

如果两条结果都没有 id：

```text
[assistant: 我要调 c1 和 c2]
[tool: 2]
[tool: 4]
```

模型只能猜：

```text
2 是 c1 的还是 c2 的？
```

简单的例子里，顺序能猜对。

复杂例子里会出错：

```text
c1 执行了 30 秒，c2 执行了 1 秒。
如果你并发执行并按完成顺序 append，
历史里就是 [tool: 4, tool: 2]。
模型看到 4 在前面，很可能认为 4 是 c1 的结果。
```

有了 id：

```text
[tool: 2, tool_call_id=c1]
[tool: 4, tool_call_id=c2]
```

顺序可以乱，对账不会乱。

`check.py` 的 C 项测的就是这个：

```python
assert {m.tool_call_id for m in tool_msgs} == {"c1", "c2"}, \
    "工具结果必须用 tool_call_id 对应回各自的请求"
```

注意它比的是**集合**。

不是列表。

顺序不重要，id 必须齐。

**这是本系列第一个可以拿去面试的细节。**

## 7. 消息顺序是硬约束

协议里有一条顺序规则，比所有规则都硬：

```text
assistant(带 tool_calls)
    ↓ 必须紧跟
tool(带对应 tool_call_id) × N
```

中间不能插别的。

不能插 user。

不能插 system。

不能先塞 tool 再塞 assistant。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
# 2. 先把模型的这句话记进历史（顺序不能反：工具结果必须排在它后面）
messages.append(reply)
```

这一行必须在执行工具之前。

为什么？

因为 `tool` 消息的合法性，依赖于**它前面已经存在**那条 assistant 消息。

执行工具可能要 10 秒。

如果你先执行、后 append：

```python
observation = _execute(call, tools)     # 先做
messages.append(reply)                  # 后记
messages.append(Message("tool", ...))   # 再记结果
```

顺序上还是对的（assistant 在 tool 前面）。

但你会丢掉一个更重要的东西：

```text
如果工具执行时程序崩了，历史里没有那条 assistant。
```

你就无法复现"模型当时要求了什么"。

更常见的错误是完全搞反：

```python
messages.append(Message("tool", ...))   # 先记结果
messages.append(reply)                  # 后记模型的话
```

这个顺序，假模型照样跑。

`ScriptedModel` 根本不检查历史顺序。

代码来源：

```text
labs/L01_agent_loop/fake_llm.py
```

```python
def chat(self, messages: list[Message]) -> Message:
    ...
    return item(messages) if callable(item) else item
```

它连 `messages` 都很少看。

所以这是一个**教学陷阱**：

```text
假模型不会因为你顺序错而报错。
真模型会。
```

15 篇接真模型时，这一条会是第一个炸的地方。

现在就把习惯养对：

```text
先记模型说的话。
再执行。
再记执行结果。
```

## 8. 一轮完整的时间线

把上面所有东西串起来。

用户问：

```text
帮我算一下 (12 + 8) * 3 等于多少？
```

第 1 轮请求，你发出去的历史是：

```text
[0] system     你是一个会使用工具的中文助手……
[1] user       帮我算一下 (12 + 8) * 3 等于多少？
```

模型回：

```text
[2] assistant  tool_calls=[{id: s1_a, name: calculator, args: {expression: "12 + 8"}}]
```

你执行 `calculator("12 + 8")`，得到 `20`。

回填：

```text
[3] tool       content="20", tool_call_id=s1_a
```

第 2 轮请求，你发出去的是 4 条：

```text
[0] system
[1] user
[2] assistant(tool_calls)
[3] tool
```

模型看到 `20`，决定再乘 3：

```text
[4] assistant  tool_calls=[{id: s1_b, name: calculator, args: {expression: "20 * 3"}}]
```

你执行，得到 `60`。

回填：

```text
[5] tool       content="60", tool_call_id=s1_b
```

第 3 轮请求，你发出去 6 条。

模型回：

```text
[6] assistant  结果是 60。
```

`tool_calls` 为空。

循环结束。

### 8.1 这 6 条在线上长什么样

上面是内部结构。

真正发出去的 HTTP body，大概是这样。

代码来源：OpenAI Chat Completions 的请求形状

```json
{
  "model": "<你的模型名>",
  "messages": [
    {"role": "system", "content": "你是一个会使用工具的中文助手。需要算数时调用 calculator 工具。"},
    {"role": "user", "content": "帮我算一下 (12 + 8) * 3 等于多少？"},
    {"role": "assistant", "content": null, "tool_calls": [
      {"id": "s1_a", "type": "function",
       "function": {"name": "calculator", "arguments": "{\"expression\": \"12 + 8\"}"}}
    ]},
    {"role": "tool", "tool_call_id": "s1_a", "content": "20"},
    {"role": "assistant", "content": null, "tool_calls": [
      {"id": "s1_b", "type": "function",
       "function": {"name": "calculator", "arguments": "{\"expression\": \"20 * 3\"}"}}
    ]},
    {"role": "tool", "tool_call_id": "s1_b", "content": "60"}
  ],
  "tools": [
    {"type": "function", "function": {
      "name": "calculator",
      "description": "计算一个四则运算表达式。",
      "parameters": {"type": "object",
        "properties": {"expression": {"type": "string"}},
        "required": ["expression"]}
    }}
  ]
}
```

对照着看，你会发现三件事。

第一件：内部结构里的 `args` 是对象，这里变成了 `arguments` 字符串。

```text
内部：args={"expression": "12 + 8"}
线上：arguments="{\"expression\": \"12 + 8\"}"
```

这就是 15 篇要补的那个 `json.loads`。

第二件：`tools` 是**每次请求都要发**的。

假模型不看它。

真模型靠它决定"能不能调这个工具"。

不发，或者发错了，模型就只会聊天。

第三件：`id` 是你自己造的（`s1_a`），还是服务端给的，取决于模型。

OpenAI 兼容接口里，`id` 由服务端生成。

假模型里，`fake_llm.tool_call()` 用哈希造一个。

两者都行。

**只要保证"结果里的 tool_call_id == 请求里的 id"**。

### 8.2 同一轮请求的 token 账

把 8.1 那段按 02 篇的粗估法算一下。

```text
system        31 字        ≈ 40
user          28 字        ≈ 30
assistant 1   JSON 片段    ≈ 70
tool 1        "20"         ≈ 5
assistant 2   JSON 片段    ≈ 70
tool 2        "60"         ≈ 5
tools schema  一个工具      ≈ 150
────────────────────────────────
输入小计                    ≈ 370
输出（最终回答）             ≈ 10
────────────────────────────────
总计                        ≈ 380
```

很小。

但这是"工具返回两个数字"的情况。

把 `tool` 的内容换成一段 2000 字的文档，这个账立刻变成 3,000+。

所以 02 篇说：

```text
上下文的敌人不是对话，是观测。
```

代码来源：

```text
labs/L01_agent_loop/run.py
```

```python
answer = run_agent(ScriptedModel(script), TOOLS, messages, max_steps=10)
print(f">> 历史里现在有 {len(messages)} 条消息：", [m.role for m in messages])
```

跑出来会打印：

```text
["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]
```

7 条。

每一次循环，历史增长 2 条：

```text
+ assistant
+ tool
```

这个增长规律很重要。

它意味着：

```text
步数越多，历史越长。
历史越长，token 越多。
token 越多，越可能超限，也越贵。
```

02 篇会把这个增长变成一个可以算的数字。

## 9. 历史就是状态

这句话是整个系列的地基之一。

在 agent 里，没有隐藏的变量记录「现在做到哪了」。

没有全局状态。

没有数据库。

只有：

```text
messages 这个列表。
```

你把它存下来，就能重放。

你把它丢了，就什么都不知道。

所以工程上，`messages` 的定位不是「对话记录」。

它是：

```text
这个 agent 的全部可恢复状态。
```

推论一：

```text
不要随便改历史里已经存在的消息。
```

推论二：

```text
如果需要记录"做到第几步了"，
要么放进 messages（作为一条消息），
要么放进一个工具能读写的文件。
```

推论三：

```text
线上出问题时，最该保存的就是完整 messages。
```

14 篇讲可观测性，第一件事就是存它。

### 9.1 把历史存下来，会遇到三个坑

「存 messages」听起来像 `json.dump`。

真写的时候有三个坑。

**坑一：`Message` 不是天然可序列化的。**

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
@dataclass
class Message:
    role: str
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
```

`tool_calls` 里装的是 `ToolCall` 对象。

`json.dump` 不认识它，会抛：

```text
TypeError: Object of type ToolCall is not JSON serializable
```

所以要手写两个方向：

```python
def to_dict(m: Message) -> dict:
    return {
        "role": m.role,
        "content": m.content,
        "tool_calls": [
            {"id": c.id, "name": c.name, "args": c.args} for c in m.tool_calls
        ],
        "tool_call_id": m.tool_call_id,
    }


def from_dict(d: dict) -> Message:
    return Message(
        role=d["role"],
        content=d.get("content") or "",
        tool_calls=[ToolCall(**c) for c in d.get("tool_calls", [])],
        tool_call_id=d.get("tool_call_id"),
    )
```

**坑二：`None` 和 `""` 会互相污染。**

真模型的 `content` 可能是 `null`。

你的 dataclass 默认是 `""`。

存下来再读回来，两种都可能是 `""`。

而协议上，`assistant` 带 `tool_calls` 时 `content` 应该是 `null`。

所以 `from_dict` 里要保留 `None` 的语义：

```python
content=d.get("content")      # 不要 or ""
```

下一轮发给真模型之前，再按供应商要求把 `""` 归一化成 `null`。

**坑三：存档不等于可重放。**

你存了 messages，但没存：

```text
当时的 system（可能被你改了）
当时的工具 schema（可能你加了工具）
当时的 model 名和 temperature
```

重放时这三样任何一个不同，结果就可能不同。

所以存档的最小单位不是 messages，是：

```text
messages + system + tools 快照 + 模型参数
```

少一样，你复现的就不是当时那次。

## 10. 四种结局，对应四种消息形状

代码来源：

```text
labs/L01_agent_loop/run.py
```

`run.py` 演示了三种结局。加上正常的最终回答，一共四种。

### 结局 1：正常完成

```text
assistant(tool_calls) → tool → assistant(最终回答)
```

历史结尾是一条**没有 tool_calls** 的 assistant。

### 结局 2：工具报错后自愈

```text
assistant(tool_calls) → tool(错误文本) → assistant(tool_calls) → tool → assistant
```

注意：错误不是异常。

错误也是 `tool` 消息。

```text
[tool] content="错误：ZeroDivisionError: division by zero"
```

模型看到它，下一轮换了个式子。

### 结局 3：撞上保险丝

```text
assistant(tool_calls) → tool → assistant(tool_calls) → tool → ...
（到 max_steps 强制停）
```

历史结尾是最后一条 `tool`。

没有最终的 assistant。

所以 `run_agent` 返回的是一个**字符串**，不是一条消息：

```python
return f"（达到最大步数 {max_steps}，强制停止）"
```

这个返回值和历史对不上。

这是有意的。

它提醒你：

```text
这次没有答案，只有一次强制停止。
```

### 结局 4：模型直接回答（不调工具）

```text
assistant(最终回答)
```

历史里只有 system + user + assistant。

流程最短。

这四种结局覆盖了 agent 循环的**全部出口**。

如果你写的循环还有第五种出口，先检查它是不是一个 bug。

## 11. 消息设计的五条规则

把上面的内容压成五条。

第一条：

```text
规则进 system，请求进 user。
```

第二条：

```text
模型说的话进 assistant，包括它要求调工具的那句话。
```

第三条：

```text
工具结果进 tool，并且必须带 tool_call_id。
```

第四条：

```text
assistant(带 tool_calls) 必须先于它的 tool 结果。
```

第五条：

```text
循环是否结束，只看 tool_calls 是否为空。
```

五条规则，能挡掉八成「接真模型就 400」的问题。

## 12. 常见错误

### 错误 1：把工具结果写成 user

```python
messages.append(Message("user", observation))
```

能跑。

但你会失去对账能力。

而且真模型可能把工具结果当成用户的新指令，行为变得很怪。

### 错误 2：用 content 判断循环结束

```python
if reply.content:
    return reply.content
```

错。

模型可能一边说「我先算一下」一边给 `tool_calls`。

这时 `content` 不为空，但你还没算。

正确判断：

```python
if not reply.tool_calls:
    return reply.content or ""
```

### 错误 3：漏掉 tool_call_id

```python
Message(role="tool", content=observation)
```

假模型能跑。

真模型 400。

### 错误 4：一轮多个调用，结果按完成顺序塞

并发执行时，完成顺序和请求顺序不一致。

必须按 id 对账，不能靠顺序。

### 错误 5：把 system 放在历史末尾

有些实现会把「最新的规则」append 到最后。

协议上，system 通常只在开头。

放末尾可能被忽略，也可能直接报错。

规则要改，就改开头那一条。

### 错误 6：历史无限增长

第 50 轮时，历史可能有几百条。

token 会爆。

06 篇专门讲怎么裁。

## 13. 读 agent 代码时怎么判断

看到一段 agent 代码，先找这五样东西。

```text
1. Message 的结构定义在哪？
2. role 有几种？有没有 tool？
3. assistant 消息里 content 为 null 时怎么处理？
4. tool 消息有没有带 tool_call_id？
5. 循环退出的判断条件是什么？
```

五样都能找到，这段代码的基本协议是对的。

找不到，或者第 4 条缺失，接真模型时一定会出问题。

再往下一层，问三个问题：

```text
谁负责把 arguments 字符串解析成对象？
工具报错时，错误去了哪里？
历史什么时候被裁剪，裁剪时会不会拆散 tool 调用对？
```

第三个问题最隐蔽。

裁剪逻辑如果无脑删「最老的 N 条」，很可能删掉 assistant 却留下 tool。

那么下一次请求就会 400。

## 14. 小结

这一篇讲的是 agent 最底层的协议：

```text
四个字段
四种角色
一个 tool_call_id
一条顺序规则
```

核心结论：

```text
模型是无状态的。
所以 agent 的全部状态，都在 messages 里。
```

四个字段各管一件事：

```text
role          谁说的
content       说了什么
tool_calls    要调什么
tool_call_id  对应哪次调用
```

一条消息最容易出错的地方，不是内容，是**关系**：

```text
assistant 和 tool 的先后
tool 和 tool_call_id 的对应
```

下一篇讲一个更物理的问题：

```text
Agent 系统讲解 02：token、上下文窗口和单轮预算
```

那一篇会回答：

```text
这一堆 messages，到底有多长？
上下文窗口到底是什么的上限？
为什么聊到第 20 轮会开始胡说？
为什么"多给点上下文"有时反而更差？
```

从下一篇开始，你写下的每一条消息，都能估出它值多少 token。
