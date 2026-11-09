---
title: "Agent 系统讲解 04：tool_calls、执行与观测回填"
date: 2026-11-09 10:20:00 +0800
permalink: /posts/agent-tool-call-loop/
categories: [Agent, 系统讲解]
tags: [agent, tool-calls, message-protocol, observation, agent-loop]
description: "把一轮工具调用拆成四步：拼 messages、模型回 tool_calls、你解析并执行、结果作为 role=tool 回填，并说清 append 顺序、tool_call_id 对账和 arguments 为什么是字符串。"
---

<!-- series-nav -->
> **系列位置**：Agent 系统讲解，第 04 篇 / 共 18 篇
> **总目录**：[学习地图](./2026-11-09-00-agent-systematic-learning-map.md)
> **上一篇**：[03：工具协议与 JSON Schema](./2026-11-09-03-agent-tool-protocol-json-schema.md)
> **下一篇**：[05：工具报错、自愈和刹车](./2026-11-09-05-agent-error-selfheal-fuse.md)


模型回了两条 `tool_calls`。

你打印出来，看到 id、name、arguments，参数看着都对。

甚至能感觉到它"想"了两件事。

于是你在日志里写：

```python
# 模型调用了两次计算器
```

错。

模型一次都没有调用。

它只是生成了两段文本。

真正把 `10 / 0` 交给 Python 去算的，是下面这行代码：

```python
observation = _execute(call, tools)
```

这一篇只做一件事：

```text
把"一轮工具调用"从模型开口到你回填结果，完整走一遍。
```

走完你会发现：

```text
模型负责"说"，你负责"做"。
中间那条缝，就是 agent 最容易出错的地方。
```

## 1. 一轮里有四条消息

先看一次完整回合结束后，`messages` 长什么样。

```text
[0] system       你是会使用工具的助手。
[1] user         帮我算一下 (12 + 8) * 3
[2] assistant    tool_calls: [calculator("12 + 8")]
[3] tool         tool_call_id=..., content="20"
[4] assistant    tool_calls: [calculator("20 * 3")]
[5] tool         tool_call_id=..., content="60"
[6] assistant    结果是 60。
```

七条消息，三种角色交替。

四种角色的分工是：

```text
system      规则：你是谁、能做什么、不能做什么
user        需求：用户说的话
assistant   模型说的话（可能是最终答案，也可能是工具请求）
tool        你执行完之后的观测结果
```

注意 `assistant` 有两种形态。

一种有 `content`，没有 `tool_calls`。

一种有 `tool_calls`，`content` 可能是空串，也可能是 `null`。

这两种形态，是同一种角色。

模型在"给答案"和"要工具"之间切换，靠的就是 `tool_calls` 这个字段有没有内容。

`tool` 只有一种形态。

它必须带 `tool_call_id`。

这个字段是它和 `assistant` 那条消息之间唯一的连接。

```text
assistant 说：我要调用 id=abc 的工具
tool       说：id=abc 的结果在这里
```

没有这个 id，两条消息就只是碰巧挨在一起的两段文本。

模型要工具的那一次请求，叫工具调用（tool call）。

工具执行完、回填给模型的那条结果，叫观测（observation）。

这一篇就是跟着这两样东西走一遍。

为什么 assistant 的 content 可以是空的？

因为一条消息的"内容"有两个来源。

```text
content    给用户看的自然语言
tool_calls 给程序看的结构化请求
```

模型在只要工具的时候，可以什么都不"说"。

它不需要寒暄。

它直接把请求放进 tool_calls。

所以你会看到：

```json
{"role": "assistant", "content": null, "tool_calls": []}
```

用户界面上，这一条通常不显示。

它只在历史里占位。

占位不是浪费。

它是协议的一部分。

七条消息里，`assistant` 出现了三次。

```text
两次带 tool_calls（请求）
一次不带（答案）
```

用户只看到了最后一条。

前六条是过程。

agent 的"思考过程"，本质上就是这些过程消息。

它们不进 UI，但必须进历史。

少一条，后面就接不上。

## 2. 最小代码：run_agent

把循环本体完整贴出来。

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
    for step in range(1, max_steps + 1):
        if verbose:
            print(f"\n── 第 {step} 步 ──")

        # 1. 把完整历史发给模型
        reply = model.chat(messages)

        # 2. 先把模型的这句话记进历史（顺序不能反：工具结果必须排在它后面）
        messages.append(reply)

        # 3a. 没有工具调用 → 这就是最终答案，循环结束
        if not reply.tool_calls:
            if verbose:
                print(f"  模型 → 最终回答：{reply.content}")
            return reply.content

        # 3b. 有工具调用 → 逐个执行，把结果塞回历史
        for call in reply.tool_calls:
            if verbose:
                print(f"  模型 → 调用 {call.name}({_fmt_args(call.args)})")

            observation = _execute(call, tools)

            if verbose:
                print(f"  工具 ← {observation}")

            messages.append(
                Message(role="tool", content=observation, tool_call_id=call.id)
            )

    # 4. 保险丝：模型一直不肯收尾时强制停止，否则它会烧你的钱
    if verbose:
        print(f"\n** 达到最大步数 {max_steps}，强制停止 **")
    return f"（达到最大步数 {max_steps}，强制停止）"
