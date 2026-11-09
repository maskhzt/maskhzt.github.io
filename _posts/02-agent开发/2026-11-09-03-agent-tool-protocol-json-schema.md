---
title: "Agent 系统讲解 03：工具协议与 JSON Schema"
date: 2026-11-09 10:10:00 +0800
permalink: /posts/agent-tool-protocol-json-schema/
categories: [Agent, 系统讲解]
tags: [agent, tool-calling, json-schema, prompt-engineering, function-calling]
description: "从模型看不见你的函数讲起，把工具说明书的四个要素、JSON Schema 的最小可用子集、OpenAI 与 Anthropic 的真实协议形状，以及工具描述为什么就是 prompt 工程一次说清。"
---

<!-- series-nav -->
> **系列位置**：Agent 系统讲解，第 03 篇 / 共 18 篇
> **总目录**：[学习地图](/posts/agent-systematic-learning-map/)
> **上一篇**：[02：token、上下文窗口和单轮预算](/posts/agent-token-context-window-budget/)
> **下一篇**：[04：tool_calls、执行与观测回填](/posts/agent-tool-call-loop/)


你写好了一个函数。

```python
def calculator(expression: str) -> str:
    """计算一个四则运算表达式。"""
```

注册进 `TOOLS`，跑起来。

模型回了一句：

```text
抱歉，我没法直接做数学运算，你可以自己用计算器算一下。
```

工具明明在那儿。

为什么它不调用？

因为模型看不见你的函数。

它没有你的文件系统。

它没有 `import`。

它甚至不知道 Python 是什么。

它看得见的，只有你发给它的那段 JSON：工具叫什么、干什么、要哪些参数。

那段 JSON 叫工具说明书。

写说明书这件事，看起来像填表。

其实是整个 agent 里最像"写作"的一环。

你多写一句"什么时候不该用它"，模型就少一次乱调。

你少写一句"参数是什么格式"，模型就多一轮重试。

这篇只做一件事：

```text
把工具说明书怎么写，讲到能照着写对。
```

## 1. 模型看不见你的函数

先把这句话说透。

```text
模型能看见的：
  system prompt
  messages 历史
  tools 里的 name / description / parameters

模型看不见的：
  你的 .py 文件
  函数体
  注释
  docstring
  类型注解
  异常类型
```

`calculator` 的函数体里有什么，模型完全不知道。

它不知道你用 `ast` 白名单而不是 `eval`。

它不知道除零会抛 `ZeroDivisionError`。

它不知道返回值是 `"60"` 还是 `60`。

它不知道这个函数会不会写数据库、会不会发请求。

它只知道你在 `description` 里写的那几个字。

所以同一份代码，配三份不同的说明书，会有三种完全不同的表现。

第一份：

```text
描述：计算器
参数：{"expr": {"type": "string"}}
```

结果：模型不敢调，或者调了填错 key。

第二份：

```text
描述：计算四则运算
参数：{"expression": {"type": "string"}}
```

结果：模型会调了，但偶尔把表达式写成 "12 * 8 = ?"。

第三份：

```text
描述：计算四则运算表达式，返回结果字符串，失败返回错误文本
参数：expression，类型 string，必填，说明里给了两个例子
```

结果：模型稳定地调，参数基本合法。

代码一行没变。

变的只有说明书。

所以工具能不能被正确调用，取决于一件很朴素的事：

```text
你把"这个工具是什么、什么时候用、参数怎么填"
写成了模型读得懂的文字和结构。
```

写不好，模型就不调。

调了，参数也是错的。

这不是模型笨。

这是说明书不合格。

而说明书是你写的。

## 2. 工具的四个要素

一个能用的工具定义，有四样东西。

少一样，就会出问题。

```text
名字        name         模型在 tool_calls 里回填的那个字符串
描述        description  模型判断"该不该用这个工具"的唯一依据
参数 schema parameters   模型填参数时的格式约束
返回什么    returns      模型看到观测结果后怎么继续
```

名字是协议的一部分。

模型发出的那个结构化请求，叫工具调用（tool call）。

它会在工具调用里原样吐出这个名字，你的注册表靠它找到函数。

名字写错一个字符，就是"没有这个工具"。

描述决定"用不用"。

参数 schema 决定"填得对不对"。

返回什么决定"下一步怎么走"。

前三样是必须写进 `tools` 字段的。

第四样没有独立字段，只能写进描述里。

```text
这个工具返回几行文字？
有没有单位？
是数字还是文本？
成功长什么样？
失败长什么样？
```

都要说。

因为模型是拿观测结果当下一步的输入。

观测（observation）就是工具执行完、回填给模型的那条结果。

它不知道 `"60"` 是六十，还是六十秒，还是六十块钱。

你得写。

举个真实会出事的例子。

```text
工具一：返回 "25.6"
工具二：返回 "25.6°C"
工具三：返回 "当前气温 25.6 摄氏度，体感 27.1 摄氏度"
```

第一个，模型只能猜。

第二个，模型知道单位，但不知道体感。

第三个，模型能直接拿来回答用户。

