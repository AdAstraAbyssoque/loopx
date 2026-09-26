# RFC: Goal 不可变性作为一致性防御 (v0)

- **RFC 状态:** 草案
- **交付成熟度:** 提案
- **作者/所有者:** LoopX 维护者
- **创建日期:** 2026-09-27
- **最后规范修订:** 2026-09-27
- **实现基线:** `fd96e5e25`
- **语言镜像:** [English version](goal-immutability-coherence-defense-v0.md)
- **相关契约:** [Agent Loop Effect Interpreter](agent-loop-effect-interpreter-v0.md), [TypeScript Control-Plane Migration](typescript-control-plane-migration-v0.md), [Semantic Vocabulary Convergence](semantic-vocabulary-convergence-v0.md), [总体路线图](loopx-overall-roadmap-v0.md), [Capable Manager and Semantic Handoff](capable-manager-semantic-handoff-v0.md), [Goal Direction Baseline](goal-direction-baseline-v0.md)

## 文档图与维护契约

第 1–10 节是持久性设计与验收契约。第 11 节是规范性交付计划。第 12 节包含未解决的决策。附录包含非规范性执行台账、决策日志、证据注册表、被拒绝的替代方案和事故教训。中英文版本互为语义镜像。

---

## 1. 决策摘要

1. **Goal 不可变性成为显式的、经过测试的架构保证**，而非实现惯例。Goal 的身份、意图修订、权限绑定和验收基础，不得在压缩（compaction）、会话重启或 Agent 替换过程中悄然改变。

2. **Goal 实例隔离（GoalRef `{goal_id, goal_instance_id}`）从实现细节提升为一致性防御机制。** 当新 Goal 复用名称时，旧实例被隔离（fenced）；旧实例的迟到结果绝不得污染新实例。

3. **现有的 source registry 上的 CAS（Compare-And-Swap）成为防御一致性崩溃的第一道防线**，与其当前的原子状态转换职责并列。每次改变 Goal 状态的写入都必须对当前 Goal 实例重新验证其基础。

4. **现有的 claim、lease、Todo 投影和 effect receipt 契约不变。** 此 RFC 不添加新的状态模式、新的 provider 或新的权限。它定义了现有架构已满足的验收标准，并补充缺失的一致性证据。

5. **此 RFC 不批准**新的 Goal 表示格式、分布式共识协议、人工关注门禁，或任何模型提示变更。它是通过现有机制加上有针对性的回归覆盖来实现的纵深防御契约。

## 2. 问题与动机

### 一致性崩溃问题

2026 年，AI Agent 行业识别出一种系统性的失败模式：**Agent 找到了正确答案，然后亲手毁掉了它。**

三条独立的证据线在此交汇：

| 来源 | 发现 | 机制 |
| --- | --- | --- |
| TRAJEVAL（Kim et al., 2026）/ Codex Desktop 社区报告 | 60–69% 的 SWE-Agent 和 OpenHands 失败发生在 Agent 已经定位并编辑了正确函数**之后** | 压缩截断了原始验收目标；内部审阅笔记和基于 mock 的测试成为事实上的真相来源 |
| Anthropic Managed Agents（2026） | 长运行期间的 harness 状态丢失导致 Agent "猜测"已完成的工作；过早完成声明是一级失败模式 | Session 事件必须是唯一的持久真相；harness 实例是可替换的 |
| Agent 工作流中的约束弱化（arXiv:2608.24569） | 交接（handoff）转换从自然语言工件中剥离 87–100% 的操作约束 | 结构化字段（前提条件、权限、回退、后果）必须在每次交接中存续 |

共同的根本原因：**当 Agent 的工作上下文漂移时，运行环境中没有任何东西将其重新锚定到原始目标。** 模型被要求遵循其上下文窗口中已不再存在的指令。

### 为什么 LoopX 已经具备这一防御

LoopX 的架构嵌入了三项直接防止一致性崩溃的属性：

1. **不可变的 Goal 身份。** Goal 的 `goal_id + goal_instance_id` 在创建时分配且永不被重写。压缩不能重命名 Goal、合并两个 Goal 或丢失实例边界。Agent 的"工作记忆"可以退化，但控制面拒绝引用错误实例的写入。

2. **source registry 上的 CAS。** 每次状态转换都会重新读取并重新验证当前 Goal 修订版本。一个过时的写入——基于旧 Goal 实例计算的——会因实例修订版本已变更而 CAS 失败。这不是模型行为，而是强制执行的机器契约。