```

一行一行看。

```text
def run_agent(...)          入口：模型、工具表、历史、步数上限
for step in range(...)      循环，步数是有限的
reply = model.chat(messages) 把整个历史发出去，拿回一条消息
messages.append(reply)       先记下模型这句话
if not reply.tool_calls      判断：这是答案还是工具请求
return reply.content         是答案，直接结束
for call in reply.tool_calls 是请求，逐个处理
observation = _execute(...)  执行，拿到字符串
messages.append(tool ...)    回填观测，挂上 id
```

十二行核心逻辑。

没有一行在"理解"模型。

每一行都在搬运数据。

这很关键。

agent 的复杂度不在算法。

在顺序、类型和对账。

参数为什么这么设计？

```text
model 只要一个 chat(messages) 方法
  —— 模型唯一的能力就是"给历史，回一条"

tools 是 dict
  —— 模型给的是名字，名字到函数就是查表

messages 是可变列表，函数直接改它
  —— 循环的产物就是"更长的历史"，返回新列表反而容易丢
```

`max_steps` 有默认值，`verbose` 也有。

前三个参数没有。

意思是：

```text
模型、工具、历史，缺一不可。
步数和日志，可以不管。
```

返回 `str`，不是 `Message`。

因为调用方要的是"最终答案"，不是"最后一条消息"。

这些都和 01 篇的消息契约对得上。

`max_steps=10` 这个默认值不是随便定的。

太少，复杂任务跑不完。

太多，一个死循环能烧掉很多 token。

10 是一个"大多数任务够用，出事也能兜住"的数。

真实项目里，这个值应该按任务类型调。

```text
单轮问答：3 到 5
多步工具任务：10 到 20
长流程：单独设预算，不只靠步数
```

具体数字不重要。

重要的是它必须存在。

还有 `verbose`。

它不是装饰。

它把每一步的"模型说了什么、工具回了什么"打印出来。

第一次跑循环，你应该全程开着它。

因为你要亲眼看见那七条消息是怎么长出来的。

关掉 verbose 的人，debug 时只能猜。

## 3. 四步生命周期

把上面十二行压成四步。

```text
① 拼 messages
     把 system、历史、上一轮的观测，一起发出去

② 模型回 tool_calls
     它只回"意图"，不执行任何东西

③ 你解析并执行
     查注册表、解析参数、调函数、兜异常

④ 观测回填
     造一条 role="tool" 的消息，带上 tool_call_id
```

然后回到 ①。

```text
        ┌──────────────────────┐
        │      messages        │◄──────────────┐
        └──────────┬───────────┘               │
                   │ ① 整个发出去               │
                   ▼                           │
            ┌─────────────┐                    │
            │    模型      │                    │
            └──────┬──────┘                    │
                   │ ② 只回 tool_calls          │
                   ▼                           │
            ┌─────────────┐                    │
            │  _execute   │  ③ 你执行           │
            └──────┬──────┘                    │
                   │ ④ 字符串观测               │
                   ▼                           │
            ┌─────────────┐                    │
            │ role="tool" │────────────────────┘
            └─────────────┘
```

四个步骤里，只有 ② 是模型做的。

①③④ 都是你的代码。

所以"agent 不听话"这句话，先要拆开问：

```text
是 ② 说错了？
还是 ① 给的历史不对？
还是 ③ 执行错了？
还是 ④ 回填错了？
```

大部分情况是 ① 或 ④。

因为 ② 你改不了。

你只能改它看到的东西。

再看一眼 ② 的两种输出。

```text
没有 tool_calls  -> 这是终点，return
有 tool_calls    -> 这是中途，继续
```

注意判断的顺序。

先 append，再判断。

不是先判断，再 append。

如果先判断"没有 tool_calls 就 return"，那就漏了 append。

历史里就少一条最终回答。

下一轮（如果有）模型就看不到自己刚才说了什么。

所以代码里是：

```python
reply = model.chat(messages)
messages.append(reply)
if not reply.tool_calls:
    return reply.content
```

append 在判断之前。

这个顺序和"append 在执行之前"是同一个道理：

```text
先把发生的事记下来，再做决定。
```

有一件事在 `run_agent` 里是隐式的：① 的"拼"。

在这个教学版里，`messages` 是一个列表，直接传进去就行。

真实 API 里，你要做三件事：

```text
把 Message 对象序列化成 dict
把 tools 的 schema 一起放进请求体
控制这一轮到底发多少历史（上下文预算）
```

第一件是翻译，第二件是协议，第三件是 06 篇要讲的上下文工程。

这里先记住：

```text
模型看到的 messages，和你内存里的 messages，不一定一样。
```

你内存里有十轮，请求体里可能只剩三轮。

对账的时候，看请求体，不看内存。

这也是"上下文工程"的起点。

模型看到什么，取决于你发什么。

不是取决于你存了什么。

06 篇会讲怎么决定"发什么"。

这里先记住这个区别。

## 4. 场景 1：七条消息是怎么长出来的

`run.py` 的场景 1 值得逐幕看（下面是关键几行）。

代码来源：

```text
labs/L01_agent_loop/run.py
```

```python
messages = [
    Message("system", SYSTEM),
    Message("user", "帮我算一下 (12 + 8) * 3 等于多少？"),
]

script = [
    # 第 1 幕：模型先算括号
    tool_call("calculator", call_id="s1_a", expression="12 + 8"),
    # 第 2 幕：模型看到 20 之后，再乘 3
    tool_call("calculator", call_id="s1_b", expression="20 * 3"),
    # 第 3 幕：模型拿到了 60，给最终回答
    lambda msgs: Message("assistant", f"结果是 {last_tool_result(msgs)}。"),
]