三个实现的计算量差不多。

差别全在"返回什么"这四个字上。

再补一句：返回什么，也决定了你后面怎么解析。

如果工具返回的是给模型看的文本，你就别指望代码再去 `json.loads` 它。

如果工具返回的是 JSON 字符串，那就要在描述里说清字段。

两头都要一致。

失败形态也要提前约定。

```text
成功：返回结果本身
失败：返回"错误：..."开头的文本，不要抛异常
空结果：返回"没有找到"，不要返回空字符串
```

为什么空字符串不行？

因为模型分不清"没找到"和"工具没跑"。

它会以为工具还没返回，再调一次。

约定好这三种形态，模型才知道下一步该干什么。

这对 `calculator` 也一样。

它成功返回 `"60"`，失败返回 `"错误：..."`。

模型看到前缀，就知道该不该重试。

## 3. 最小代码：一个工具和它的注册表

看这份代码。

代码来源：

```text
labs/L01_agent_loop/tools.py
```

```python
def calculator(expression: str) -> str:
    """计算一个四则运算表达式。例如 calculator("(12+8)*3") -> "60" """
    value = _safe_eval(ast.parse(expression, mode="eval"))
    return f"{value:g}" if isinstance(value, float) else str(value)


# 工具注册表：名字 -> 函数。模型输出的 name 就是靠这个字典映射到真实代码的。
TOOLS = {
    "calculator": calculator,
}
```

这段代码有三层。

第一层是函数本身：一个参数，一个字符串返回值。

第二层是 `TOOLS`：名字到函数的映射。

第三层是循环里的查找：

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
tool = tools.get(call.name)
if tool is None:
    return f"错误：没有名为 {call.name!r} 的工具。可用工具：{', '.join(tools)}"
```

模型给名字，字典给函数。

就这一行，把"模型生成的文本"变成了"你代码里的一个调用"。

为什么用字典，不用一串 `if name == ...`？

```text
字典是 O(1) 查找
新增工具只改一行
工具列表可以直接 join 出来给模型看
```

为什么不用装饰器自动注册？

可以，很多框架就是这么做的。

```python
@tool
def calculator(expression: str) -> str:
    ...
```

装饰器会把函数塞进一个全局表。

好处是不容易漏。

坏处是"注册了什么"变成了隐式的，读代码时要翻遍所有文件。

教学版用显式字典，就是让你一眼看见"模型能调的东西只有这些"。

这份代码里还有一样东西没写出来：schema。

因为它是教学版，假模型不需要 schema。

但真模型需要。

它要看到 `calculator` 接受什么参数、参数是什么类型，才敢填。

所以真实工程里，工具定义是两张表：

```text
注册表：name -> 函数          给执行用
schema：name -> 参数说明书     给模型看
```

两张表共用同一个名字。

名字对不上，就是"模型调了，你找不到"。

名字对上了、参数对不上，就是"找到了，一调就炸"。

最常见的翻车方式不是写错，是"只加了一半"。

```text
加了函数，忘了加 schema    -> 模型看不见，永远不调
加了 schema，忘了加函数    -> 模型调了，返回"没有这个工具"
两边都加了，名字不一样      -> 同上
```

所以每次加工具，都要过一遍这三个动作：

```text
写函数
写 schema
两边用同一个字符串
```

## 4. 给 calculator 写一份 schema

先把函数签名摆出来。

```python
def calculator(expression: str) -> str:
```

逐段翻译：

```text
函数名 calculator          -> "name": "calculator"
有一个参数 expression      -> properties 里有一项 expression
类型是 str                -> "type": "string"
没有默认值                 -> 必须出现在 required 里
返回值是 str              -> 写进 description："返回表示结果的字符串"
```

翻译完：

```json
{
  "name": "calculator",
  "description": "计算一个四则运算表达式的数值结果。当用户要求做加减乘除、乘方、取余，或需要精确算出某个算式的结果时使用。不要用它做单位换算、日期计算或符号推导。输入是纯算术表达式字符串，例如 \"(12+8)*3\"。返回结果字符串，例如 \"60\"；表达式非法时返回以「错误：」开头的文本。",
  "parameters": {
    "type": "object",
    "properties": {
      "expression": {
        "type": "string",
        "description": "要计算的表达式，例如 \"12 + 8\" 或 \"(12+8)*3\"。必须是纯算术表达式，不要带变量名、等号、单位或中文。"
      }
    },
    "required": ["expression"]
  }
}
```

这份 schema 和函数签名一一对应。

一个参数。

类型是 string。

必填。

多一个字段都没有。

这就是"从签名映射到 schema"的全部动作：

```text
看参数名        -> properties 的 key
看类型注解      -> "type"
看有没有默认值  -> 在不在 required 里
看约束          -> enum / minimum / maxLength
看语义          -> description
```

注意最后一行。

类型只能约束"是字符串"。

约束不了"这是不是一个算术表达式"。

那部分只能靠 description。

所以 schema 不是纯类型系统。

它一半是类型，一半是 prompt。

再看一个复杂一点的签名。

```python
def search_docs(query: str, top_k: int = 5,
                tags: list[str] | None = None) -> str:
```

逐段翻译：

```text
query   str，必填
top_k   int，有默认值 5，所以不填也行
tags    list[str] 或 None，可不填
```

写成 schema：

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "检索关键词，用自然语言短语，例如「退款流程」。"
    },
    "top_k": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20,
      "description": "返回多少条。不填时默认 5。"
    },
    "tags": {
      "type": "array",
      "items": {"type": "string"},
      "description": "按标签过滤，可省略。例如 [\"售后\", \"退款\"]。"
    }
  },
  "required": ["query"]
}
```

这里有三个值得注意的点。

第一，`top_k` 给了 `minimum` 和 `maximum`。

模型可能填 10000。

有了边界，至少能挡住一部分离谱值。

但边界不保证被执行，所以函数里还要夹一次。

第二，`tags` 用了 `array` + `items`，不是 `string`。

类型写错，模型会给你 `"售后,退款"` 这种字符串。

第三，`list[str] | None` 不要直接翻译成 `oneOf`。

工具 schema 里尽量少用组合类型。

写成"可选、不进 required"，然后在 `description` 里说"可不填"，就够了。

## 5. JSON Schema 的最小可用子集

JSON Schema 是一个很大的标准。

工具调用只需要其中很小一部分。

先记住这七个关键字：

```text
type
properties
required
description
enum
items
additionalProperties
```

### 5.1 type

```json
{"type": "string"}
```

常用取值：

```text
string
number
integer
boolean
array
object
null
```

`integer` 和 `number` 要分清。

`3.5` 是 number，不是 integer。

模型有时候会把 `3` 写成 `3.0`，或者反过来。

你的工具要做容错。

### 5.2 properties

对象类型的所有字段都写在这里。

工具参数的最外层，永远是一个 object。

所以 `parameters` 的第一行永远是 `"type": "object"`。

```json
{
  "type": "object",
  "properties": {
    "city": {"type": "string"},
    "unit": {"type": "string"}
  }
}
```

### 5.3 required

哪些字段必须有。

```json
"required": ["city"]
```

这是最容易被忘掉的一行。

忘了它，模型可能只给你一半参数。

你的函数一调用就 `TypeError`。

然后错误被回填，模型再猜一次。

本来一行 schema 能防住的事，变成了两轮 token。

### 5.4 description

每个字段都可以有。

```json
"city": {
  "type": "string",
  "description": "城市名，用中文或英文都行，例如「北京」或 \"Beijing\"。不要带国家名。"
}
```

字段级的 description 经常比工具级的更重要。

因为模型填错，往往错在"这个字段到底要什么格式"。

### 5.5 enum

取值有限的时候，用它把选项钉死。

```json
"unit": {
  "type": "string",
  "enum": ["celsius", "fahrenheit"],
  "description": "温度单位，只能是这两个之一。"
}
```

枚举比"在描述里说请填摄氏度或华氏度"可靠得多。

工程经验上，模型对枚举的遵守率通常更高。

因为它不用"理解"，只需要从几个选项里挑一个。

### 5.6 items

数组的元素类型。

```json
"tags": {
  "type": "array",
  "items": {"type": "string"}
}
```

数组一定要写 `items`。

不写，模型可能给你 `[1, "a", null]`。

### 5.7 additionalProperties

控制能不能多塞字段。

```json
"additionalProperties": false
```

有些供应商的严格模式要求这一项。

也有些供应商对它的处理比较宽松。

具体行为以你要用的模型文档为准。

工程上的建议是：

```text
能写就写。
写完自己还要校验一遍。
```

因为 schema 是给模型看的提示，不是运行时的铁门。

模型可能不守。

供应商可能不查。

最后兜底的，永远是你自己的校验代码。

### 5.8 一份完整的、带可选参数的 schema

把七个关键字凑一份真的。

```json
{
  "name": "get_weather",
  "description": "查询某个城市当前的天气。用户问气温、下不下雨、要不要带伞时使用。不用于历史天气，也不用于多天预报。",
  "parameters": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string",
        "description": "城市名，例如「杭州」或 \"Hangzhou\"。不要带国家名。"
      },
      "unit": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "description": "温度单位。不填时按摄氏度返回。"
      },
      "include_forecast": {
        "type": "boolean",
        "description": "是否附带未来 24 小时预报。不填时视为 false。"
      }
    },
    "required": ["city"]
  }
}
```

对应的函数：

```python
def get_weather(city: str, unit: str = "celsius",
                include_forecast: bool = False) -> str:
    ...
```

对照看：

```text
city             必填，进 required
unit             有默认值，不进 required，默认值写进 description
include_forecast 有默认值，不进 required，默认值写进 description
```

JSON Schema 里有 `default` 关键字。

但工具调用场景下，模型不保证看它、供应商不保证传它。

所以默认值要写两遍：

```text
一遍在 description 里，告诉模型"不填会怎样"
一遍在函数签名里，保证真的不填时也对
```