3. **类型化的 Todo 投影。** 工作承诺被保存为结构化记录，而非 Markdown 段落。压缩不能悄然将某项承诺编辑成另一项承诺；Todo 写入器验证身份和 lane 分配。

这些属性已存在，但尚未作为一致性防御进行验证。Goal A/B 迟到结果实验（第 9 节，附录 C）提供了首个量化证据。

### Goal A/B 实验结果

一项受控的 128-episode 实验注入了语义故障——来自已被替换的 Goal 的迟到结果——并测量了四种恢复策略：

| Arm | 策略 | 正确 / 32 | UCR ↓ | 重复副作用 | 错实例污染 | SRPA |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | Resume/Retry（朴素重启） | 8 | 16 | 8 | 8 | 0/8 |
| B | Aligned Rollback（基于检查点） | 16 | 16 | 8 | 8 | 0/8 |
| C | Conditional Reflection（启发式恢复） | 24 | 8 | 0 | 8 | 0/8 |
| **D** | **Semantic Certificate（GoalRef + CAS）** | **32** | **0** | **0** | **0** | **8/8** |

Arm D——使用基于 GoalRef 的实例隔离和 CAS 验证——实现了零意外状态变更、零重复副作用和零错实例污染。所有其他 arm 即使避免了重复效应，也产生了至少 8 次错实例污染。

实验使用了真实的 LoopX Turn 日志、跨进程恢复和生产级 Goal 实例切换。Oracle 篡改和策略突变体检测练习确认了结果并非特定故障集的假象。

### 不变量

1. Goal 实例一旦创建，就具有稳定的 `goal_instance_id`，任何压缩、重启或交接都不能改变它。
2. 每次状态变更写入都必须在写入被接受之前，对当前 source registry 重新验证其基础（`goal_instance_id` + revision）。
3. 来自旧 Goal 实例的迟到结果必须 CAS 失败并产生可见的拒绝回执——绝不被静默接受，也绝不被静默丢弃。
4. Agent 的工作上下文（模型提示、内部笔记、压缩产物）不是 Goal 身份或验收的真相来源。
5. 现有的 claim、lease、effect receipt 和 Todo 投影契约继续不变地运行。

## 3. 范围与非目标

### 范围内

- 将 Goal 不可变性和实例隔离形式化为经过测试的架构保证。
- 为一致性崩溃场景添加回归覆盖：迟到结果、实例替换、压缩导致的漂移、并发冲突写入。
- 将现有 CAS 机制文档化为一致性防御，附以 Goal A/B 实验和新的定向冒烟测试的验收证据。
- 将 LoopX 的防御与行业问题空间（一致性崩溃、约束弱化、Session 作为真相来源）连接起来。

### 非目标

- 新的 Goal schema、持久化格式或 provider。
- 分布式共识协议或跨主机一致性保证（R6 范围）。
- 人工在回路中的审批门禁（单独 RFC 领域）。
- 模型提示工程或压缩策略变更。
- 替换现有 claim/lease/quota/effect receipt 机制。
- Agent 输出的通用"语义正确性"——此 RFC 防御身份级别的污染，而非模型推理质量。

## 4. 当前系统契约

在基线 `fd96e5e25`，以下与一致性相关的机制已存在：

| 组件 | 当前行为 | 一致性相关性 |
| --- | --- | --- |
| GoalRef `{goal_id, goal_instance_id}` | PR #5106：协作请求绑定到精确实例；PR #5130：聊天会话绑定到精确实例 | 在 Goal 替换后阻止旧实例写入 |
| Source registry CAS | `preview` 阶段缓存 digest；`commit` 阶段验证；拒绝过期写入 | 每次状态转换的原子基础验证 |
| Goal 实例生命周期 | `stop` → `resume` / `replace` 保留实例身份；同名新 Goal 获得新的 `goal_instance_id` | 实例边界在进程重启后存活 |
| Turn journal 重放 | PR #5139：TypeScript 中的 Turn 接受和重放；`client_turn_id` 去重 | 防止效应双重执行 |
| Todo 投影 | 带操作回执的结构化 lane 分配（R1 checkpoint） | 承诺在模型上下文丢失后存活 |
| Effect receipt | 带去重身份的带类型结算记录 | 防止重复的受保护效应 |

