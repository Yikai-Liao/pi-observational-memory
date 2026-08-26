# 查询Session元数据

---

## 📤 导出信息
- **会话标题**: 查询Session元数据
- **导出时间**: 2026/8/26 13:31:53
- **来源**: ChatGPT
- **链接**: https://chatgpt.com/c/6a8dcb43-1b6c-83ea-8c14-44fad6e1d0be

---

## 1. 🙋 用户

PI 的每个 session 包括 sub agent session，我自定义的 package 可以给这些 session 去塞一些 meta data 吗？PI 里面这些 session 有自己的 ID 和标题吗

---

## 1. 🤖 ChatGPT

可以。Pi 原生其实已经给了你做这件事所需的大部分 primitive。

### 1. 每个 Pi session 有自己的稳定 ID

Session JSONL 第一条就是 header，大致是：

```json
{
  "type": "session",
  "version": 3,
  "id": "...",
  "timestamp": "...",
  "cwd": "/repo"
}
```

扩展里可以直接取：

```typescript
const sessionId = ctx.sessionManager.getSessionId();
```

`AgentSession` 本身也暴露 `sessionId`。所以你完全可以把 **session ID 作为你自己的 observational memory / metadata 系统的主键**。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub+1](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md?utm_source=chatgpt.com)

### 2. 有“标题”，但 Pi 叫 `sessionName`

它不是 header 里固定存在的字段，而是一个可选的 `session_info` entry：

```json
{
  "type": "session_info",
  "id": "...",
  "parentId": "...",
  "name": "Refactor auth module"
}
```

扩展可以：

```typescript
pi.setSessionName("Review PR #49");
const name = pi.getSessionName();
```

也可以通过：

```typescript
ctx.sessionManager.getSessionName();
```

读取。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)github.com+1](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md?utm_source=chatgpt.com)

有一个重要区别：

>
> **Pi core 并不保证每个 session 都有 title。**
>
>
>

如果没调用 `/name` 或 `setSessionName()`，`/resume` 通常用第一条消息作为展示文本。自动生成标题是例如 `pi-sessions` 这种第三方 package 做的，而不是 Pi session 的必备属性。[![图片](https://www.google.com/s2/favicons?domain=https://pi.dev&sz=128)Pi Coding Agent](https://pi.dev/packages/pi-sessions?utm_source=chatgpt.com)

所以从数据模型上我会把它理解成：

```typescript
interface SessionIdentity {
  id: string;       // 必有
  name?: string;    // 可选
}
```

### 3. 你的 package 可以往 session 里塞任意 metadata

而且 Pi 专门提供了这个 API：

```typescript
pi.appendEntry("my-package.session-meta", {
  agent: "reviewer",
  taskId: "abc",
  parentSessionId: "...",
  kind: "subagent",
  phase: "review",
});
```

最后 JSONL 中会出现：

```json
{
  "type": "custom",
  "id": "...",
  "parentId": "...",
  "customType": "my-package.session-meta",
  "data": {
    "agent": "reviewer",
    "taskId": "abc",
    "kind": "subagent"
  }
}
```

这种 `custom` entry **不会进入 LLM context**，官方就是把它定义成 extension state persistence。重新加载 session 时：

```typescript
pi.on("session_start", async (_, ctx) => {
  const entries = ctx.sessionManager.getEntries();

  const metadata = entries.filter(
    e =>
      e.type === "custom" &&
      e.customType === "my-package.session-meta"
  );
});
```

[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)github.com+1](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md?utm_source=chatgpt.com)

这一点对你现在考虑的 observational memory 很合适：**metadata 和 conversation 保存在同一 session 生命周期里，但不会浪费模型 context。**

不过有个结构上的细节值得注意：

>
> `appendEntry()` 是 **append-only event**，不是 `session.metadata.foo = xxx`。
>
>
>

所以如果你的 metadata 会更新，不要假装它是 KV：

```
meta v1
meta v2
meta v3
```

读取时取最后一个，或者做 event sourcing。

如果你有大量频繁变化的数据，我反而建议只把**索引/身份信息**放 custom entry，大块状态放你自己的存储。

## 4. Sub-agent 要特别区分实现

这里是最容易误解的地方：

**Pi core 本身没有一种特殊的“SubAgentSession”数据类型。**

所谓 sub-agent，本质上通常是 extension 启动另一个 Pi instance/process。

Pi 官方提供的那个 subagent example 甚至直接这样启动：

```typescript
["--mode", "json", "-p", "--no-session"]
```

也就是说官方 example 的 subagent 默认**根本不持久化 session**。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts?utm_source=chatgpt.com)

