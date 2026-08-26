# Segment Memory Tree

> 变更计划，非当前状态

## 设计背景

原始仓库版本中，将记忆组织 Observations 和 Reflections。但是为了保证不确定的未来对话能中，能保持此前记忆的高召回，Reflections 和 Drop 都非常保守。
在一个长线开发中，经常会无法进行任何一次有实际产出的Reflection，导致Observations无限膨胀，将过去的完整细节的执行记录保留在记忆中。这不利于上下文窗口的管理。

一个真实案例是：docs/om_example.txt

## 设计理念

对于人类来讲，将短期的工作记忆组织为Segment Tree的形式是非常自然的，越是老的执行记忆，可以只在记忆中保存一个高层次的阶段性的摘要，
并且可以通过主动会议去对这个阶段的记忆进行展开。展开后可能是更小的阶段，也可能展开得到最小的单位，也就是我们这个仓库中Observations的概念。

很自然的，我们希望，保留原来的Observations产生机制。然后通过某种机制定期触发对于Segment的产生（一个节点只能归于一个父Segment）。Segment应该具有标题和ID和摘要。

然后这样我们会得到一个节点带有时间区间或者说token区间的的Segment Tree。越老的部分深度越深，越新的部分越浅，甚至直接是Observation 挂在Root下。
我们希望这种segment是模型认为彻底完成才产生的，不是说和plan一样，先规划一个segment再往上挂新节点。

这样很自然的，老的记录会被越顶越深。于是，我们只需要让用户配置一个每次compact的时候保留的树深度（记root的深度为0），就能很轻松的控制保留多详细的记忆。
因为，compact时，最新的节点最大深度为2（刚生成一个segment，没有observation直接挂在root下，此时最新的observation深度为2）就能保留最新的observation，
并让远期记忆只留存高层次抽象。

在读取上，首先记录和segment过程应该是和目前observation生成一样，后台自动异步触发的。然后应该暴露一个  ls 和 read 工具，让模型能主动去展开某些历史记忆。
这些工具应该包含可选的session id，没有id传入就直接查看当前session的记忆，如果有id就完成了跨session查询。当然需要某种机制，让他找到过去有记忆的session，id是什么，想办法让他确认他要看哪个session。也许我们需要root节点也有摘要？

这样，我们就可以完成跨session的任务复盘，甚至是周级的，甚至月级的多session复盘，比如用来生成新的skill或者迭代AGENTS.md。
甚至这个 read工具应该能直接有一个可选参数可以让记忆导出到jsonl 或者什么形式，这样模型就可以接住更普遍的shell/其他编程语言如python，用polars duckdb做其他更灵活的分析处理。

以上是核心能力，他甚至还能溢出一些非核心能力。例如pi默认保留20k token结尾，当然可以配置，但是20k大概没几个observation。
我们可以获得一个非常自然的以segment或者observation为切分边界的tail保留，而不是留下某个半截的segment。这个切分边界会更自然，当然实际效果需要再验证。

## 技术选型

不用一个中央化的后台进程+sqlite来实现这些持久化，我们完全可以做成单体pi插件，利用pi内置的entry持久化机制去持久化整个segment tree，
内存中保留树结构，并在重启时走entry做重建。

可以通过一个 /xxx 命令触发一个启动http服务（启动时动态选择端口），产生一个实时的记忆火焰图网页，用于让我们分析他的记忆，但是这不是首版需要实现的能力。