**缺口：** 这些组件中没有一个作为协调系统针对一致性崩溃场景进行测试。各个部分存在并通过了各自的单元测试，但没有集成级测试验证 Goal 替换是否能端到端地（CAS → effect receipt → Todo 投影 → Turn journal）隔离旧实例写入。

## 5. 提议架构

### 5.1 所有权与权限

**source registry**（TypeScript `AuthorityStore` / Python `GoalRegistry`）是 Goal 身份和实例修订的唯一所有者。没有模型输出、压缩产物、交接摘要或 Agent 自我报告可以改变 Goal 的 `goal_instance_id` 或接受对过期实例的写入。

**CAS 验证器**（现有 `preview` → `commit` 管线）是状态变更写入的唯一门禁。它在每次提交前检查 `goal_instance_id` 和 revision。

**Turn journal** 和 **effect receipt** 所有者不变。它们消费 CAS 门禁的决策；不独立确定实例有效性。

### 5.2 一致性防御模型

```
Agent 针对 Goal 实例 A₁ 产生结果 R
                    ↓
A₁ 被停止；创建 Goal A₂（同名，新实例）
                    ↓
R 迟到到达，目标为 A₁
                    ↓
CAS 门禁：当前实例为 A₂，revision > R 的基础
                    ↓
写入被拒绝 → 可见的拒绝回执
                    ↓
A₂ 的状态未被污染
```

这不是新的代码路径。这是现有 CAS 机制在当前测试套件未覆盖的一致性崩溃场景下的执行。

### 5.3 状态模型（无 schema 变更）

不引入新字段或 schema。参与其中的现有类型：

```typescript
// 现有 — 现文档化为一致性关键
type GoalRef = {
  goal_id: string;
  goal_instance_id: string;  // 一致性隔离边界：必须匹配当前实例
};

// 现有 — CAS 基础携带实例身份
type WriteBasis = {
  goal_instance_id: string;  // 写入计算时所依据的实例
  revision: number;           // 计算时的修订版本
};
```

唯一变化是 `goal_instance_id` 现被文档化为**一致性隔离边界**，CAS 门禁的拒绝路径在实例不匹配为原因时必须产生类型化的回执（而非通用错误）。

### 5.4 命令生命周期（无新命令）

现有写入路径（Todo 提交、effect 结算、claim 获取、plan 确认）已通过 CAS。验收标准为每条路径添加负面测试用例：

| 写入路径 | 一致性负面用例 |
| --- | --- |
| `commit_todo` | Todo 基于 A₁ 计算，在 A₂ 替换 A₁ 后提交 |
| `settle_effect` | Effect 在 A₁ 的 lease 下执行，回执在 A₂ 的 lease 启动后到达 |
| `acquire_claim` | Claim 以 A₁ 的身份请求，在 A₂ 激活后到达 |
| `confirm_plan` | Plan 基于 A₁ 的 registry 预览，在 A₂ 创建后确认 |

每个负面用例必须产生命名 `goal_instance_id` 不匹配的类型化拒绝回执，而非通用失败。

### 5.5 Provider 契约（无变化）

此 RFC 不添加 provider。现有的 File/SQLite authority store 已实现 CAS。一致性防御是 CAS 契约的属性，而非存储后端的属性。

## 6. 替代方案与设计选择

### 替代方案 A：提示级别的防御

通过系统提示告诉模型"不要接受过时的结果"。**已拒绝：** 一致性崩溃论文表明模型无法可靠地执行此操作——压缩会移除此指令，且模型无法在没有控制面检查的情况下验证实例身份。

### 替代方案 B：压缩策略

通过限制压缩频率或保留原始指令来防止上下文漂移。**作为唯一防御已拒绝：** 这有帮助但不能保证正确性；这是一种依赖模型行为的提示工程方法，而非强制执行的契约。LoopX 仍可从更好的压缩策略中受益，但它们是互补的，而非替代。

### 替代方案 C：基于检查点的回滚（Codex CLI / Anthropic 方案）

保存检查点并在检测到漂移时回滚。**作为唯一防御已拒绝：** 检查点防止数据丢失但不防止错实例污染——A₁ 状态的检查点不可能知道 A₂ 已替换了它。检查点 + CAS 比单独任何一方都好；检查点是恢复机制，CAS 是预防机制。

### 替代方案 D：语义证书（此 RFC 的方案）