可选参数别太多。

每多一个可选参数，模型就多一次"这个要不要填"的决策。

三个以上，它就开始随机漏。

### 5.9 坏 schema 和好 schema 的对照

同一个工具，两种写法。

坏的：

```json
{
  "name": "search",
  "description": "搜索",
  "parameters": {
    "type": "object",
    "properties": {
      "q": {"type": "string"},
      "n": {"type": "number"},
      "t": {"type": "string"}
    }
  }
}
```

问题一堆：

```text
没有 required，三个参数都可能缺
q / n / t 是哪三个词的缩写？模型只能猜
n 是 number，但模型可能填 2.5
t 没有任何约束，模型可能填一段话
描述只有一个词，模型不知道搜什么、搜哪里
```

好的：

```json
{
  "name": "search_docs",
  "description": "在内部文档库里检索片段。当用户问产品用法、流程、政策，且答案可能写在文档里时使用。返回最相关的若干段原文，带出处；没有命中时返回「没有找到相关文档」。",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "检索词，用自然语言短语，例如「退款流程」。"
      },
      "top_k": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10,
        "description": "返回条数，1 到 10，默认 5。"
      }
    },
    "required": ["query"]
  }
}
```

差别不在格式。

在"读的人能不能一次看懂"。

### 5.10 schema 不能表达什么

这一点很重要。

schema 管得住形状，管不住业务。

它表达不了：

```text
"开始时间必须早于结束时间"
"金额不能超过用户余额"
"日期必须是未来七天"
"这个字段只在 status=paid 时才有意义"
```

硬塞也能塞（用 oneOf、if/then），但模型看不懂，供应商也不一定支持。

这些约束有两个正确的位置：

```text
位置一：工具实现里检查，返回带说明的错误观测
位置二：系统提示里用自然语言说明
```

位置一比位置二可靠。

因为工具实现是真的在跑，系统提示只是"建议"。

所以 schema 的定位要摆正：

```text
schema 负责"别把参数填成别的形状"。
业务规则负责"这个值合不合理"。
```

两件事分开做。

## 6. 工具描述就是 prompt 工程

很多人把 description 当注释写。

```text
计算器
```

三个字。

然后抱怨模型不调用。

模型看到的是：

```json
{"name": "calculator", "description": "计算器"}
```

它不知道这是算算术的，还是算房贷的，还是算 BMI 的。

它也不知道什么时候该用。

所以它选择不调用。

这是理性的。

**反直觉的点在这里：**

**工具描述不是写给人看的注释，是写给模型看的 prompt。**

**你在 description 里少写一句，模型就少一条决策依据。**

一份合格的 description，回答五个问题：

```text
这个工具做什么？
什么时候该用它？
什么时候不该用它？
参数怎么填？给个例子。
返回什么？成功和失败分别长什么样？
```

对照着改：

```json
{
  "name": "calculator",
  "description": "计算一个四则运算表达式的数值结果。当用户要求做加减乘除、乘方、取余，或需要精确算出某个算式的结果时使用。不要用它做单位换算、日期计算或符号推导。输入是纯算术表达式字符串，例如 \"(12+8)*3\"。返回结果字符串，例如 \"60\"；表达式非法时返回以「错误：」开头的文本。"
}
```

多了什么：

```text
正向触发条件：加减乘除、乘方、取余
负向边界：不做单位换算、日期、符号推导
输入样例
输出样例
失败形态
```

这五样，就是模型判断"用不用、怎么填、出错怎么办"的全部信息。

写描述的时候，可以假想你在给一个没见过这个系统的同事写交接文档。

他只能看这一段字。

看完要能正确使用。

写不出来，说明你自己也没想清楚这个工具的边界。

还有一条常被忽略：

```text
描述里不要写"请谨慎使用""仅供参考"这种话。
```

模型对这类话没有稳定的行为。

它要么忽略，要么过度保守，变成什么都不调。

要约束行为，用参数约束、用工具拆分、用系统提示。

别指望一句形容词。

再补两个工程细节。

第一，描述有 token 成本。

每个工具的描述，每一次请求都要重发。

工具有二十个，每个描述两百字，那就是四千字，每轮都付。

所以描述要"信息密度高"，不是"越长越好"。

```text
能一句话说清的，不要写三句。
重复的共性说明，放到 system 里写一次。
```

第二，描述里的例子会被模仿。

你写 `例如 "(12+8)*3"`，模型大概率就按这个格式填。

你写 `例如 "12加8乘以3"`，模型也会学着写中文算式。

例子是 few-shot。

给对的例子，等于给了半个模板。

算一笔账。

假设你有二十个工具。

每个工具的 name、description、parameters 加起来大约一百五十个中文字。

二十个就是三千字。

三千字大概是多少 token？

```text
中文大致一到两个汉字一个 token，看模型
三千字，粗估三四千 token
```

这三千字，每一轮请求都要重发一遍。

跑十轮，就是三四万 token 的重复开销。

所以你写描述的时候，要同时看两个指标：

```text
信息够不够模型做决策
字数会不会把预算吃掉
```

