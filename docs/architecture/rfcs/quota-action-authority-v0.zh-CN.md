# RFC：Quota 动作权威（v0）

- **RFC 状态：** 已接受
- **替代 / 关闭：** 无
- **交付成熟度：** 仅提案，尚未实现
- **作者 / 负责人：** LoopX 控制面维护者
- **创建日期：** 2026-09-30
- **最近规范修订：** 2026-09-30
- **实现基线：** `b79bcb1949e470aac3fcee416e96f2f4c468f926`
- **相关契约：** [Effect interpreter](agent-loop-effect-interpreter-v0.zh-CN.md)、[共享权威](shared-goal-authority-state-provider-v0.zh-CN.md)、[TypeScript 迁移](typescript-control-plane-migration-v0.zh-CN.md)
- **语言镜像：** [English](quota-action-authority-v0.md)

## 文档地图与维护约定

第 1–10 节定义设计与验收契约，第 11 节定义交付门禁，第 12 节记录待决事项。
附录 A 是证据，不代表交付。合并接受此设计依据，不代表运行时实现已上线、
默认值已改变、provider 已启用或 promotion 已获批准。
中英文文档互为语义镜像；规范性变更必须同步修改两份文档。

## 1. 决策摘要

在既有 TypeScript quota 边界内，等待 eligibility 和 selection 确定后，
统一解析可执行动作，再从该结果生成包含动作的展示。
推荐、receipt 绑定的选择、当前执行准入、历史结算仍是不同事实。

先修 scoped-gate 动作投影的不一致，保留现有 wire 字段与 receipt identity。
本决策不包含整个 quota pipeline 重写、新 scheduler 或隐式任务预占。

## 2. 问题与动机

同一 quota packet 可能告诉 Agent 执行两个不同 Todo。复现场景是：
User gate 只约束另一个 Agent；P0 Todo 需要 shell 和 network；
P1 Todo 只需要 shell；当前仅具备 shell。被审计的 builder 输出为：

| 输出面 | 实际观察到的动作 |
| --- | --- |
| `selected_todo.todo_id` | P1 shell Todo |
| `interaction_contract.agent_channel.primary_action` | P1 shell Todo |
| `agent_scoped_user_gate_override.selected_action` | P0 network Todo |

override 在 capability 过滤前从较早的 executable summary 选出文本，
packet assembly 又同时保留两套结果。这是可复现的展示不一致；
实验没有证明发生了越权执行，也没有测量其频率。此处 P0 是工作优先级，
不是安全严重性评级。

### 不变量

- 所有标为可执行的动作必须指向同一最终动作身份。
- 推荐不授予所有权、能力、权限或 lease。
- 已有 Turn receipt 保留原 Todo 和结算身份。
- 当前门禁可以阻止新执行，但不能抹去历史恢复依据。
- 没有 eligible action 时，override 不能重新带回早先的 Todo。

## 3. 范围与非目标

范围包含最终 quota 动作投影、兼容消费者，以及从推荐到既有 Todo
claim/admission 机制的衔接。不改变排序策略、不删除 wire 字段、不在 status
读取中预占工作、不重做存储、不新增 capability/provider，也不一次迁移全部
Python 编排。第 6 节的争抢工作属于既有共享权威契约下的独立有界后续变更。

## 4. 当前系统契约

- [`agent_scope.py`](../../../loopx/control_plane/agents/agent_scope.py) 中的
  `_agent_scoped_user_todo_override` 自行选出 `selected_action`。
- [`should_run_prepare.py`](../../../loopx/control_plane/quota/should_run_prepare.py)
  在 capability gate 前计算 override；显式选择与 receipt 恢复在后续具有更高优先级。
- [`should_run_packet.py`](../../../loopx/control_plane/quota/should_run_packet.py)
  将 override 与 `selected_todo`、interaction 输出分别附加。