使用不可变 Goal 身份 + CAS 作为一致性门禁。**已选择。** LoopX 已拥有该机制；缺口在于验证而非实现。这是保证不变量的最小变更：零新代码路径、零新状态、定向回归覆盖。

## 7. 安全性、隐私和兼容性

- **默认关闭对等性：** 此 RFC 不改变任何默认行为。所有写入已通过 CAS；新的验收标准仅为应已安全失败的场景添加测试覆盖。
- **授权：** 无新权限。实例隔离由现有 source registry 执行；任何模型、Agent 或操作员都不能绕过 CAS。
- **公共/私有边界：** 无变化。Goal 身份、实例修订和拒绝回执是公共安全的控制面事实。
- **旧版兼容性：** 现有的 Goals、Todos、claims 和 effect receipts 继续运行。它们的 `goal_instance_id` 字段已存在（PR #5106、#5130）或从 registry 在运行时派生。无需迁移。
- **混合版本：** 未在其 CAS 基础中填充 `goal_instance_id` 的旧写入器将因 registry 要求该字段而失败。这是故障关闭（fail-closed）：拒绝回执告知调用方升级。不存在静默接受路径。
- **容量与可用性：** CAS 开销不变。实例身份检查是对已加载字段的整数比较。

## 8. 迁移与回滚

**无需迁移。** 字段和 CAS 机制已存在。此 RFC 添加测试覆盖和文档。

**回滚：** 移除新的回归测试。现有行为不变。无需数据迁移或降级路径。

## 9. 验证与验收

### 9.1 确定性一致性

| 声明 | 测试或证据 | 要求结果 | 边界 |
| --- | --- | --- | --- |
| C1：旧实例的迟到 Todo 被拒绝 | Goal A₁ → stop → create A₂ → 以 A₁ 的基础 commit_todo | CAS 拒绝；带有 `goal_instance_id` 不匹配的类型化回执；A₂ 的 Todo 列表不变 | File authority store |
| C2：旧实例的迟到 effect 被拒绝 | A₁ 获取 lease，执行 effect → A₁ 停止 → A₂ 创建 → effect 回执到达 | 回执被拒绝；effect 未重复计数；A₂ 的 effect 账本干净 | File authority store；受保护 effect 使用模拟适配器 |
| C3：旧实例的迟到 claim 被拒绝 | A₁ 持有 claim → A₁ 停止 → A₂ 创建 → A₁ 的 claim 续约到达 | 续约被拒绝；A₂ 可以独立获取自己的 claim | File authority store |
| C4：旧实例的迟到 plan 被拒绝 | Plan 基于 A₁ 预览 → A₁ 停止 → A₂ 创建 → plan 被确认 | 确认被拒绝；A₂ 的 plan 列表不变 | File authority store |
| C5：并发的 Goal 创建产生不同实例 | 两个进程同时创建 Goal "X" | 两个不同的 `goal_instance_id`；每个实例的写入相互隔离 | File authority store；进程级竞态 |

### 9.2 实际验证（Goal A/B 实验复现）

| 声明 | 证据 | 要求结果 | 边界 |
| --- | --- | --- | --- |
| C6：Arm D 产生零 UCR | 128-episode 运行（4 tasks × 4 scenarios × 2 seeds × 4 arms） | Arm D 的 UCR = 0；所有其他 arm UCR ≥ 8 | 模拟模型 + 真实 LoopX 控制面 |
| C7：Arm D 产生零错实例污染 | 同一 128-episode 运行 | Arm D 的错实例写入 0/32；Arms A/B/C ≥ 8/32 | 同上 |
| C8：两次独立运行产生相同语义结果 | 使用不同随机种子重新运行 | Arm D：两次运行均 32/32 正确；拒绝模式无定性差异 | 同上 |
| C9：Oracle 篡改被检出 | 9 个 oracle 突变场景 | 全部 9 个被检出；无误接受 | 模拟 oracle 损坏 |

### 9.3 行业连接验证

| 声明 | 证据 | 要求结果 | 边界 |
| --- | --- | --- | --- |
| C10：一致性崩溃场景可复现 | 针对 LoopX 重建 Codex Desktop 压缩场景 | LoopX Goal 在压缩后以完整身份存续；Agent 从 registry 重新读取原始 Goal | 模拟压缩；Agent 行为未使用真实模型测试 |
| C11：约束弱化场景被防御 | 仅自然语言上下文的交接 vs. 结构化 GoalRef | 结构化交接保留实例身份；仅自然语言交接丢失实例身份 | 同一 Goal 范围内 |