两个都重要。

压描述的办法不是删信息，是删重复。

```text
"这个工具用于查询……"
"这个工具用于查询……"
"这个工具用于查询……"
```

二十个工具都这么开头，这五个字就是纯浪费。

把共性挪到 system 提示里写一次：

```text
下面这些工具都只读，不会修改任何数据。
```

工具描述里就不用每个都写"只读"。

省下来的字，留给"什么时候不该用我"。

那句话才是真正影响选择的。

## 7. 工具名也是接口

名字看起来最不重要。

其实它参与了三件事。

```text
模型在 tool_calls 里回填它
你的注册表用它查函数
日志和 trace 用它做统计
```

所以名字要满足三条：

```text
动词或动词+名词，语义单一
小写下划线，不加版本号
和注册表的 key 完全一致
```

好的：

```text
calculator
search_docs
read_file
create_ticket
get_weather
```

坏的：

```text
tool1
helper
do_stuff
calc_v2_final
Calculator
```

最后那个大小写最容易出事。

模型回 `"Calculator"`，你的字典里是 `"calculator"`，`dict.get` 返回 `None`。

然后你得到一条观测：

```text
错误：没有名为 'Calculator' 的工具。可用工具：calculator
```

这条错误还算友好。

但这一轮已经白烧了。

名字里也别塞参数。

```text
get_weather_by_city_and_unit    <- 别这样
get_weather                     <- 这样
```

参数是 schema 的事。

名字只负责"这是什么能力"。

还有两种命名要避开。

第一种，把实现细节写进名字。

```text
query_mysql_users
call_internal_api_v2
```

模型不关心你用什么数据库。

它只关心"这是查用户"。

实现细节占 token，还会在你换实现时变成谎言。

第二种，名字里带副作用强度。

```text
delete_everything
```

这种名字会让模型过度谨慎，或者在描述不清时误用。

破坏性工具应该靠权限、确认和幂等来管，不是靠名字吓唬。

如果工具确实很多，可以用前缀分组。

```text
db_query
db_write
```

前缀能帮模型快速建立分类。

但前缀别超过四五个字符。

太长就变成噪音。

还有一种命名冲突，出现在工具变多之后。

```text
get_user
get_user_profile
get_user_settings
```

三个名字都对。

但模型要在三个里面选。

描述如果只差几个字，它就会选错。

改法不是加长名字，是加"边界"。

```text
get_user           "查基本信息"
get_user_settings  "查通知、语言、时区设置"
```

边界写清，名字不用改。

## 8. 真实 API 的形状：两家不一样

到这里，schema 的内容你已经会写了。

接下来是"往哪儿放"。

两家主流 API 的放法不同。

### 8.1 OpenAI 的形状

```json
{
  "model": "...",
  "messages": [],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "calculator",
        "description": "计算一个四则运算表达式。",
        "parameters": {
          "type": "object",
          "properties": {
            "expression": {"type": "string"}
          },
          "required": ["expression"]
        }
      }
    }
  ]
}
```

三层：

```text
tools[]            工具数组
  type: "function" 目前基本只有这一种
  function{}       名字、描述、参数都包在这里
```

模型回的时候，也是这个形状：

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

注意 `arguments` 是**字符串**。

里面才是 JSON。

这个细节 04 篇会拆开讲。

它也是 L01 假模型和真实世界最大的形状差异。

### 8.2 Anthropic 的形状

```json
{
  "model": "...",
  "messages": [],
  "tools": [
    {
      "name": "calculator",
      "description": "计算一个四则运算表达式。",
      "input_schema": {
        "type": "object",
        "properties": {
          "expression": {"type": "string"}
        },
        "required": ["expression"]
      }
    }
  ]
}
```

三层变成两层：

```text
tools[]
  name
  description
  input_schema      <- 不叫 parameters
```

模型回的时候，不是一个 `tool_calls` 数组，而是内容块：

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "我来算一下。"},
    {
      "type": "tool_use",
      "id": "toolu_01",
      "name": "calculator",
      "input": {"expression": "12 + 8"}
    }
  ],
  "stop_reason": "tool_use"
}
```

三个关键差异：

```text
字段名：parameters  vs  input_schema
参数形态：JSON 字符串  vs  已经是对象
返回形态：独立的 tool_calls 数组  vs  content 里的 tool_use 块
```

这就是为什么"接真模型"要单独有一篇。

同一个 agent 循环，换个供应商，适配层要重写。

核心循环不用改。

改的是这层翻译。

```text
你的 Message  <->  OpenAI 的 message
你的 Message  <->  Anthropic 的 content block
```

翻译层写错，循环再对也没用。

### 8.3 适配层长什么样

教学片段（伪代码）：

```python
def to_openai_tools(tool_defs):
    return [
        {"type": "function", "function": d}
        for d in tool_defs
    ]


def to_anthropic_tools(tool_defs):
    return [
        {
            "name": d["name"],
            "description": d["description"],
            "input_schema": d["parameters"],
        }
        for d in tool_defs
    ]