answer = run_agent(ScriptedModel(script), TOOLS, messages, max_steps=10)
print(f"\n>> 最终回答：{answer}")
print(f">> 历史里现在有 {len(messages)} 条消息：", [m.role for m in messages])
```

跑完，`run.py` 打印：

```text
>> 历史里现在有 7 条消息： ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']
```

七条，怎么来的？

第一幕。

```text
发出去：  system, user                          （2 条）
模型回：  assistant(tool_calls=[s1_a])          （第 3 条）
执行：    calculator("12 + 8") -> "20"
回填：    tool(tool_call_id=s1_a, "20")         （第 4 条）
```

第二幕。

```text
发出去：  前 4 条
模型回：  assistant(tool_calls=[s1_b])          （第 5 条）
执行：    calculator("20 * 3") -> "60"
回填：    tool(tool_call_id=s1_b, "60")         （第 6 条）
```

第三幕。

```text
发出去：  前 6 条
模型回：  assistant("结果是 60。")              （第 7 条）
没有 tool_calls，返回
```

三个观察。

第一，模型第二幕写的是 `"20 * 3"`，不是 `"(12 + 8) * 3"`。

它把任务拆成了两步。

因为它第一幕只请求了括号里的部分。

这是模型自己的选择，不是你教的。

第二，每一幕模型看到的历史，都比上一幕多两条。

一条是它自己的 `assistant`。

一条是你的 `tool`。

第三，第二幕能写对，是因为它看见了 `"20"`。

没有那条观测，它只能猜。

这就是"观测回填"的全部意义：

```text
你不是在"保存日志"。
你是在给模型提供下一步推理的前提。
```

`run.py` 最后还打印了一行：

```text
>> 最终回答：结果是 60。
```

这个 60 不是模型算的。

是 `calculator` 算的。

模型只是把观测里的 `"60"` 抄进了回答。

这也是为什么工具返回值要短。

抄进回答的东西，会被用户看见。

返回一大段调试信息，最后就会出现在答案里。

## 5. 为什么 append(reply) 必须在执行工具之前

这是整篇最重要的一节。

先看错误写法。

```python
# 错误示范：先执行，后回填，最后才记模型的话
for call in reply.tool_calls:
    observation = _execute(call, tools)
    messages.append(
        Message(role="tool", content=observation, tool_call_id=call.id)
    )
messages.append(reply)      # 太晚了
```

跑假模型。

能跑。

`check.py` 甚至可能全绿。

因为假模型只做两件事：

```text
按顺序吐剧本
从 messages 里倒着找最后一条 tool 消息
```

它不检查顺序。

它也不检查 `tool_call_id` 对不对。

换成真模型。

第一次请求就 400。

大意是：

```text
messages with role "tool" must be a response to a preceding message with "tool_calls"
```

意思是：

```text
你这条 tool 消息，前面没有对应的 assistant tool_calls。
```

为什么协议要求这个顺序？

因为 `tool_calls` 和 `tool` 结果是一对多的父子关系。

```text
父：assistant 带着 tool_calls（可能一个，可能三个）
子：每个 tool_call 一条 tool 消息
```

子必须排在父后面。

否则解析器不知道这条结果属于谁。

Anthropic 的要求更直接：

```text
tool_result 必须放在紧跟着 tool_use 的那条 user 消息里。
```

中间夹一条别的，就报错。

两种 API，同一个道理：

```text
请求在前，结果在后。
```

所以 `messages.append(reply)` 必须在 `_execute` 之前。

不只是为了协议。

还有三个工程上的理由。

第一，崩溃时不丢证据。

如果 `_execute` 抛了没被兜住的异常，进程挂了。

append 在前，历史里至少留着"模型请求过什么"。

append 在后，历史里只剩一条孤零零的 tool 消息，或者什么都没有。

排查的时候，前者能复盘，后者只能猜。

第二，trace 的顺序才是真实顺序。

你要还原"模型说 → 你执行 → 观测回来"。

顺序反了，trace 就变成"你先做了，模型才说"，读起来像灵异事件。

第三，模型下一轮要看见自己的请求。

它看到 `messages` 里有一条 `assistant` 带着 `tool_calls`，才知道"我上一轮要过这个"。

看不到，它会以为工具结果是凭空出现的。

有些模型会因此重复调用同一个工具。

这就是 05 篇要讲的"重复调用"问题的一个来源。

把顺序写对，只要一行。

但这一行错了，本地全绿，上线全红。

这是整个 L01 里最典型的"假模型陷阱"。

怎么自证？

改一行，跑一遍。

把 `messages.append(reply)` 挪到 `for` 后面。

```python
for call in reply.tool_calls:
    ...