所以不能泛化地说：

>
> “Pi 每个 sub agent 天然都有一个持久化 session ID + title。”
>
>
>

这取决于你用的 subagent package。

例如你最近看的 `mjakl/pi-subagent` 就自己实现了持久化 child session。它会根据：

```
parentSessionId
+ cwd
+ agentName
+ logical session handle
```

生成 child Pi session ID：

```
subagent.<hash>
```

同时给它 human-readable display name：

```
subagent: review · api-review
```

所以这种实现下：

```
Parent Pi session
  id = 019...
  name = "Implement workflow editor"

      │
      ├── Subagent Pi session
      │     id = subagent.abcd...
      │     name = "subagent: review · api-review"
      │
      └── Subagent Pi session
            id = subagent.efgh...
            name = "subagent: test · tests"
```

它明确把 generated session ID 等 metadata 返回给 parent。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/mjakl/pi-subagent?utm_source=chatgpt.com)

## 5. 你的 package 能不能同时给 parent 和 subagent 塞 metadata？

**能，前提是你的 extension/package 在那个 child Pi process 中也被加载。**

最干净的做法其实不是 parent 去修改 child session 文件，而是：

```typescript
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();

    // 判断自己是什么 session
    // 然后 append metadata
  });
}
```

于是每个实际启动的 Pi instance 自己负责：

```
session start
      ↓
你的 package 加载
      ↓
getSessionId()
      ↓
appendEntry("observational-memory/session-meta", ...)
```

这样 parent、child、甚至 nested child 都是同一套机制。

### 如果是为了你前面那个 OM 设计

我会倾向于让 metadata 最少包含：

```typescript
{
  sessionId,
  kind: "root" | "subagent",
  parentSessionId?: string,

  agent?: string,
  role?: string,

  createdBy?: string,

  // 如果 subagent system 有自己的 logical handle
  handle?: string
}
```

然后把 `sessionName` 当成**人类可读 label**，不要当 identity：

```
identity = sessionId
display  = sessionName
relation = parentSessionId
```

这样你实际上天然得到的是：

```
                   root session
                  /      |      \
             reviewer  scout   worker
                 |
             reviewer-2
```

也就是一个 **session DAG/tree + 每个 session 内部自己的 temporal observation hierarchy**。