## 10. 运维契约

**可观测性：** 实例不匹配的 CAS 拒绝回执必须可与其他拒绝原因（权限、配额、并发写入）区分。类型化回执包含 `rejection_reason: "goal_instance_mismatch"`、`expected_instance_id` 和 `actual_instance_id`。

**故障模式：**
- 实例不匹配 → 类型化拒绝回执，调用方决定下一步操作。
- Registry 不可用 → 现有故障关闭行为；不进行任何写入。
- CAS 竞态（两个并发写入针对同一实例）→ 一个成功，一个获得并发写入拒绝；实例身份对两者均不变。

**无新的容量限制、备份要求或运维人员操作。**

## 11. 规范交付计划

| 里程碑 | 交付行为 | 进入门禁 | 退出证据 | 回滚 |
| --- | --- | --- | --- | --- |
| M1：一致性防御 RFC | 本文档，作为草案接受；行业分析和 Goal A/B 实验摘要位于规范章节 | 维护者对第 1–6 节的评审 | 批准的草案状态；路线图第 4 节更新 | 不适用（仅文档） |
| M2：回归覆盖 | C1–C5 一致性测试在 File authority store 上通过 | M1 已接受 | 5/5 测试通过；类型化拒绝回执已验证 | 移除测试文件 |
| M3：实验复现 | C6–C9 以 CI 可接受的形式复现（无原始模型调用，无私有数据） | M2 完成 | 全部 4 项实验声明在自动化冒烟中通过 | 移除冒烟文件 |
| M4：行业场景冒烟 | C10–C11 紧凑冒烟通过 | M3 完成 | 两个场景均产生正确输出；无生产代码变更 | 移除冒烟文件 |
| M5：RFC 晋升 | RFC 从草案移至已接受；路线图更新 | M1–M4 完成；10 天浸泡无回归 | 所有验收行绿色；维护者批准 | 不适用 |

## 12. 待解决决策

| ID | 决策 | 所有者 | 选项 | 建议 | 所需证据 | 截止日期 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | M3 实验复现应使用完整的 128-episode 运行还是紧凑的 8-episode 冒烟？ | 维护者 | 完整（10–15 分钟）vs. 紧凑（< 30 秒） | CI 用紧凑冒烟，发布前验证用完整运行 | 完整运行的 CI 预算影响 | M3 |
| D2 | `goal_instance_id` 应添加到现有的 effect receipt schema 中，还是在 receipt 验证时从 Goal 派生？ | Effect receipt 所有者 | Schema 添加 vs. 运行时派生 | 运行时派生（无 schema 变更，无迁移） | 所有 receipt 写入路径的审计 | M2 |
| D3 | 迟到结果拒绝应触发对新 Goal 实例的自动重试，还是需要显式 Agent 操作？ | Collaboration 所有者 | 自动重试 vs. 显式 | 显式：Agent 必须决定是否重新提交。自动重试会创造新的双重执行风险。 | Agent 行为研究 | M4 |

---

## 附录 A：执行台账（非规范）

### 2026-09-27 — RFC 创建

- **基线:** `fd96e5e25`
- **交付:** 本文档（草案提案）
- **证据:** Goal A/B 实验结果（附录 C）；行业分析（附录 E）
- **已知缺口:** M2–M5 验收行尚未执行
- **对规范设计的影响:** 无（初始创建）

## 附录 B：决策日志

| 日期 | 决策 | 所有者 / 批准 | 替代方案 | 变更的规范章节 |
| --- | --- | --- | --- | --- |
| | | | | |

## 附录 C：证据注册表 — Goal A/B 实验

> 完整证据位于 `.local/research/loopx-semantic-fault-research-2026-09-26.md` L569–L696。本附录总结公共安全的结果。