messages.append(reply)      # 故意放错
```

然后 `python check.py`。

大概率还是全绿。

因为假模型不检查顺序。

接着打印角色序列：

```python
print([m.role for m in messages])
```

你会看到：

```text
['system', 'user', 'tool', 'assistant', ...]
```

`tool` 跑到了 `assistant` 前面。

这就是错的形状。

真模型看到这个数组，会直接拒绝。

所以顺序这件事，不能靠测试发现。

得靠读代码发现。

读的时候只问一句：

```text
执行工具的那行，在 append(reply) 的上面还是下面？
```

在上面，就是错的。

这一行顺序，也解释了 00 篇那句话：

```text
assistant(带 tool_calls) 必须先存在，
后面那条 role="tool" 的结果才挂得上。
```

不是代码风格。

是协议。

## 6. tool_call_id：一张对账单

`id` 是模型（准确说是 API 服务端）生成的。

它是一串你看不懂的字符。

```text
call_a1b2c3
toolu_01ABC
```

你不需要看懂。

你只需要做一件事：

```text
原样抄回去。
```

抄到哪儿？

抄到 `tool` 消息的 `tool_call_id` 字段。

```python
Message(role="tool", content=observation, tool_call_id=call.id)
```

`call.id` 是模型给的。

`tool_call_id` 是你回的。

两个字符串必须完全相同。

差一个字符，就是对不上账。

对不上账会怎样？

```text
OpenAI：400，提示找不到对应的 tool_call
Anthropic：400，提示 tool_use_id 无效
```

有些实现不报错，但会把结果挂到错误的请求上。

那更麻烦。

模型会拿着 A 的结果，去回答 B 的问题。

对账的几条规则：

```text
一轮里每个 tool_call 都要有且只有一条 tool 消息
同一个 id 不能出现在两条 tool 消息里
id 不要自己编，除非你在写假模型
id 不要跨请求复用
```

最后一条要解释一下。

同一个 id 出现在两个不同的回合里，协议层面可能不报错。

但你的日志会乱。

你会看到两条 `id=abc` 的记录，分不清哪条是哪一轮。

所以日志里最好带上 `step`。

```text
step=2  assistant  tool_call id=call_a1b2c3
step=2  tool       id=call_a1b2c3  content="20"
```

这就是最小可用的 trace。

id 能不能自己生成？

写假模型时，可以。

`fake_llm.tool_call` 就是这么干的：

```python
call_id = call_id or f"call_{name}_{abs(hash((name, tuple(args.items())))) % 10000}"
```

它用参数哈希造一个稳定的 id。

同样的参数，同一个 id。

这让剧本可复现。

真模型不行。

因为 id 是服务端发给你、下一轮还要验证的。

你编一个，服务端认不出来。

所以规则是：

```text
假模型：可以编，方便复现
真模型：只能抄
```

`check.py` 里那个集合断言，就是这条规则的教学版：

```python
assert {m.tool_call_id for m in tool_msgs} == {"c1", "c2"}
```

它查的不是顺序。

是"两个请求，两个结果，一一对上"。

## 7. 一轮多个 tool_calls

模型可以在一轮里要多个工具。

代码来源：

```text
labs/L01_agent_loop/check.py
```

```python
parallel = Message(role="assistant", content="", tool_calls=[
    ToolCall(id="c1", name="calculator", args={"expression": "1+1"}),
    ToolCall(id="c2", name="calculator", args={"expression": "2+2"}),
])
model = ScriptedModel([parallel,
                       lambda m: Message("assistant", "两个都算完了")])
run_agent(model, t, msgs, max_steps=4, verbose=False)
tool_msgs = [m for m in msgs if m.role == "tool"]
assert len(tool_msgs) == 2, f"一轮 2 个调用应该产生 2 条工具消息，实际 {len(tool_msgs)} 条"
assert {m.tool_call_id for m in tool_msgs} == {"c1", "c2"}, \
    "工具结果必须用 tool_call_id 对应回各自的请求"
```

`run_agent` 怎么处理？

```python
for call in reply.tool_calls:
    ...
```

一个普通的 `for`。

所以两个调用会被串行执行。

先算 `1+1`，回填 `"2"`。

再算 `2+2`，回填 `"4"`。

历史里多出四条消息：

```text
assistant(tool_calls=[c1, c2])
tool(id=c1, content="2")
tool(id=c2, content="4")
```

然后下一轮，模型看到两条观测。

它可以继续调工具，也可以给答案。

这里有一个容易被忽略的点：

```text
两个 tool_call 是一条 assistant 消息里的两个元素，
不是两条 assistant 消息。
```

写成两条 assistant 消息会怎样？

协议上可能还能跑，但语义变了。

模型会以为"我上一轮说了一句话，这一轮又说了一句话"。

而且 provider 的并行工具调用统计会失真。

真实 API 里，模型一次回多个 tool_calls 是常态。

它一次想清楚了三件事，就一次说完。

你的循环要能接住。

接住的写法就是那个 `for`。

但 `for` 有两个隐含假设：

```text
假设一：每个调用都能独立执行
假设二：一个失败不影响另一个
```

第一个不一定成立。

第二个也不一定。

比如：

```text
call 1: 创建订单
call 2: 用 call 1 的订单号去支付
```

这两个不能并行。

它们有依赖。

假设模型真的这么发了。

你的 `for` 会按顺序执行。

先 `create_order`，返回 `"订单号 20261109001"`。

再 `pay_order`，参数里如果模型已经写死了订单号，那还好。

如果模型写的是 `"订单号"` 这种占位符，就失败。

所以"并行调用"不是"模型说并行就并行"。

你要判断依赖。

判断方法很土，但有效：

```text
call 2 的参数里，有没有 call 1 的返回值？
有，就是依赖。
没有，才可能真并行。
```

而"call 1 的返回值"在模型发请求的时候还不存在。

所以模型不可能在参数里真的引用它。

它只能猜，或者把两件事拆成两轮。

推论：

```text
同一轮里的多个调用，天然是"互不依赖"的。
```

如果模型把有依赖的事塞进同一轮，那说明它在猜。

猜出来的订单号，大概率是错的。

你的工具会报错，错误回填，它下一轮再改。

这就是为什么"错误要好读"。

而如果你闭着眼睛串行执行，顺序照样会错。

所以真实工程里，`for` 里通常还要加一层判断：

```text
这个调用依赖前面的结果吗？
依赖，就等前面完成再执行。
不依赖，才可以并发。
```

最简单也最稳的做法是：

```text
全部串行。
```

慢一点，但对。

等你真的需要压延迟，再把无依赖的调用并发出去。

还有第三种情况：部分失败。

```text
call 1 成功，call 2 报错。
```

这时候两条 tool 消息都要回填。

不能只回成功的。

因为协议要求每个 `tool_call` 都有响应。

少一条，下一轮 400。

所以 `for` 里不能 `break`，也不能 `continue` 跳过失败的那个。

失败也要造一条观测。

这条观测的内容，就是 05 篇的主题。

补充一个细节：顺序。

两条 tool 消息的顺序，最好和请求的顺序一致。

```text
tool(id=c1)
tool(id=c2)
```

协议靠 id 对账，顺序理论上无所谓。

但日志和 trace 会按顺序读。

你按请求顺序回填，人看日志时就不用跳来跳去。

如果并发执行，回来的顺序可能反了。

回填前按 `tool_calls` 的顺序排一次。

一行代码的事。

## 8. arguments 是字符串，不是对象

看真实 API 的响应。

代码来源：OpenAI Chat Completions 的 `tool_calls` 形状

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

`arguments` 的值是：

```text
"{\"expression\": \"12 + 8\"}"
```

一个字符串。

字符串里面才是 JSON。

所以你要解析两次。

```python
raw = call["function"]["arguments"]   # str
args = json.loads(raw)                # dict
```

第一次，把 HTTP 响应解析成 Python 对象。

第二次，把 `arguments` 这个字符串解析成参数字典。

很多人栽在第二次。

他们写：

```python
call["function"]["arguments"]["expression"]
```

然后得到：

```text
TypeError: string indices must be integers
```

为什么设计成字符串？

因为模型输出的是 token 流。

它生成的是文本。

服务端把这段文本塞进 `arguments`，而不是替你做解析。

好处是：流式输出时可以边生成边拼。

坏处是：解析失败的锅，归你。

provider 不替你解析，还有两个原因。

一是流式。

工具调用的参数是一个 token 一个 token 生成的。

中途拿到的是半截 JSON。

服务端要是边收边解析，必然失败。

二是容错。

模型可能吐出非法 JSON。

服务端如果替它"修"，修错了更麻烦。

把原始字符串给你，至少你能看见它到底写了什么。

所以 `arguments` 保持字符串，是一种"把不确定性交给你"的设计。

你不喜欢，但它是诚实的。

解析会怎么失败？

```text
JSON 不合法：模型多写了一个逗号，或者少了一个右括号
JSON 被截断：max_tokens 到了，字符串说到一半
不是对象：模型给了 "12" 或者 [1, 2]
空字符串：模型什么都没填
已经是对象：某些 SDK 帮你解析过了
```

最后一种最坑。

你按字符串处理，`json.loads(dict)` 直接抛 `TypeError`。

所以适配层要先判断类型。

教学片段（伪代码）：

```python
def parse_args(raw):
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("arguments 是空的")
    args = json.loads(raw)
    if not isinstance(args, dict):
        raise ValueError("arguments 不是一个 JSON 对象")
    return args