```

内部只维护一份定义。

出口处翻译。

这样你换供应商时，只需要改翻译函数。

还有一个坑：不同 SDK 对 `arguments` 的处理不一样。

有的 SDK 帮你 `json.loads`，直接给你字典。

有的给你原字符串。

写适配层时不要假设。

拿到之后先判断类型：

```python
if isinstance(raw_args, str):
    args = json.loads(raw_args)
else:
    args = raw_args
```

多这三行，能省掉一整类"本地跑通、上线报错"的问题。

## 9. 工具粒度：一个万能工具还是多个小工具

这是设计问题，不是语法问题。

先看万能工具：

```json
{
  "name": "do_anything",
  "description": "执行任意操作。",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {"type": "string"},
      "payload": {"type": "object"}
    },
    "required": ["action", "payload"]
  }
}
```

它什么都能干。

也什么都干不好。

原因是：

```text
action 的取值没有约束，模型要猜
payload 的结构没有约束，模型要猜两层
出错时你分不清是选错 action 还是填错 payload
```

再看多个小工具：

```text
search_docs(query, top_k)
read_doc(doc_id)
summarize(text, max_words)
```

好处：

```text
名字即语义，选择清晰
每个 schema 都短
参数校验精确
错误信息能说清是哪个工具错了
```

代价：

```text
工具一多，说明书占的 token 变多
描述之间可能重叠，模型选错
```

怎么选？

按"动词 + 对象"切。

```text
一个工具只做一件事。
一件事只用一个工具。
```

经验边界：

```text
工具总数控制在十几个以内
单个 schema 控制在五六个字段以内
任意两个工具的描述，不能让人读完还分不清该用哪个
```

如果两个工具的描述开始互相解释，那就是该合并或者该改名了。

比如：

```text
search_docs     "搜索文档，返回片段"
search_web      "搜索网页，返回链接"
```

这两个不重叠，留着。

```text
get_user        "查询用户信息"
fetch_profile   "获取用户资料"
```

这两个就是同义词，模型只能掷骰子。

留一个，删一个。

还有一种情况：步骤强绑定。

```text
research(topic)
```

它内部要做"搜索 → 抓取 → 摘要 → 汇总"。

对模型来说，这是一个黑盒。

中间某一步失败了，它看不见，也修不了。

拆成三个工具，模型就能在第 2 步失败时只重试第 2 步。

代价是它要多走两轮。

选哪个，取决于你更怕"失败不可见"还是"轮数变多"。

## 10. 六种最常见的写坏方式

### 10.1 参数没进 required

```json
{
  "type": "object",
  "properties": {
    "expression": {"type": "string"}
  }
}
```

没有 `required`。

模型有概率只回一个空对象。

你的函数一调用，`TypeError`。

修法很简单：每个非可选参数都进 `required`。

有默认值的参数才不进。

### 10.2 描述写"计算器"三个字

前面讲过了。

补一句：字段级的描述也别省。

```json
"expression": {"type": "string"}
```

和

```json
"expression": {
  "type": "string",
  "description": "纯算术表达式，例如 \"(12+8)*3\"，不要带等号、单位或中文。"
}
```

模型填出来的东西，质量差一个档。

### 10.3 参数名缩写

```json
{"expr": {"type": "string"}}
```

`expr` 是什么？

模型可能猜对，也可能猜成 `expression`、`exp`、`e`。

参数名是模型填 key 时的唯一线索。

用完整单词。

```text
expr   -> expression
q      -> query
n      -> top_k
addr   -> address
```

少打几个字符，换来的是几轮重试。

不划算。

### 10.4 一个工具干三件事

```text
search_and_summarize_and_save(query)
```

它到底返回搜索结果，还是摘要，还是保存路径？

模型不知道。

你的实现也会变成三个 `if`。

拆开：

```text
search_docs(query)      -> 返回片段列表
summarize(text)         -> 返回摘要
save_note(title, body)  -> 返回保存结果
```

拆开之后，模型可以只用其中一步。

也能在中间失败时只重试那一步。

### 10.5 参数没有边界

```json
"top_k": {"type": "integer"}
```

模型可能填 10000。

然后你的检索接口超时，或者一次塞进来十万字，把上下文撑爆。

加边界：

```json
"top_k": {
  "type": "integer",
  "minimum": 1,
  "maximum": 20,
  "description": "返回条数，1 到 20，默认 5。"
}
```

边界不是万能的。

但"写了边界"和"没写边界"，出错率差很多。

### 10.6 描述里写实现细节

```text
"description": "调用 /v2/search 接口，走 ES 集群，返回 JSON。"
```

模型不需要知道这些。

它需要知道：

```text
什么时候用
参数是什么
返回什么
```

实现细节占 token，还会在你重构之后变成误导。

## 11. 回到真实工程：注册表、校验和报错

现在把工具定义、注册表和 schema 三样东西放回 `labs/` 的结构里看。

代码来源：

```text
labs/L01_agent_loop/tools.py
```

```python
# 工具注册表：名字 -> 函数。模型输出的 name 就是靠这个字典映射到真实代码的。
TOOLS = {
    "calculator": calculator,
}
```

代码来源：

```text
labs/L01_agent_loop/agent.py
```

```python
tool = tools.get(call.name)
if tool is None:
    return f"错误：没有名为 {call.name!r} 的工具。可用工具：{', '.join(tools)}"