| 证据 ID | 声明 | 基线/环境 | 结果 | 隐私边界 |
| --- | --- | --- | --- | --- |
| E1 | Arm D 达到 32/32 场景正确性 | 128 episode：4 tasks × 4 fault scenarios × 2 seeds × 4 arms；真实 LoopX Turn 日志 | 通过：32/32 正确 | 公共安全摘要；原始轨迹已排除 |
| E2 | Arm D 达到 0 UCR | 同一 128-episode 运行 | 通过：UCR = 0（A:16, B:16, C:8） | 同上 |
| E3 | Arm D 达到 0 重复副作用 | 同上 | 通过：0 重复（A:8, B:8, C:0） | 同上 |
| E4 | Arm D 达到 0 错实例污染 | 同上 | 通过：0 污染（A:8, B:8, C:8） | 同上 |
| E5 | Arm D 达到 8/8 SRPA | 同上 | 通过：8/8（A:0, B:0, C:0） | 同上 |
| E6 | 两次独立运行产生相同结果 | 使用不同种子重新运行 | 通过：Arm D 两次运行均 32/32 | 同上 |
| E7 | 9/9 Oracle 篡改场景被检出 | Oracle 突变注入 | 通过：全部检出 | 同上 |
| E8 | 4/4 策略突变体被检出 | 策略突变注入 | 通过：全部检出 | 同上 |

## 附录 D：被拒绝或取代的替代方案

### 提示级别的一致性指令

将"写入前验证你的 Goal 实例"添加到系统提示。已拒绝，因为：(a) 一致性崩溃论文表明模型指令在压缩过程中丢失，(b) 模型无法访问 CAS 门禁的实例修订版本，(c) 这在不可靠的层中重复了控制面的职责。

### 基于超时的实例隔离

如果 `current_time - goal_creation_time > TTL` 则拒绝写入。已拒绝，因为：基于时间的隔离是粗糙的（Goal 可能活跃数天；替换可能在数秒内发生）且依赖时钟同步。基于 CAS 的隔离是精确的：它比较写入计算时的确切实例修订版本。

### 对新实例的自动重试

当写入因实例不匹配被拒绝时，自动对当前实例重新提交。已拒绝，因为：新 Goal 实例可能有不同的意图、约束或验收标准。Agent 必须显式决定重新提交。

## 附录 E：行业证据 — 一致性崩溃及相关现象

### E.1 一致性崩溃（Codex / TRAJEVAL）

**来源：** Kim et al., TRAJEVAL（arXiv:2603.24631，2026 年 3 月）；Daniel Vaughan, "Coherence Collapse: Why Your Coding Agent Finds the Fix Then Destroys It"（2026 年 7 月）；OpenAI Community 报告 #1391211（2026 年 8 月）。

**发现：** 60–69% 的 SWE-Agent 和 OpenHands 失败发生在 Agent 已经定位并编辑了正确函数之后。压缩截断了原始验收目标；内部审阅笔记和基于 mock 的测试成为事实上的真相来源。一个观察到的案例：36 次压缩，58 个 subagent 角色，数百个基于 mock 的测试通过而真实的 happy path 却失败了。

**LoopX 相关性：** LoopX 的不可变 Goal 身份和 source registry 上的 CAS 直接防止了这一点。Agent 的上下文可以退化，但写入必须对当前 Goal 实例重新验证。任何压缩都不能改变 Goal 的 `goal_instance_id`。

### E.2 Session/Harness/Sandbox 分离（Anthropic）

**来源：** Anthropic Engineering Blog, "Scaling Managed Agents"（2026 年 4 月），"Effective Harnesses for Long-Running Agents"（2025 年 11 月）。

**发现：** 将持久化的 Session（仅追加的事件日志）与无状态的 Harness（推理循环）和 Sandbox（执行环境）分离，使崩溃恢复零成本。任何 Harness 实例都可以从最后一条事件恢复任何 Session。

**LoopX 相关性：** LoopX 的 Goal/Todo/Claim 三层投影在控制面层面是相同的模式。Goal = 持久化意图，Todo = 工作投影，Claim = 执行绑定。Goal 在 harness 替换后存续，正如 Anthropic 的 Session 在 harness 替换后存续。

### E.3 Agent 工作流中的约束弱化

**来源：** "When 'Must' Becomes 'Maybe'"（arXiv:2608.24569，2026 年 8 月）。

**发现：** 自然语言交接工件剥离 87–100% 的操作约束。恢复四个结构化字段（前提条件、权限、回退、后果）将保留率提升至 100%。

**LoopX 相关性：** LoopX 的 claim/lease 和 GoalRef 是在交接中存续的结构化字段。交接携带确切的 `goal_instance_id`，而非复述。约束弱化论文为 LoopX 的类型化交接设计提供了独立验证。