```

解析失败怎么办？

不要让它冒泡成崩溃。

把它变成观测：

```python
try:
    args = parse_args(raw)
except (json.JSONDecodeError, ValueError) as exc:
    observation = f"错误：参数解析失败（{exc}）。请只输出一个 JSON 对象。"
```

模型下一轮能看到这句话。

它有机会重发一次合法的参数。

这就是 05 篇的核心机制，这里先埋个伏笔。

还有一个副作用：日志里的转义。

`arguments` 在 HTTP 响应里是转义过的。

```text
"{\"expression\": \"12 + 8\"}"
```

你直接打到日志里，看到的是带反斜杠的一行。

排查的时候，先 `json.loads` 再打印，才看得清。

```python
print(json.loads(raw))
# {'expression': '12 + 8'}
```

否则你会盯着一堆 `\"` 怀疑人生。

现在回头看 L01。

`ToolCall.args` 的类型是：

```python
@dataclass
class ToolCall:
    """模型发出的「我要调用工具」请求。"""
    id: str                   # 这次调用的唯一编号，用来把结果对回请求
    name: str                 # 工具名
    args: dict[str, Any]      # 参数
```

已经是 `dict` 了。

因为 `fake_llm.tool_call` 用 `**args` 直接构造：

```python
def tool_call(name: str, call_id: str | None = None, **args) -> Message:
    ...
    return Message(
        role="assistant",
        content="",
        tool_calls=[ToolCall(id=call_id, name=name, args=args)],
    )
```

所以你写 `_execute` 的时候，直接 `tool(**call.args)` 就行。

整个 L01 里，你一次 `json.loads` 都不用写。

这不是巧合。

这是教学版故意抹平的差异。

它让你先专注在循环上。

代价是：你第一次接真模型，一定会在这里摔一跤。

**这就是 L01 假模型和真实世界最大的形状差异：**

**假模型给你 `dict`，真模型给你一段 JSON 字符串。**

**15 篇会专门讲怎么把这层差异补上。**

## 9. _execute 为什么永远返回字符串

看 `_execute` 的签名。

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
def _execute(call: ToolCall, tools: dict[str, Tool]) -> str:
    """执行一次工具调用，永远返回字符串，永远不抛异常。

    关键设计：工具出错时，错误信息本身就是给模型的观测结果。
    模型看到「错误：ZeroDivisionError: division by zero」，
    下一轮它就可以换个参数重试，或者向用户解释。
    如果你让它抛出去、整个程序崩了，agent 就没有「自我修复」的机会了。
    """
    tool = tools.get(call.name)
    if tool is None:
        return f"错误：没有名为 {call.name!r} 的工具。可用工具：{', '.join(tools)}"
    try:
        return str(tool(**call.args))
    except Exception as exc:                      # noqa: BLE001 —— 这里故意兜住所有异常
        return f"错误：{type(exc).__name__}: {exc}"
