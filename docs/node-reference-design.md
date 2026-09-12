# Session 内稳定短 ID 与记忆展示

> 状态：已实现；使用单一短 ID 的方案替代最初的 NodeId / NodeRef 双层映射。
> 决策日期：2026-09-12。
> 范围：节点身份、Session 内分配与恢复、分支与 Fork，以及模型和用户的引用展示。

## 1. 单一节点身份

Segment 使用 `s1`、`s2`……，Observation 使用 `o1`、`o2`……。这是节点唯一的持久化 ID，同时用于 `id`、`childIds`、Observer proposal、工具参数和导出。没有另一套随机 NodeId，也没有 NodeRef 映射表。

最初保留随机 NodeId，是为了让节点身份独立于展示引用，并在 Fork 之后仍可用同一身份关联复制节点。但本项目既不需要独立改变展示编号，也不需要仅凭节点 ID 跨 Session 合并节点。短 ID 已经永久绑定，双层映射的收益不足以抵消两套分配、校验和转换的成本。

完整地址是 `(sessionId, nodeId)`；省略 `sessionId` 表示当前 Session。不同 Session 可以使用相同短 ID。Fork 复制既有短 ID，之后各自在自己的作用域内分配。

本格式面向新 Session，不提供历史数据迁移、旧事件 reader 或旧随机节点 ID 的工具兼容入口。Segment Memory V4 的树模型不变，节点事件 envelope 升为 `version: 2`。

原始对话读取不在本次范围内。`sourceEntryIds` 保留 Pi 的原始身份和 provenance；`om_read` 读取已存储的记忆，不增加原文分页、游标、截断等新参数。

## 2. 分配与全 Session 水位

[allocation.ts](../src/memory-tree/allocation.ts) 维护两个规范十进制水位，以及节点出生事件的索引：

```ts
type NodeHighWater = { segment: string; observation: string };
type NodeAllocation = {
  highWater: NodeHighWater;
  birthEntryById: Map<NodeId, string>;
};
```

- ID 格式为 `^[so][1-9][0-9]*$`，不补零、不接受大写或空白。
- `s` 只能用于 Segment，`o` 只能用于 Observation。
- 两个序列独立增长，运行时用 `bigint`，持久化为字符串；初始水位均为 `"0"`。
- 已提交编号不回收，允许空缺，不要求编号顺序与 source 顺序或渲染顺序相同。
- 更新同一 Segment、重新分组、改变深度、compact、切换分支和重启不重新编号。
- 节点出生索引只用于恢复与验证身份，不是短 ID 到另一种 ID 的映射。

`MemoryTreeStore.rebuild(branchEntries, allEntries)` 分别构建两个投影：树来自选定分支，分配状态来自整个 Session 的追加 ledger。运行时、命令和历史查询统一通过 [sessions/memory.ts](../src/sessions/memory.ts) 使用 Pi 的 `getBranch()` 与 `getEntries()`。不能用当前分支的最大编号代替 Session 水位。

例如共同历史已有 `o1`；分支 A 增加 `o2`、`s1`。回到共同历史后，分支 B 增加 `o3`、`s2`。B 的树不含 A 的独有节点，但仍保留 A 已占用的编号。B 读取 `s1` 返回“节点不属于当前分支”，读取未分配的 `s99` 返回“未知引用”。

## 3. 持久化与严格恢复

节点及提交后水位放入同一个 `om.observations.recorded` 事件：

```ts
type ObservationsRecordedEntryData = {
  version: 2;
  nodeRecords: Node[];
  highWater: NodeHighWater;
  coversUpToId?: string;
  segmentCheck: "not_requested" | "complete" | "partial";
  warnings?: string[];
};
```

[types.ts](../src/memory-tree/types.ts) 对所有字段做严格校验。恢复拒绝旧版本、未知字段、非法 ID、水位精度或格式错误、水位回退、编号复用、同事件重复记录，以及 Observation 更新。新 ID 必须高于该类型先前的水位，且不能超过提交后的水位。

全 Session 分配回放不会把不同分支的节点混成一棵树。它验证出生与更新身份；Pi ledger 的 ancestry 用于拒绝分支外 Segment 更新。分支树回放另外验证节点确实在该分支出生，以及原有唯一 Root、单 parent、无环、全部可达、Observation 不可修改和 source 顺序等不变量。整个事件验证通过后才发布新投影。

Segment 的非扩张是 prompt/eval 质量要求，不是运行时树不变量；不依据本地 token 估算拒绝持久化记录或模型 proposal。

## 4. 提交与单写者边界

[consolidation-trigger.ts](../src/hooks/consolidation-trigger.ts) 与 [writer.ts](../src/sessions/writer.ts) 的提交顺序：

1. 进入 Runtime 的 Observer 队列；检查 Session、generation、AbortSignal 和初始化状态。
2. 读取当前分支与全 Session 水位，构造 Observer 输入。
3. 模型返回后再次读取并检查分支、记忆事件和 source；分支只能正常追加，不能在请求中替换。
4. 最佳努力规范化 proposal，验证最终树；为最终记录计算提交后的水位。
5. 紧邻 append 再次检查 Session/generation 和 abort；节点与水位一次提交。
6. 确认 Pi ledger 恰好新增一条相符事件，重建提交后的树，再供展示。

候选节点可以暂时使用尚未公开的编号。被拒绝且未提交的候选不占用持久化水位；提交成功的编号不会因后续展示失败而回收。

第一版的支持边界是**一个 Session 由一个 Pi 进程和一个活动 SessionManager 写入**。进程内按 Session ID 与 manager 身份拒绝重复 writer，并让 Fork 初始化复用 Observer 队列。多个 Pi 进程同时写同一 Session 不受支持；进程内队列与 owner 检查不是跨进程锁，不宣称支持这种并发。