这和你刚才讨论的“短期保存叶子 + 阶段摘要，远期只剩摘要”其实可以很好地分层：**Pi session ID 负责 conversation boundary，OM 自己负责 session 内部的层次化压缩，不需要重新发明 session identity。** [![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub+1](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md?utm_source=chatgpt.com)

---

## 1. 🤖 ChatGPT

我会明确区分：

>
> **系统的硬预算必须是 token；节点数最多只能作为内部的复杂度/退化保护，不应该成为主要用户控制参数。**
>
>
>

因为真正稀缺的资源不是“能放几个节点”，而是 **context window 里占多少 token**。

## 为什么节点数预算不合适

同样 10 个节点，成本可能完全不同：

```
10 个 Observation
每个 800 tokens
→ 8K

10 个高层 Segment summary
每个 120 tokens
→ 1.2K
```

甚至：

```
Segment A summary = 80 tokens
Segment B summary = 900 tokens
```

所以：

```
max_nodes = 30
```

对最终 context 大小几乎没有稳定含义。

更麻烦的是，它会给 Segmenter 一个奇怪的激励：

>
> 把同样的信息组织成更多/更少节点，会间接改变 Compact 能保留多少内容。
>
>
>

这说明节点数量不应该成为资源货币。

# Token 才是天然的“rate”

你的问题本质上就是：

>
> 给 Memory Tree 一定的表示容量，它如何选择 representation frontier？
>
>
>

那么预算就是：

这非常直接。

比如：

```
memory budget = 12K

当前 frontier:
S1 summary      400
S2 summary      600
S3 children    2800
S4 observations 5300
...
total          11.7K
```

这才真正对应 Pi 最终送给模型的 context 成本。

## 但用户可能也不应该直接控制一个裸的 `memory_tokens=12347`

这里我觉得又要分**内部参数**和**用户配置**。

内部肯定：

```
token budget
```

用户-facing 我反而倾向于让它表达：

### 方案 A：总 Context 的比例

例如：

```yaml
memory:
  budget_ratio: 0.25
```

假设当前可用上下文 128K：

```
Memory Tree render    25K
Raw recent tail       20K
当前 prompt / buffer  其余
```

好处是模型 context window 换了以后配置不用跟着改。

### 方案 B：明确几个 token budget

如果这是开发者型 Pi package，我其实更喜欢明确：

```yaml
compact:
  memory_budget: 12000
  raw_tail_target: 12000
  raw_tail_max: 20000
```

因为非常容易 debug：

```
这轮 Compact：
memory representation = 11.4K
raw tail = 13.7K
```

没有隐藏行为。

对于你这种 package，我觉得这种方式反而更合适。

# Node budget 仍然有一个重要用途

虽然它不适合作为**信息预算**，但非常适合作为 **planner / output safety cap**。

例如：

```yaml
max_frontier_nodes: 128
max_children_per_list: 100
```

这是为了避免：

```
1000 个每个只有 5-token 的奇怪 Observation
```

在 token budget 看起来完全合法，却产生一个超级碎的 representation：

```
O1
O2
O3
...
O937
```

这种 context 对模型不一定好。

所以可以有两个独立约束：

同时：

但是两者角色完全不同：

```
token budget
= information capacity / primary constraint

node cap
= fragmentation guard / secondary constraint
```

## 这还揭示出另一个你后面一定会遇到的问题

**同样 token 数，100 个碎节点和 5 个完整 Segment，价值并不一样。**

例如都是 5K：

```
方案 A
100 × 50-token observation

方案 B
5 × 1K coherent segment
```

Token budget 无法反映 representation fragmentation。

但我还是不会因此改用 node budget。

更合理的是单独增加一个很弱的**结构偏好**：

>
> 如果两种 frontier 信息预算相近，优先节点更少、更完整的 representation。
>
>
>

也就是类似 regularization：

但第一版甚至不用数学化，planner 可以遵循：

>
> **只有展开一个 Segment 带来的细节价值足够高，才把 1 个节点替换成多个 children。**
>
>
>

这样天然抑制碎片化。

# 所以我会形成三层控制

### 1. 硬约束：Token

```
memory token budget
```

必须满足。

### 2. 软偏好：保持较粗的 Segment

只有近期/高价值区域才继续展开。

这就是我们前面在讨论的 detail-decay policy。

### 3. 安全上限：Node count

例如：

```
max rendered nodes = 128
```

只防极端情况，不作为正常 planner 的主要目标。

## 如果一定要让我冻结一个 V1 配置

我会只暴露：

```yaml
memory:
  budget_tokens: 12000

compact:
  raw_tail_target_tokens: 12000
  raw_tail_max_tokens: 20000
```

内部固定：

```
max_frontier_nodes = 一个比较宽松的安全值
```

暂时不暴露给用户。

因为第一版最重要的是减少可调参数。

最终你真正需要研究的其实不是：

>
> “12K 该对应多少节点？”
>
>
>

而是：

>
> **给定 12K，哪一部分树值得展开，哪一部分应该停在 Segment summary。**
>
>
>

这正是你上一条提到的 **detail distribution / frontier planning** 问题。Token budget 应该只是这个问题的约束条件，而不是替代这个问题本身。

---

## 2. 🙋 用户

其实好像这个东西很自然，我们直接按节点深度去砍一刀完了，让用户配置记忆中保存多少节点深度，不强制给一个 token 预算。常见的配置，比如说按 root 的深度为 0 的话，卡一个深度为 1 或者深度为 2 就可以了。由于分层行为是事后总结，不是事前规划，所以短期的观察，大概率还是深度为一或者深度为二或者三（而且整个树肯定是右边有一堆只有深度为 1/2 的叶子节点，性质决定的，只有当触发最后 Compact 的时候，刚刚干完一个活，给它分了一个 Segment 才可能是深度为二，只要还没分 new segment 那就会有几个深度为一的）越老的历史，它的叶子节点所在的深度就会越深，全局卡一个统一深度，基本就能卡的比较好了，只要 Segment 触发做的没什么问题，也不会出现长度爆炸。这样就不会硬性卡一个 Token 预算，也比较简单好控制

---

## 2. 🤖 ChatGPT

对，我觉得这个方向比前面设计一条“详细度随时间衰减曲线”自然得多。因为你的树本身就是**事后逐渐长深**的，所以 **depth 已经隐式编码了 recency × consolidation 程度**。

不是：

>
> 根据时间算应该显示多详细。
>
>
>

而是：

>
> 记忆自己随着反复 Segment 逐渐变深；Compact 只在固定深度截一个 frontier。
>
>
>

这会让“远期粗、近期细”自动涌现出来。

## 可以把规则定义得非常简单

Root depth = 0。用户配置：

```yaml
memory:
  render_depth: 2
```

遍历时：

```
Segment depth < 2
→ 展开 children

Segment depth == 2
→ 不再展开，展示这个 Segment 的 summary

Observation
→ 无论在哪一层，只要遍历到了它，就展示 observation
```

例如当前树：

```
root                            d0
├─ Old A                        d1
│  ├─ A1                       d2
│  │  ├─ A11                  d3
│  │  │  ├─ O1
│  │  │  └─ O2
│  │  └─ A12                  d3
│  └─ A2                       d2
│
├─ Recent B                     d1
│  ├─ O20                      d2
│  ├─ O21                      d2
│  └─ O22                      d2
│
├─ O23                          d1
└─ O24                          d1
```

`render_depth = 2` 时得到：

```
A1.summary
A2.summary

O20
O21
O22

O23
O24
```

恰好就是：

```
很老：
    A11 / O1 / O2 已经隐藏
    → A1 summary

中期：
    A2 summary

近期：
    observations 直接保留

最新：
    root 下 observation 直接保留
```

完全不需要 recency curve。

# 这套东西最漂亮的是“时间”根本不用作为输入

我们之前一直纠结：

```
detail = f(
    wall-clock age?
    token distance?
    observation distance?
    semantic scale?
)
```

现在都没了。

因为 consolidation process 本身完成了这个映射：

```
历史逐渐变旧
    ↓
积累更多 observations / segments
    ↓
再次被更高层 Segment 包装
    ↓
节点自然变深
    ↓
固定 depth cutoff 后自然只看到更高层摘要
```

所以：

>
> **树的深度不是根据年龄人为定义的；它是记忆被多少轮抽象重新组织后的结果。**
>
>
>

这个含义其实比“age”更准确。

两段同样 100K tokens 以前的历史：

```
A：高度结构化，已经反复总结
→ depth 很深

B：一直没形成明确阶段
→ depth 仍浅
```

固定深度会对 B 保留更多细节。

这其实是合理的：

>
> **没被成功抽象的东西，就不应该仅仅因为它老了而机械丢掉细节。**
>
>
>

这个性质我很喜欢。

## 而且用户参数非常可理解

你甚至不需要暴露：

```
memory_budget_tokens
recency_alpha
decay_tau
semantic_weight
```

只有：

```yaml
memory:
  depth: 2
```

含义就是：

>
> “Compact memory 保留两层结构。”
>
>
>

可能默认：

```
depth 1
→ 极度压缩
→ root children：高层 Segment summary + 尚未聚合的近期 Observation

depth 2
→ 常规

depth 3
→ 更详细

depth 4+
→ 高保真 / debug
```

这比：

```yaml
tau: 32768
alpha: 0.65
memory_budget: 12288
```

让人容易理解太多。

# 这里有一个尤其好的动态性质

假设今天：

```
root
├─ S1
│  ├─ O1
│  └─ O2
├─ O3
└─ O4
```

`depth=2`：

```
O1
O2
O3
O4
```

基本都还在。

过几轮 Compact 后：

```
root
├─ S0
│  ├─ S1
│  │  ├─ O1
│  │  └─ O2
│  └─ S2
│     ├─ O3
│     └─ O4
└─ O5
```

同样 `depth=2`：

```
S1.summary
S2.summary
O5
```

再后来：

```
root
├─ S_super
│  ├─ S0
│  │  ├─ ...
│  └─ ...
└─ recent...
```

同样的配置继续自然压缩。

也就是说：

>
> **不是 Compact planner 主动降低旧历史的 fidelity；而是 Memory Tree maturation 把旧历史推到了 cutoff 以下。**
>
>
>

这比设计“遗忘曲线”简单且更符合你的数据模型。

# 但我会保留一个内部 hard safety guard

这里唯一不能完全依赖 depth 的是 **context window 是硬物理约束**。

极端情况下：

```
root
├─ O1  5K
├─ O2  8K
├─ O3  20K
├─ O4  15K
...
```

如果 Segmenter 很久没有工作，哪怕：

```
depth = 1
```

这些 root leaf 全都会被展示。

可能直接 80K。

所以我赞同：

>
> **不要让用户用 token budget 驱动正常规划。**
>
>
>

但内部仍然必须有：

```
rendered memory must fit context
```

这种 emergency guard。

它的定位不是：

>
> “正常情况下按 12K budget 优化 frontier。”
>
>
>

而是：

>
> “如果固定 depth 产生的结果真的放不进 context，说明树没有及时 consolidate，执行 fallback。”
>
>
>

fallback 可以依次：

1. 立即触发一次额外 segmentation/consolidation；
2. 如果仍过大，把 cutoff 从 `D` 临时降成 `D-1`；
3. 最坏情况下再进行 token hard-cap。

也就是说：

```
正常策略：
depth cutoff

异常保护：
context/token hard limit
```

别把两者混为一谈。

## 我甚至觉得这会给 Segmenter 一个非常清楚的质量标准

以前我们会问：

>
> Segment 应该多久产生一次？
>
>
>

现在可以换成：

>
> **在默认 `depth=2` 下，rendered memory 是否长期保持在合理规模？**
>
>
>

如果发现：

```
depth=2
→ 经常 50K+
```

不是先去设计更复杂的 planner。

而应该先检查：

>
> 为什么老历史还大量停留在 depth ≤ 2？是不是 consolidation 不够积极？
>
>
>

反过来：

```
depth=2
→ 很快只剩 2K
```

说明 Segment hierarchy 可能聚合得太激进。

这样 flame graph 也会特别直观：

```
左侧旧历史应该逐渐长深
右侧近期保持浅
```

如果出现大量：

```
十万 token 以前还挂在 root depth=1
```

一眼就知道记忆树没长好。

所以我现在会明显偏向你的这个设计：

>
> **用户控制 `memory depth`，而不是 memory token budget。**
>
>
>

Token 只作为系统不可违反的最终安全约束。

更重要的是，它把责任划得很清楚：

- **Segmenter / consolidation 决定树如何成熟**
- **depth cutoff 决定用户想保留多少层细节**
- **context limit 只负责防止极端爆炸**

这样比“设计一条 recency→detail 曲线然后解 optimization”简单了一大截，而且行为更容易解释、可视化和 debug。

---

## 3. 🙋 用户

我觉得这种极端情况不会出现。因为我在使用目前那个 PiObservational memory插点的时候，它基本不触发 Reflect，所有 Observational 都是平铺展开在记忆里面的工作的，还是很正常，也没出现什么过多记忆把上下文撑爆的情况

---

## 3. 🤖 ChatGPT

对，这个经验其实很重要。它说明我们前面担心的“固定 depth 会不会把 context 撑爆”大概率是个伪问题。

如果当前 Pi Observational Memory 在几乎不触发 Reflect 的情况下，本质上长期是：

```
root
├─ O1
├─ O2
├─ O3
├─ ...
└─ On
```

也就是**所有 Observation 平铺展示**，都能稳定工作，那么你的新结构：

```
root
├─ S1
│  ├─ ...
├─ S2
│  ├─ ...
├─ O_recent
└─ O_recent
```

只要 Segment summary 做得正常，固定 depth 截断理论上只会比原来更省，而不会更贵。

## 可以直接定一个很强的 invariant

对任意 Segment ：

最好还不是勉强小一点，而是明显压缩，例如：

```
Segment summary ≪ children representation
```

那么一次：

```
O1 + O2 + O3 + O4
        ↓ segment
        S.summary
```

一定是非膨胀操作。

再往上：

```
S1.summary + S2.summary + S3.summary
              ↓
          S0.summary
```

仍然非膨胀。

于是随着树不断长深：

>
> **任意固定 depth 的 rendered memory 大小应该整体趋于稳定或下降。**
>
>
>

这比额外设计 token planner 更有力。

### 而且你的 baseline 已经给了上界参考

现有 OM 基本相当于：

```
render_depth = ∞
```

因为 Observation 全平铺。

如果这个状态都没问题，那么：

```
depth = 1
depth = 2
depth = 3
```

本质上都是在这个 baseline 上增加 collapse。

所以第一版确实没必要：

- memory token budget
- detail decay curve
- rate-distortion planner
- node count budget
- emergency dynamic depth
- 一堆权重函数

都可以砍掉。

## 我现在甚至会把 renderer 定义得非常机械

例如用户配置：

```yaml
memory:
  depth: 2
```

规则只有：

```
从 root depth=0 开始

如果遇到 Observation：
    render observation

如果遇到 Segment 且 depth < configured_depth：
    recurse children

如果遇到 Segment 且 depth >= configured_depth：
    render segment summary
```

结束。

没有时间因素，没有 token 权重，没有 recency 曲线。

而“近期详细、远期抽象”完全来自树本身的生长方式：

```
recent
→ 尚未 consolidate
→ 节点浅
→ depth cutoff 仍然能看到 leaves

old
→ 经历多轮 consolidate
→ leaves 被推到更深
→ cutoff 命中上层 Segment summary
```

这其实非常优雅。

唯一值得保留的 token 信息，我现在认为主要不是拿来**规划 memory detail**，而是拿来做两件事：

1. Pi Compact 的 `firstKeptEntryId` / raw-tail 边界选择。
2. telemetry：观察 `depth=2` 实际每次 render 出多少 tokens。

后者先统计，不控制行为。

例如 Inspector 里直接显示：

```
Memory render depth: 2
Rendered nodes: 17
Rendered tokens: 6,420

Raw tail: 11,380
Total compact context: 17,800
```

跑一段真实 workload 后，如果你发现：

```
depth=2
p50  5K
p95  9K
max 14K
```

那就更加证明根本不用搞 token planner。

如果真的出现异常，再从数据找原因，而不是提前设计保护机制。

所以我现在会把整个设计进一步收缩为：

>
> **Segmenter 决定树长成什么样；用户只选择看树的几层。**
>
>
>

这可能就是目前我们讨论到这里最简单、同时又最符合你现有 OM 使用经验的方案。

---