```

三个动作，一条出口。

```text
找不到工具 -> 返回错误字符串
执行成功   -> str() 转成字符串
执行抛异常 -> 返回错误字符串
```

为什么必须是字符串？

四个理由。

第一，协议要的是文本。

OpenAI 的 `tool` 消息，`content` 是字符串。

Anthropic 的 `tool_result`，`content` 可以是字符串，也可以是内容块数组。

两边都接受文本。

没有一边接受"一个 Python 对象"。

第二，模型读的是 token。

你回一个 `{"order_id": 123, "status": "paid"}` 的 dict，模型看到的是一串 token。

你回一个 `str(dict)` 的结果，模型看到的还是那串 token，只是多了单引号和 `True/False`。

后者更糟。

因为 Python 的 `repr` 不是 JSON。

```python
str({"ok": True, "n": None})
# "{'ok': True, 'n': None}"
```

模型见过很多 JSON，没见过很多 Python repr。

它会把 `True` 当成一个词，把 `None` 当成另一个词。

能猜。

但没必要让它猜。

第三，统一类型，循环就不用分支。

`_execute` 永远返回 `str`，所以：

```python
observation = _execute(call, tools)
messages.append(Message(role="tool", content=observation, tool_call_id=call.id))
```

这段代码不需要判断"这次是成功还是失败"。

成功和失败，都是字符串。

分支在模型那边。

第四，日志好打。

一行文本，直接进 trace。

不用序列化，不用格式化。

代价是什么？

代价是"信息被压平了"。

`str()` 会丢掉结构。

一个 `Order` 对象，`str()` 出来可能是：

```text
<Order object at 0x000001F2A3B4C5D0>
```

模型看到这个，什么也做不了。

所以工具函数不能偷懒。

它要自己返回一段给人看也给模型看的文本。

```python
return f"订单 {order.id}：状态 {order.status}，金额 {order.amount} 元"
```

而不是：

```python
return order
```

`str()` 只是兜底。

好的工具，根本不依赖它。

那能不能返回 JSON 字符串？

可以。

```python
import json
return json.dumps({"status": "paid", "amount": 199}, ensure_ascii=False)
```

好处：

```text
字段清晰
你的代码能直接解析
模型也能看懂
```

坏处：

```text
token 变多
模型可能只用到其中两个字段
```

取舍：

```text
字段少、机器要读 -> JSON 字符串
字段多、只给人看 -> 自然语言
```

不管哪种，都要在工具描述里写清字段含义。

否则模型看到 `{"status": "paid"}`，也不知道 `paid` 是"已付款"，还是"已支付但还没到账"。

还有一个细节：`None`。

```python
return None
```

`str(None)` 是 `"None"`。

模型会以为"None"是一个有效结果。

然后拿它去回答用户。

所以工具要么返回文本，要么返回明确的错误。

不要返回 `None`。

## 10. 模型看不见代码，它只看得见三样东西

这句话要展开。

模型看不见：

```text
你的 .py 文件
函数体
注册表这个字典本身
你捕获了什么异常
工具跑了多少毫秒
上一次调用是不是重试
```

它看得见：

```text
tools 里的 schema（名字、描述、参数）
messages 里的全部历史（包括每一条观测）
这一次的 user 消息
```

注意第一条的措辞。

是 schema，不是注册表。

schema 是注册表的一张照片。

照片上只拍了名字和参数。

函数体没拍到。

所以模型对"工具能做什么"的理解，完全来自这张照片。

你说 `calculator` 能算四则运算，它就认为能算四则运算。

你说它能算微积分，它也会信。

然后它填一个 `integrate(x^2, 0, 1)`，你的 `_safe_eval` 抛 `ValueError`。

它看到错误，才知道"哦，这个工具不会微积分"。

这就是为什么观测的措辞这么重要。

```text
你写"错误：ValueError: 不支持的表达式片段"
模型学到：这个工具不支持某些表达式
```

```text
你写"错误：bad input"
模型学到：不能这么填
```

后者信息量几乎为零。

它下一轮只能瞎猜。

这段对话还有一层含义。

`calculator` 的描述里如果写"支持四则运算"，模型就不会去试微积分。

它试了，说明它没读到，或者读到了没信。

两种情况的修法不同：

```text
没读到：描述太长，关键信息被淹没
没信：system 和描述冲突，或者描述里没写"不支持"
```

所以调 prompt 之前，先确认模型真的看见了你写的那句话。

怎么确认？

```text
把请求体打出来，数一数 tools 那段有多长。
```

如果描述藏在很长的 system prompt 后面，它很可能被忽略。

这不是模型不听话。

是信息位置不对。

还有一个时机问题。

schema 是"发出请求那一刻"的照片。

你在代码里改了函数签名，schema 没改。

照片就过期了。

模型按旧照片填参数。

你的函数按新签名收参数。

一调就炸。

所以 schema 最好和函数签名放在一起。

改一个，另一个必须跟着改。

做不到自动生成，就放在同一个文件的相邻位置。

让改的人看得见。

## 11. 反直觉：模型不是在"调用函数"

现在说这一篇最想让你记住的一句话。

**模型不是在调用函数。**

**它只是在生成一段符合 schema 的文本。**

**"调用"这个词，是人类事后附会的。**

把这句话拆开。

模型那边发生了什么：

```text
读 messages
读 tools 的 schema
预测下一个 token
一直预测到 stop
```

输出的是一段文本。

这段文本恰好长得像：

```json
{"name": "calculator", "arguments": "{\"expression\": \"12 + 8\"}"}
```

服务端把它解析成结构，塞进 `tool_calls`。

你的代码拿到结构，查表，执行。

整条链路上，模型没有"执行"任何东西。

它没有调用栈。

它没有返回值。

它没有异常。

它只是"说"了一句格式正确的话。

为什么这个区别重要？

因为它决定了你该怎么防错。

如果你以为模型在"调用函数"，你会假设：

```text
它会传对类型
它会传齐参数
它不会编不存在的函数
它不会重复调用
```

如果你知道模型在"生成文本"，你会假设：

```text
它可能编一个不存在的工具名
它可能少一个参数
它可能把数字写成字符串
它可能同一件事说两遍
它可能格式对、语义全错
```

后者才是真实情况。

具体一点，五个推论对应五种真实故障。

```text
推论一：它可能编工具名  -> 注册表要能返回"没有这个工具"
推论二：它可能少参数    -> 函数会 TypeError，要变成观测
推论三：它可能类型错    -> 校验要挡住
推论四：它可能不调用    -> 描述和 system 要提高触发率
推论五：它可能语义错    -> 只能靠工具自己检查
```

第五个最麻烦。

举个不涉及类型错误的例子。

用户问的是"12 占 8 的百分之多少"。

模型调：

```python
calculator(expression="12 / 8")
```

格式完全合法。

算出来是 `1.5`。

用户要的是 `150%`。

工具没错。

模型理解错了。

这种错误，注册表和校验都挡不住。

它只能靠两件事：

```text
工具描述里写清"返回的是商，不是百分比"
模型自己在答案里做换算
```

所以描述不只写"能做什么"，还要写"结果是什么形态"。

这是 03 篇那句话的另一种说法：

```text
返回什么，决定下一步怎么走。
```

所以你的代码要按"处理不可信输入"来写：

```text
校验参数
捕获异常
限制步数
记录每一次调用
```

这四件事，没有一件是"防模型笨"。

它们都是在处理"文本生成"的固有不确定性。

这四件事听起来像"防御性编程"。

其实不是。

它们是"分布式系统"的常规做法。

你把模型当成一个不可靠的外部服务。

它给的输入要校验，它的行为要限额，它的失败要记录。

这么想，很多设计就顺了。

这也是为什么 03 篇要花那么长讲描述。

描述不是文档。

描述是你唯一能影响那次"文本生成"的杠杆。

最后补一句。

"模型在调用函数"这个说法，以后还会一直用。

因为方便。

但你要知道它是一个比喻。

真实现是：

```text
模型生成文本
服务端解析文本
你执行代码
你把结果写回文本
```

四个动作，两次文本化。

理解了这一点，你看到任何 agent 框架的"tool use"，都不会被名字骗。

## 12. 回到真实工程：两家的回填形状

同一件事，两家写法不同。

### 11.1 OpenAI

请求里带：

```text
{"role": "assistant", "content": null, "tool_calls": [...]}
```

下一轮请求里带结果：

```json
{"role": "tool", "tool_call_id": "call_a1b2c3", "content": "20"}
```

要点：

```text
role 是 "tool"
用 tool_call_id 对账
content 是字符串
assistant 那条要原样带回，不能删
```

最后一条容易做错。

有人会想：

```text
工具都执行完了，assistant 那条还留着干嘛？
```

留着。

因为 tool 消息要挂在它后面。

删了，tool 消息就没有父节点。

下一轮 400。

而且模型需要看见自己上一轮请求了什么。

它看见 `calculator("12 + 8")`，才知道那个 `"20"` 是从哪来的。

删了，它只看到一条孤立的 `"20"`。

有些模型会重新调一次，确认这个 20 是不是真的。

还有一个细节：`content` 是 `null` 还是 `""`。

协议里 assistant 带 `tool_calls` 时，`content` 可以是 `null`。

但有些实现（包括某些兼容接口）不接受 `null`。

所以适配层里最好统一成空串：

```python
"content": m.content or ""
```

空串是所有实现都能接受的最小值。

### 11.2 Anthropic

模型回的是内容块：

```json
{
  "role": "assistant",
  "content": [
    {"type": "tool_use", "id": "toolu_01", "name": "calculator",
     "input": {"expression": "12 + 8"}}
  ],
  "stop_reason": "tool_use"
}
```

下一轮请求里带结果：

```json
{
  "role": "user",
  "content": [
    {"type": "tool_result", "tool_use_id": "toolu_01", "content": "20"}
  ]
}
```

要点：

```text
没有 role="tool"
结果放在 user 消息的 tool_result 块里
用 tool_use_id 对账
多个结果放进同一条 user 消息的多个块
```

两家的差异，正好印证了 01 篇那句话：

```text
"四种角色"是 OpenAI 形状的简化。
```

Anthropic 只有三种角色：user、assistant，加上 system 参数。

工具结果借用了 user 的位置。

所以你在设计内部数据结构时，最好别把 `role="tool"` 写死。

写成一个中间表示：

```text
ToolResult(call_id, content)
```

出口处再翻译成对方要的形状。

### 11.3 一个最小的适配层

教学片段（伪代码）：

```python
def to_openai_messages(msgs):
    out = []
    for m in msgs:
        if m.role == "tool":
            out.append({"role": "tool", "tool_call_id": m.tool_call_id,
                        "content": m.content})
        elif m.tool_calls:
            out.append({"role": "assistant", "content": m.content or None,
                        "tool_calls": [...]})
        else:
            out.append({"role": m.role, "content": m.content})
    return out