已对安装的 Pi 0.81.0 实现及真实 SessionManager 测试确认：

- `getEntries()` 返回整个 Session 的 ledger，`getBranch()` 返回指定分支。
- `appendEntry` 最终调用 `appendCustomEntry`；Pi 先更新内存，再同步写文件。
- 第一个 assistant message 之前可能延迟创建文件；临时 Session 始终只保存在内存。
- API 没有独立的 fsync/磁盘事务确认；成功追加不能扩展为断电持久性的承诺。

append 抛错或结果不确定后，原 manager 的记忆读写均被阻止，连扩展 reload 也不能用不确定内存投影重试。必须重新打开已保存的 Session，依据实际 ledger 恢复。如果事件已经写入，恢复后保留其编号；如果未写入，它从未被插件成功公开。普通新 Session 则是新的编号作用域。

## 5. Fork 与临时 Session

[sessions/fork.ts](../src/sessions/fork.ts) 在 `session_before_fork` 中取消旧 Observer，进入同一写入队列，保存源 Session 的全局水位。Pi 替换扩展 runtime 后，在新 Session 的 `session_start` 中完成初始化，再允许写入或展示。

复制节点的事件已经携带原 ID。另追加一条 `om.node-ids.inherited`：

```ts
{
  version: 1,
  sessionId: "目标 Session 的完整 ID",
  sourceSessionId: "源 Session 的完整 ID",
  highWater: { observation: "38", segment: "12" }
}
```

该事件独立版本化，只保存水位和作用域，不创建节点、不推进 coverage、Observer batch 或 Segment cadence。不能降低已有水位；同一目标 Session 不能重复初始化。复制自更早 Fork 的初始化事件不等于当前 Session 已初始化。

持久化 Fork 可以从源文件全量 ledger 恢复初始化，即使复制 ancestry 不含其他分支的最新分配；初始化失败后重新激活目标 Session 可重试。历史读取不隐式初始化、不写文件，不修改活动分支。若必要源信息缺失，报错而不猜测编号。

`--no-session` 的 Fork 使用进程内、跨扩展 runtime 替换保留的快照。即使 Fork 到第一条记忆之前，也继承源水位。临时 Session 没有跨进程恢复能力，退出后的新实例是新作用域。

Fork 初始化成功不等于 forced Observer 成功；后者失败仍取消 compaction。

## 6. 阅读与编辑视图

| 本次视图中的节点状态 | 显示内容 | 显示 ID |
|---|---|---|
| 已展开 Segment，直接子节点已展示 | 标题和摘要 | 隐藏 |
| 因 `memoryDepth` 边界折叠的 Segment | 标题和摘要 | `sN` |
| 可见 Observation | 正文 | `oN` |

Root 的深度为 0，没有固定编号。`memoryDepth: 0` 显示 Segment Root 的 ID；单 Observation Root 在任何深度均显示 ID。完全展开后只打印 Observation ID。不平衡树里的浅层 Observation 与深层折叠 Segment 都保留引用。

例如 `memoryDepth: 2`：

```md
# 发布流程与记忆系统

修复发布流程，并完成记忆系统的主要设计。

1. [o38] 用户要求保留原始对话的追溯能力。

## 发布流程修复

已修复分支路由，并完成验证。

### [s12] 路由问题调查

确认了故障原因、修复方案和验证结果。
```

[render.ts](../src/memory-tree/render.ts) 的 `RenderedMemory.nodes` 和 details 的 `renderedNodeIds` 包含所有展示节点，包括隐藏 ID 的祖先。details 升为 `version: 2`，`exposedRefs: string[]` 仅记录实际打印的短 ID。单一身份不需要重复保存 `{ ref, nodeId }`。token 估算基于最终 Markdown，渲染仍只由 `memoryDepth` 控制。

`om_read` 保留既有 depth 语义：深度边界仍列出 child previews。按实际显示状态隐藏父 Segment ID、保留预览节点 ID；有序列表编号仅用于排版。`om_sessions` 是有限导航预览，Root 和 `topLevel` 均保留 ID。

Observer 是编辑协议：即使展示直接子节点，也始终保留 Root 的短 ID，使模型可以提交同 ID 的 Root 更新。新节点由代码分配；模型不能通过其他短 ID 更新非 Root Segment。source entry ID 不作转换。

JSON/JSONL 保留全部所选结构的 `id`、`nodeId`、`parentId`、位置及 provenance；这些字段直接使用短 ID，无需额外 `ref`。Markdown 隐藏祖先 ID 不影响结构化导出的父子关系。

## 7. 验证

- [node-allocation.test.ts](../tests/node-allocation.test.ts)：严格新格式、规范十进制、超出 JS 安全整数的序号、全 Session 唯一性、跨分支冲突、更新与重启稳定性。
- [session-node-ids.test.ts](../tests/session-node-ids.test.ts)：真实 Pi 分支、持久化和临时 Fork、继承缺失 ancestry 的水位、只读历史查询、单写者、延迟落盘、写文件失败和不确定提交。
- [consolidation-trigger.test.ts](../tests/consolidation-trigger.test.ts)：并发队列、提交前分支验证、过期工作、Fork 取消及原有强制 Observer 行为。
- renderer、memory-tools、Observer、compaction 和 command 测试覆盖末端 ID、预览、编辑协议和结构化导出。
- 运行 `npm run typecheck`、`npm test`、`npm pack --dry-run`。实时模型评估按 [eval/AGENTS.md](../eval/AGENTS.md) 使用 Observer 与 memory-tools harness；本次开发环境缺少必要评估凭据，未运行实时请求。