try:
    return str(tool(**call.args))
except Exception as exc:                      # noqa: BLE001 —— 这里故意兜住所有异常
    return f"错误：{type(exc).__name__}: {exc}"
```

这两段合起来，就是一次工具查找的完整路径：

```text
模型给出 name
  -> 注册表按 name 找函数
  -> 找到：执行
  -> 找不到：返回一条带"可用工具"列表的错误观测
```

那条错误观测很重要。

它把"合法名字的集合"又告诉模型一次。

模型下一轮就有机会改对。

真实的 agent 里，工具定义通常比注册表多两样东西：

```text
schema        给模型看的参数说明书
validator     给自己用的参数校验
```

执行顺序是：

```text
拿到 tool_call
  -> 按 name 找工具
  -> 用 schema 校验参数
  -> 校验失败：返回错误观测，不执行
  -> 校验通过：执行，捕获异常
  -> 结果转成字符串
  -> 作为 tool 消息回填
```

很多教程跳过"校验"这一步。

因为假模型不会传错类型。

真模型会。

它会给你 `"3"` 而不是 `3`，给你 `null`，给你多一个字段，给你一个空对象。

所以校验不能省。

教学片段（伪代码）：

```python
def validate(args, schema):
    if not isinstance(args, dict):
        return "错误：参数必须是一个对象。"
    props = schema.get("properties", {})
    missing = [k for k in schema.get("required", []) if k not in args]
    if missing:
        return f"错误：缺少参数 {', '.join(missing)}。"
    extra = [k for k in args if k not in props]
    if extra:
        return f"错误：不认识的参数 {', '.join(extra)}。"
    for key, value in args.items():
        expected = props[key].get("type")
        if expected == "string" and not isinstance(value, str):
            return f"错误：参数 {key} 应该是字符串，实际是 {type(value).__name__}。"
    return None