```

这段代码的重点不是写法。

是"顺序不能变"。

翻译的时候，最容易犯的错是：

```text
把 tool 消息挪到 assistant 前面
把 tool 消息合并成一条
把 assistant 的 tool_calls 删掉只留 content
```

三种都会 400。

翻译层怎么测？

不用接真模型。

用断言。

```python
body = to_openai_messages(msgs)
roles = [m["role"] for m in body]
assert roles == ["system", "user", "assistant", "tool", "assistant"]
for m in body:
    if m["role"] == "tool":
        assert m["tool_call_id"]
```

再加一条对账：

```python
ids = [c["id"] for m in body if m.get("tool_calls")
       for c in m["tool_calls"]]
tool_ids = [m["tool_call_id"] for m in body if m["role"] == "tool"]
assert set(ids) == set(tool_ids)
```

这两段能挡住大部分形状错误。

而且跑得很快。

不用等模型，不用花钱。

先把翻译层测对，再去接真模型。

顺序反了，你会分不清 400 是翻译层的问题，还是模型的问题。

适配层还有一件小事：参数名不要翻译。

有些人在适配层把 `query` 改成 `q`，觉得更短。

结果 schema 里写的是 `query`，函数签名收的是 `q`。

模型按 `query` 填，函数按 `q` 收。

炸。

适配层的职责是"换形状"，不是"换名字"。

名字从 schema 到函数，必须一模一样。

要短，就在源头改。

所以适配层写完，第一件事是打印请求体。

肉眼对一遍角色顺序。

## 13. 读代码时怎么判断

看到一段 agent 循环，按这七个问题过一遍。

```text
1. messages.append(reply) 在 _execute 之前还是之后？
2. 每个 tool_call 都生成了一条 tool 消息吗？
3. tool_call_id 是原样传的吗？
4. 一轮多个 tool_calls 是循环处理，还是只取第一个？
5. arguments 有没有解析？解析失败怎么处理？
6. _execute 的返回值永远是字符串吗？
7. 异常变成了观测，还是被抛出去了？
```

第 4 个问题最常见。

很多手写循环长这样：

```python
call = reply.tool_calls[0]
```

只处理第一个。

模型一轮要三个，你只做第一个，然后回填一条。

下一轮 400。

因为另外两个 `tool_call` 没有响应。

第 5 个问题也很常见。

假模型跑久了，人会忘记 `arguments` 是字符串这件事。

第 1 个问题最隐蔽。

因为顺序错了，假模型照样跑。

讲一个真实的 bug。

现象：

```text
本地跑得好好的。
上线之后，十次里有三次 400。
```

日志里只看得到：

```text
invalid_request_error
```

看不出哪条消息错了。

把请求体打出来，才发现：

```text
assistant(tool_calls=[a, b])
tool(id=a)
```

少了一条 `tool(id=b)`。

为什么少？

因为执行 `b` 的时候超时了。

代码里写的是：

```python
for call in reply.tool_calls:
    try:
        observation = _execute(call, tools)
    except TimeoutError:
        continue                    # 跳过这一条
    messages.append(Message(role="tool", content=observation, tool_call_id=call.id))