- [`quota_selection.ts`](../../../loopx/control_plane/todos/quota_selection.ts)
  已拥有 typed eligibility/ranking 事实。相同 profile 和未认领队列，
  可以让多个 Agent 同时收到同一个首选 Todo。
- [`todo_claim.ts`](../../../loopx/control_plane/coordination/todo_claim.ts)
  拥有 canonical claim 和可选 hard lease。receipt helper 恢复已接受的操作，
  不会为遭到 CAS 拒绝的写入重新规划。

[PR #4061](https://github.com/loopx-project/loopx/pull/4061) 处理 fallback
声明及直接依赖的快照，并明确不提供整个 quota/status packet 的原子快照。
本 RFC 与它互补，双方不需要吸收对方的实现。

## 5. 建议架构

### 所有权与放置

最终动作语义放在 `control_plane/quota`，组合已有 typed Todo selection
和 gate 规则。Python 可以收集事实、呈现兼容输出，但不能再排序或选出第二个
可执行动作。claim/lease 准入仍归 `control_plane/coordination` 和
`control_plane/work_items`。Capability id：不新增；provider id：既有已配置的
权威 provider；交付形式：内建控制面实现，无 extension。

### 状态与身份

在最终 packet composition 使用一个小型内部判别结果：

| Kind | 含义 | 包含动作的输出 |
| --- | --- | --- |
| Recommendation | Eligible 候选，尚无持久化 Turn 选择 | 明确标注为建议的候选 |
| Selected | 既有 selection 契约将 Turn 绑定到 Todo | 精确绑定的 Todo；执行仍需当前准入 |
| Settlement | 恢复或完成既有 receipt | 原 receipt identity 和允许的恢复步骤 |
| Gated | 当前没有获准的交付动作 | Typed 原因及允许的解决路径，不含旧工作指令 |

这些是建议的内部状态，不是新增 wire enum 或持久化字段。
保留 `quota_selected_todo_v0` 全部字段、override schema、source label、
selection marker 和 settlement receipt。有最终动作时，由它生成兼容的
`selected_action` 文本；没有时遵守既有 schema 的可选字段规则。
如果消费者要求非空文本，必须在实现前定义兼容的 gated 表达。
不能为了让旧 receipt 字段与当前推荐一致而替换 Todo。

必须保留合法区别：preferred candidate 可以与未绑定 Turn 共存，
已完成 Todo 仍可能需要结算。身份比较使用既有结构化 identity，
不用动作文本、展示 index 或 substring 分类规则。

### 生命周期与副作用

观察只产生推荐，不修改状态。显式选择绑定既有 Turn identity。
claim 与当前 permission/capability/lease 检查准入执行。
validation、writeback、spend 使用绑定身份。重放读取原 receipt，
并独立验证任何当前执行证明。阶段之间出现新 gate 时，当前准入 owner
阻止新工作，但不删除已接受结果。

这是投影一致性边界，不意味着所有事实来自同一个数据库事务。
各个 effect 仍须重新验证自己拥有的事实。

## 6. 备选方案、争抢与 ROI

将最终动作文本复制回某个 override 是最便宜的修复，但还需要共享的最终投影
规则，覆盖显式选择、空候选和 receipt 重放。重写整个 quota pipeline
涉及更大的兼容面，目前没有证明额外收益。

Todo 争抢需要区分原因和处理方式：

| 观察或风险 | 有界处理 | 证据边界 |
| --- | --- | --- |
| 两个同 profile Agent 看到同一未认领首项 | 先 claim 再工作；确定因其他 owner 被拒绝后，刷新 eligibility，通过既有 selection 契约选择其他候选 | 已确认合成推荐碰撞，未测量生产频率 |
| 独立 canonical claim 暴露 provider CAS 冲突 | Typed claim owner 重读 receipt/head，重验相关事实，重建 mutation，有限重试 | 已确认 File/SQLite 命令层交错；同 root 本地 CLI 写锁可能将其串行化 |
| 同 Todo 或 required write scope 重叠 | 保留 ownership/lease 拒绝，不通过重试接管 | 已确认同 Todo 排他；scope 重叠仍是必需验收项 |
| 不同 session 复用同一 Agent id | 保留 execution key/lease generation 检查，先查 session binding 再归因排序 | 诊断假设，尚未确认是实际事故原因 |

共享权威 RFC 已要求 Todo 级语义冲突，应在 canonical claim 的既有 owner
补齐采用。不要把领域重试规则放进通用 receipt helper，也不要弱化 provider CAS。
重新规划前先查 receipt 恢复；保留 request identity、source authorization、
显式 revision/transfer 前置条件、依赖、gate 和 write scope。
模糊提交必须用原 operation identity 恢复，不能换 Todo。
确定未写入的拒绝可以允许重选；已有绑定的 Turn 必须先走既有 reconciliation
契约，禁止悄悄更换目标。

同 rank 分流、jitter 或新增原子 claim-next API，应等待测量证明刷新/重选仍然
代价较高。跨优先级 hash 分配或每次 poll 随机排序会隐式改变调度。

以下是规划估计，不是已测量的工时或生产收益：

| 交付切片 | 含聚焦回归评审的工作量估计 | 预期 ROI | 建议 |
| --- | --- | --- | --- |
| 最终动作投影和兼容矩阵 | 1–3 工程人日 | 高：小范围所有权调整即可消除已复现矛盾 | 优先实施 |
| Canonical claim 重验/重试 | 2–4 工程人日 | 独立跨 runtime writer 下中高；单个串行本地 writer 下较小 | 先补负例/重放 fixture，再独立 PR |
| 排序分流或 claim-next API | 获得争抢测量前不估算 | 未知；会增加公平性、选择和恢复语义 | 暂缓 |
| 完整 quota 编排重写 | 数周级变更 | 相比有界切片的增益尚未证明 | 暂缓 |

收益可按“减少的失败尝试次数 × 平均恢复时间，加上减少的错误动作恢复”评估，
再与实现及持续维护成本比较。对外声称回本周期前，需要收集频率和
成功 claim 耗时的 p50/p95。

## 7. 安全、隐私与兼容

status 保持只读。本设计不批准 authority provider、hard-lease 模式、
Agent identity、调度、权限或能力启用的默认变化。已有 reader 继续解析现有字段。
实现 PR 和 release notes 必须披露矛盾动作文本的有意修正，不能将输出变化
笼统宣称为行为完全不变。公开证据使用合成 Todo id 和汇总计数，
不包含私有 Goal 内容、host 路径、原始日志或凭据。

## 8. 迁移与回滚

没有持久化状态迁移计划。先刻画合法的 selection/replay 行为，再替换一个动作
投影及其实际消费者。扩大采用前比较兼容输出。矩阵失败时回滚该有界投影变更，
receipt 和 provider 状态仍可读取。claim 重试独立交付，回滚时不改变已存储的
operation 或 lease identity。

## 9. 验证与验收

| 主张 | 测试或证据 | 必需结果 | 边界 |
| --- | --- | --- | --- |
| 唯一可执行动作 | Peer-scoped gate × 能力缺失/齐全 × 空候选 × 显式选择 | 所有 executable 输出指向最终身份，无旧动作 | 当前反例属于已知失败行为 |
| Gate 不破坏恢复身份 | 绑定 Turn、已完成 Todo、能力丢失、已结算/未结算重放 | 保留原结算 identity，不新增执行授权 | 运行时交付前必须补齐 |
| 独立 claim 可推进 | Provider commit 前 barrier，两个不同 Todo 和 operation id | 有界内部重验后均成功 | 先 File/SQLite，其他 profile 保留资格门禁 |
| 同目标排他 | 同 Todo、foreign owner、write scope 重叠、授权/依赖改变 | 唯一胜者或 typed 拒绝，无未授权 receipt | 仅测试成功重试不够 |
| 恢复幂等 | 响应丢失、receipt 存在/缺失/不可读、request drift | 恢复原已接受 receipt，ambiguity 不能成为新 claim | 不改变通用 receipt 语义 |
| 兼容性 | 现有 quota smoke、聚焦测试、混合 legacy 消费者 | 保留 wire shape，仅发生已披露修正 | 现有测试全绿不能单独关闭反例 |

这些都是实现门禁，不表示本文档 PR 已完成运行时资格验证。

## 10. 运行约定

利用现有诊断/证据面区分推荐碰撞、其他 owner、provider-head 竞争、
重试耗尽和模糊 receipt 恢复。统计每次成功 claim 的尝试次数和延迟，
不另建遥测系统。失败 claim 不能显示为执行准入。
Host 消费既有 typed 恢复路径，不应循环尝试同一个过时首项。

## 11. 规范性交付计划

| 阶段 | 交付行为 | 进入门禁 | 退出证据 | 回滚 |
| --- | --- | --- | --- | --- |
| M0 | 最终动作投影一致 | 消费者清单和 characterization 矩阵 | 修复反例；负例/selection/replay 和 quota 检查通过 | 回滚投影切片 |
| M1 | 独立 claim 吸收无关 CAS miss | 既有共享权威规则；移动代码前补 fixture | 有界重试、同 Todo/scope 排他、当前 gate 和丢响应恢复 | 回滚重试切片 |
| M2 | 有证据时才减少残余碰撞 | 残余成本测量及已同意的公平策略 | 尝试次数/延迟改善，无饥饿或优先级反转 | 恢复排序策略 |

M0 和 M1 是独立可评审变更。M2 需要新的显式设计决策；
本 RFC 不批准新增 API 或默认排序变化。

## 12. 待决事项

1. Quota 维护者在 M0 前根据真实消费者清单确定最小内部结果形状和空动作文本的
   兼容表达。建议复用现有 codec，只省略本来可选的字段，不删除 public 字段。
2. Coordination 维护者在 M1 前根据强制交错和 provider 延迟决定次数/时间预算。
   建议有限重试、typed 耗尽、保持 operation identity，不使用无限循环。
3. 维护者观察残余失败次数及公平性后，决定是否启动 M2。
   建议在缺少测量证据时暂缓。

## 附录 A：证据登记（非规范）

全部观察使用头部所列实现 baseline 和合成输入，证明机制，不证明部署中
某个 Goal 的发生频率。

| 证据 | 设置与结果 | 限制 |
| --- | --- | --- |
| 动作投影 | `build_quota_should_run` 使用第 2 节 fixture：仅 shell 时选择 P1、override 指向 P0；加入 network 后此矛盾消失 | 未执行真实动作 |
| 现有回归 | `uv run --extra test python examples/control_plane/quota-agent-scoped-user-gate-smoke.py` 通过，同时组合 fixture 不满足身份一致性 | 表明组合覆盖缺失 |
| 推荐 | `projectQuotaSelection` 输入两个未认领、同 rank Todo 和相同 profile，Agent A/B 都得到首项 | 推荐不是 reservation |
| Claim 交错 | 真实 File 和 SQLite store；native 双 Todo head、hard-lease 模式、不同 operation/lease key；`commitAuthority` 前 barrier：独立目标得到 applied/conflict，用同 operation 重试成功 | 绕过外层本地 writer 串行锁，不证明部署吞吐 |
| 排他对照 | 相同设置改为同一目标：一个 applied、一个 conflict；同 operation 重试得到 `claim_owner_mismatch` | 没有双重所有权证据 |

临时 probe 留在产品面之外。随 M0/M1 将对应语义案例纳入现有聚焦 suite，
不把原始日志或实验专用 runner 固化成永久 smoke。