```

这段代码没有做完整的 JSON Schema 校验。

它只挡最常见的三类错：缺参数、多参数、类型不对。

够用了。

真正的完整校验，可以接一个 JSON Schema 库。

但注意：**校验失败的信息，是给模型看的观测，不是给人看的日志。**

所以它要短、要具体、要带"怎么改"。

```text
错误：缺少参数 expression。这个工具需要一个算术表达式字符串，例如 "(12+8)*3"。
```

比

```text
ValidationError: 'expression' is a required property
Failed validating 'required' in schema['properties'] ...
```

有用得多。

后者模型也能看懂一点，但会浪费 token，还可能学着模仿这种格式。

这一层怎么做，08 篇讲结构化输出时会展开。

工具报错怎么回填、怎么自愈，05 篇会展开。

这里只需要记住一句：

```text
schema 写给模型，校验写给自己。
两件事，都不能省。
```

## 12. 把一句话需求变成一个工具定义

前面都是拆零件。

这一节走一遍完整流程。

需求是用户的一句话：

```text
"我上周那笔订单，为什么退款失败了？"
```

你要决定：要不要给它做一个工具。

### 12.1 先判断该不该做成工具

三个问题：

```text
这个信息模型自己知道吗？
它会不会随时间变化？
它是不是只存在于你的系统里？
```

三个都是"否"，就不用做工具。

退款失败原因只存在你的订单系统里，会变，模型不知道。

所以要做。

### 12.2 再决定输入

用户会给什么？

```text
订单号
或者"上周那笔"这种模糊描述
```

模糊描述不能当参数。

参数必须是确定的。

所以第一版输入是：

```text
order_id: string
```

用户没给订单号怎么办？

那是另一个工具的事：先按手机号或时间查订单列表。

不要在一个工具里同时接受"订单号"和"模糊描述"。

### 12.3 再决定输出

模型拿到什么，才能回答用户？

```text
退款状态
失败原因码
失败原因的人话解释
失败时间
下一步建议
```

输出要覆盖这五项。

否则模型还要再调一次别的工具。

### 12.4 最后起名、写描述、写 schema

名字：

```text
get_refund_status
```

不叫 `query`，不叫 `order_tool`，不叫 `refund`。

描述：

```text
查询一笔订单的退款状态和失败原因。当用户问"为什么退款失败""退款到哪一步了"时使用。
输入订单号，返回退款状态、失败原因、失败时间和建议的下一步。
订单不存在时返回「没有找到该订单」。
不用于查询物流，也不用于发起退款。
```

schema：

```json
{
  "name": "get_refund_status",
  "description": "查询一笔订单的退款状态和失败原因。当用户问「为什么退款失败」「退款到哪一步了」时使用。输入订单号，返回退款状态、失败原因、失败时间和建议的下一步。订单不存在时返回「没有找到该订单」。不用于查询物流，也不用于发起退款。",
  "parameters": {
    "type": "object",
    "properties": {
      "order_id": {
        "type": "string",
        "description": "订单号，纯数字或字母数字组合，例如 \"20261109001\"。不要带「订单」两个字。"
      }
    },
    "required": ["order_id"]
  }
}
```

### 12.5 回头看这个定义

它满足四要素吗？

```text
名字：动词+名词，语义单一
描述：做什么、何时用、返回什么、不做什么
参数：一个字段、必填、有例子
返回：成功和失败的形态都写了
```

它有没有过度设计？

```text
没有可选参数
没有嵌套对象
没有枚举
没有组合类型
```

一个字段的工具，是最容易调对的工具。

复杂的工具，都是从"一个字段"长出来的。

先把一个字段跑通，再考虑加。

这就是从需求到 schema 的全过程。

没有魔法。

只有五个决定，每个都要能说出理由。

## 13. 读代码时怎么判断

看到一段 agent 代码，先找工具定义。

找到之后，按这六个问题过一遍：

```text
1. 工具有几个？名字是不是动词+名词？
2. 每个工具的描述，说清了"什么时候用"吗？
3. required 写全了吗？
4. 参数名是完整单词吗？
5. 有没有一个工具干好几件事？
6. schema 和函数签名对得上吗？
```

第 6 个最容易查，也最容易错。

对照的方法很机械：

```text
函数有几个必填参数  <->  required 里有几项
函数参数的类型注解    <->  properties 里的 type
函数参数的默认值      <->  不在 required 里
函数的返回值说明      <->  description 里那句"返回什么"
```

对不上，就是隐患。

还有一种更隐蔽的问题：

```text
schema 写了，但代码里根本没用它。
```

也就是说，你写了一堆漂亮的 JSON Schema，发给模型了，模型也照着填了。

但执行前没有任何校验。

模型填错了，直接进函数，抛异常，被 `_execute` 兜住，变成一条错误观测。

能跑。

但你在用"多烧几轮 token"换"少写二十行校验"。

短任务无所谓。

长任务里，这一轮的错误会污染后面所有轮次的上下文。

改到后面，模型会开始模仿那个错误格式。

还有一种问题，只有把工具清单打印出来才看得见：

```text
十二个工具，其中四个的描述都以"查询"开头。
```

模型要在四个"查询"里选一个。

它只能靠后面的半句话。

这时候要么改名，要么合并，要么在描述里加"什么时候不用我"。

工具设计不是一次写完的。

它是被真实调用日志逼出来的。

你看一周的 trace，就会发现：

```text
哪个工具从来没被调用过
哪个工具总被调错
哪两个工具总被混着用
哪个参数总是缺
```

这四个信号，分别对应四种改法：

```text
删掉、改描述、合并、加 required。
```

举一个具体的例子。

假设你翻了一周的 trace：

```text
search_docs 被调了 300 次，其中 80 次参数是空的
get_weather 被调了 2 次，两次都是在问股票
save_note 每次都被调两次，参数一模一样
```

三条信号，三个结论：

```text
search_docs 的 required 可能没写，或者描述没说清"必须给 query"
get_weather 的描述里"天气"两个字太宽，模型把股票行情也当天气
save_note 不幂等，或者模型没看到上一次的成功观测
```

第一个问题改 schema。

第二个问题改描述，加一句"不用于股票、汇率、行情"。

第三个问题要改循环或工具，不是改描述。

这就是"用日志反推设计"。

比拍脑袋改 prompt 准得多。

最后给一份评审清单。

```text
名字：动词+名词，和注册表一致
描述：做什么、何时用、何时不用、返回什么
参数：最少、必填、完整单词、有例子
类型：不要的组合类型、不要的 $ref
返回：短、稳定、带单位、错误有前缀
粒度：一个工具一件事
```

六行。

每次加工具，照着填。

填不出来的那行，就是你还没想清楚的地方。

## 14. 小结：说明书是协议的一半

这篇讲的是工具协议的前半段。

```text
模型看不见你的函数。
它只看得见 name / description / parameters。
```

四要素：

```text
名字        模型回填的字符串
描述        决定用不用
参数 schema 决定填得对不对
返回什么    决定下一步怎么走
```

JSON Schema 的最小可用子集：

```text
type
properties
required
description
enum
items
additionalProperties
```

两家的形状差异：

```text
OpenAI：tools[].function.{name, description, parameters}
Anthropic：tools[].{name, description, input_schema}
```

一句话结论：

```text
工具描述就是 prompt。
写得含糊，模型就不调；写得清楚，模型才敢填。
```

下一篇讲后半段：

```text
Agent 系统讲解 04：tool_calls、执行与观测回填
```

那一篇会把 `run_agent` 逐行拆开：

```text
四条消息的角色怎么分工？
messages.append(reply) 为什么必须在执行工具之前？
tool_call_id 到底在对什么账？
一轮里两个 tool_calls 会怎样？
为什么 arguments 是字符串不是对象？
```

到那一篇，模型发的那段 JSON，你就能亲手接住了。