```

超时了，`continue` 跳过了回填。

于是 `b` 没有响应。

修法不是"加 try"。

是：

```text
超时也要造一条观测。
```

```python
try:
    observation = _execute(call, tools)
except TimeoutError:
    observation = f"错误：工具 {call.name} 超时，未返回结果。"
messages.append(Message(role="tool", content=observation, tool_call_id=call.id))
```

一条错误观测，救回一个 400。

这就是"每个 tool_call 都要有响应"的实际价值。

它不是协议洁癖。

它是线上成功率。

还有一个检查方法，比读代码快：

```text
在每一轮开始前，打印 messages 的骨架。
```

```python
for m in messages:
    print(m.role, m.tool_call_id, bool(m.tool_calls))
```

输出应该是：

```text
system None False
user None False
assistant None True
tool call_abc False
assistant None False
```

如果 `tool` 排在 `assistant` 前面，一眼就能看出来。

如果 `tool` 的 id 是 `None`，也一眼能看出来。

最后说一句日志。

一个工具调用，至少要记五个字段：

```text
step        第几步
tool_name   工具名
arguments   参数（解析后的）
observation 观测（截断到几百字）
duration_ms 耗时
```

有这五个，你就能回答：

```text
哪个工具最慢
哪个参数最常出错
哪一步开始跑偏
```

trace 的完整设计在 14 篇。

这里先把字段埋进去。

读一个陌生的 agent 框架，先找三个地方。

```text
它在哪一行调模型
它在哪一行执行工具
它在哪一行把结果塞回历史
```

三个位置找到，整个框架的骨架就清楚了。

剩下的都是装饰：回调、事件、流式、重试。

骨架不会变。

## 14. 小结：一轮就是四次搬运

这一篇讲完了一轮工具调用。

四步：

```text
① 拼 messages
② 模型回 tool_calls
③ 你解析并执行
④ 观测作为 role="tool" 回填
```

四条规则：

```text
assistant(tool_calls) 必须先入历史，再执行工具
每个 tool_call 都要有且只有一条 tool 消息
tool_call_id 原样抄回
_execute 永远返回字符串
```

一个形状差异：

```text
真模型的 arguments 是 JSON 字符串，假模型给你的是 dict。
```

一句反直觉的话：

```text
模型不是在调用函数，它只是在生成一段符合 schema 的文本。
```

下一篇讲这条链路上最容易崩的地方：

```text
Agent 系统讲解 05：工具报错、自愈和刹车
```

那一篇会回答：

```text
工具报错了，为什么不能抛异常？
错误信息怎么写，模型才用得上？
max_steps 为什么必须写在 for 里？
重试一个"下单"工具会发生什么？
什么错误该重试，什么错误重试也没用？
```

到那一篇，你才算真的把循环写稳了。

还有一个数字，这篇没展开。

```text
max_steps
```

它写在函数签名里，也写在 `for` 里。

为什么位置这么讲究，05 篇会讲。

因为它是保险丝（fuse）。

保险丝的位置错了，等于没有。
