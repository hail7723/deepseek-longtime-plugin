# dsh-longtime-memory v0.3 现场问题修复计划

更新时间：2026-10-25  
状态：**待实施；本文件是下一阶段要求，不表示任何条目已经完成。**

## 0. 当前基线与保护规则

- 代码远端基线：`375cd864467955f012217e9014b285dfc1992ec2`（`main`）。
- 工作树还有未提交的 `0.3.0-dev.3` 改动：自动从活动 Harness 会话读取工作区路径；不得 reset、checkout 或覆盖这些改动。
- 当前安装/测试的候选包不是正式 release。`v0.3.0-dev.1` tag 指向较早快照，不能代表 dev.2/dev.3。
- 现有 `.deepseek-memory` 是用户数据。任何复现实验必须先复制到临时目录；不得再让测试临时目录落在项目根下并触发祖先 marker 查找。
- 所有迁移先备份，所有写入失败必须在 UI 可见。不得通过抢占未过期租约来“修复”续接写入。

## 1. 已报告问题与目标行为

| 问题 | 目标行为 |
| --- | --- |
| 恢复会话后 `memory_commit` 返回 `LEASE_CONFLICT` | 续接会话能安全续写；活跃租约不被静默覆盖，过期后自动重试，纯追加更新可延后落盘。 |
| 租约不可理解、不可操作 | UI 显示“其他会话正在保存，约 N 秒后可重试”，提供刷新、等待后重试、保存草稿/排队；不显示 fence 或原始毫秒。 |
| 第二任务完成但仍恢复第一任务 | 每个会话有明确绑定；UI/API 可选择、新建、暂停、完成、归档任务；多任务绝不按数组顺序猜选。 |
| `Next action` 和证据会陈旧 | 显示最后核对时间、验证状态和“被后续事件超越”；文件/命令证据变动后自动标为 stale，而不是继续显示 passed。 |
| 增量写入被整体冲突拒绝 | 严格保护目标、验收、状态和下一步；仅允许可证明独立的追加项进入 deferred queue，在获得新租约后重放。 |
| GUI 未显示未保存 | 面板有 `已保存 / 正在保存 / 等待租约 / 未保存` 状态和错误操作入口。 |
| 每轮注入重复且无时效 | 恢复包带 `last verified`/fingerprint；若 Harness 允许，未变化的同会话请求用极短提示或不重复注入，压缩/新会话仍注入完整有界包。 |
| 错误混用英文码和 epoch 毫秒 | Host 返回结构化、可本地化的错误详情；Client 以中文相对时间和可操作文案渲染。 |
| 手动输入 cwd | 面板从当前选中会话读取已确认工作区；无当前会话或多窗口不明确时明确提示，而不是复用别窗路径。dev.3 仅完成初步实现，必须在真实 Desktop 验证。 |

## 2. R00：先复现与补足接口证据

只读或临时副本操作：

1. 在隔离 profile 和临时项目中复现“session A 留有活跃租约 → session B resume → 连续两次 `memory_commit` 失败”。记录任务 revision、lease owner、lease expiry、fence、checkpoint 和工具调用顺序。
2. 核对 Harness `0.2.1-rc.3` 是否向 Client 主面板暴露当前 session id / workspace；不能凭“唯一活动 agent”假设解决多窗口。为该接口写最小 Client/Host 集成测试。
3. 捕获 `agent/created`、resume、fork、`agent/disposed`、turn stopping、`tools/pre-execute`/`tools/result` 的真实 payload 和时序。特别核对 lease 能否在 dispose 时释放，以及 stop hook 是否可等待。
4. 对用户数据库只做副本一致性核对：任务、events、evidence、checkpoints、candidates、tool operations 数量和关键字段。不要直接改 live DB。

输出：`docs/v0.3-lease-and-session-evidence.md`，包含实际接口、复现记录和当前 API 缺口。

## 3. R01：租约、续接写入与延后保存

### 3.1 数据与 API

- 保持 fencing；任何 live lease 的强行接管都是禁止行为。
- 增加 `lease_status` 查询：只向普通 UI 返回 `held_by_current_session`、`held_by_other_session`、`remaining_seconds`、`can_retry_at`（ISO 时间）和 `retry_after_seconds`。owner/fence 仅诊断区可见。
- 增加 `deferred_commits`：`id, project_id, task_id, session_id, base_task_version, base_contract_version, kind, payload_json, status(queued|flushed|conflict|discarded), created_at, flushed_at, reason`。
- `memory_commit` 按变更类别分类：
  - **严格字段**：objective、contract、task state、next action、blockers；租约/CAS 冲突立即拒绝并返回可读差异。
  - **独立追加**：verification/evidence reference、工具结果摘要、append-only acceptance observation；live lease 时写入 deferred queue，不宣称已同步。
- 新 session 或 lease 到期后，Host 获取新租约并最多 flush 一次 queue；仅当 base revisions 与目标字段不冲突时合并。失败保留 queue，显示“需要复核”，绝不丢失。
- 正常 session dispose 尝试释放自己的 lease；崩溃仍依赖 TTL。续接写入使用短、可续租的 lease，并在 expiry 后指数退避重试一次。

### 3.2 UI

- 保存状态固定显示在任务顶部：`已保存于…`、`正在保存`、`等待另一会话（约 N 秒）`、`未保存—可重试`。
- 添加“重试保存”和“保留为待同步草稿”；没有“抢占他人会话”按钮。
- 错误码在 Client 映射为中文；日期用本地相对时间，诊断区才展示 code、owner、ISO timestamp、fence。

验收：A/B session、resume、崩溃 TTL、两次连续 commit、queue flush、严格字段冲突、取消草稿均有自动测试和真实 profile 验证。

## 4. R02：多任务与会话选择

- Client/Remote 迁移到 `startTask/useTask/listTasks/setTaskState/commit`，不再让 UI 使用 v0.2 的 `bootstrap/claim/checkpoint` 表单。
- 将 session id 显式从当前 Client 会话传给 Host；如果当前 Harness Client API 无法提供它，停止 UI 实现并记录缺口，不用“全局唯一 agent”作为多窗口方案。
- `startTask` 绑定新任务到当前 session；`useTask` 持久化绑定；completed/archived binding 失效后重新选择。
- UI 列出所有 open tasks，提供选择、新建、暂停、完成、归档。多个 unfinished task 时恢复包与 UI 都显示候选，不能回退到第一个 active。
- task 的 `last_activity_at`、`last_checkpoint_at`、`display_order` 只用于展示排序，绝不作为隐式选择规则。

验收：第一个任务与 README 任务分别绑定不同 session；完成 README 不改变第一任务绑定；第三会话明确要求选择；fork/resume 策略按 R00 观察结果测试。

## 5. R03：时效、验证与证据失效

- checkpoint 新增 `observed_at`、`superseded_at`、`superseded_by_event_seq`、`freshness`；恢复包显示“最后核对于 …”。
- 写入新 checkpoint、任务状态或与 workspace 相关的工具结果时，自动将更旧的 next action/summary 标记 superseded；渲染器只展示最新未 superseded 的状态。
- 结构化验收证据：`command`, `cwd/workspace`, `exit_code`, `observed_at`, `artifact_paths`, `artifact_hashes`, `verification_status(passed|failed|not-run|stale)`。
- 对本地文件证据，在恢复/面板刷新时只做廉价存在性/hash 检查；变化或缺失则标记 stale。命令证据不自动执行，提供“重新验证”按钮并清楚说明会执行什么命令。
- 不把历史 passed 文本视为当前事实；恢复文本写成“曾于…通过，当前状态：stale/not rechecked”。

验收：修改 `hello.txt` 后 evidence 由 passed 变 stale；重新验证才回到 passed；无命令或受限目录时明确 not-run/failed。

## 6. R04：恢复包时效与上下文预算

先通过 R00 确认 runtime-context 在同会话普通回合、retry、resume 和 compact 的确切行为，然后：

- 生成稳定 `recovery_fingerprint`（task/contract revision、latest checkpoint、freshness、pending queue）。
- 新会话、resume、compact、fingerprint 改变：注入完整、字段级裁剪的恢复包。
- 普通同会话且 fingerprint 未变：若 Harness 保留 runtime context，注入空/极短锚点；若不保留，则保留不超过预算的最小锚点。不得凭源码推断，必须捕获最终请求验证。
- 完整包保留 objective、confirmed constraints、current state + freshness、next action、pending/deferred 状态和 conflict rule；任何裁剪不截断 Unicode/JSON。
- 增加 `last_verified_at` 和来源类型（user-confirmed / tool-observed / unconfirmed fallback），避免旧记忆伪装成当前用户指令。

验收：连续回合 token 增量、三次 compact、overflow retry、内容变更后 refresh、超大历史都检查最终模型请求。

## 7. R05：工作区自动读取完成验证

dev.3 已移除手动输入并增加 Host `workspace` Remote，但尚未完成真实 Desktop 验证。

- 单个活动会话：面板自动显示 `workingDirectory.ensure(agent)` 的已确认路径，初始化/刷新/写入都使用该路径。
- 两个不同项目窗口：每个面板只读取各自当前 Client session 的路径；任何无法映射 session 的情况显示可行动错误，不能使用缓存路径。
- 无 workspace 的欢迎页/空会话：面板显示“在项目会话中打开”，不建库、不抛 Host 异常。

若 R00 无法获得 Client 当前 session id，dev.3 的“唯一活动会话”策略只能作为单窗口临时兼容，必须在 UI 标注限制，不能宣称多窗口安全。

## 8. R06：回归、安装与发布门槛

- 每个 R01–R05 条目先写失败测试，再实现；运行 `npm run check`、`npm test`、包内容检查。
- 使用隔离 profile 重新安装新 `.tgz`，验证不会出现 `cannot get property "config" without inject`。
- 真实验证前说明预计模型调用次数并取得授权：新 session、resume、两任务选择、/compact、受控 overflow、A/B stale writer、DB 写失败、只读目录、禁用/卸载。
- README 只写实际通过的验证；dev tag 与候选包版本一一对应，禁止同版本重打不同内容的 tgz。
- 只有 R01–R05 全部通过自动化和真实 profile 验证后，才创建 `0.3.0-rc.1`；未经明确授权不创建 GitHub Release 或覆盖正式 profile。

## 9. 建议实施顺序

1. R00（接口证据与复现）；
2. R01（续接写入与 UI 未保存反馈）；
3. R02（多任务绑定）；
4. R03（验证时效）；
5. R04（最终请求/压缩）；
6. R05（真实多窗口工作区）；
7. R06（候选包）。

不要先扩大 UI；“恢复后可安全写入”是阻塞问题，R01 未通过前不得把任何 dev 构建宣传为可用长期记忆。

## 10. 新窗口续接指令

```text
请继续实施 D:\practice\deepseek-memory-plugin\docs\dsh-longtime-memory-v0.3-remediation-plan.md。

先完整读取该计划、D:\practice\deepseek-memory-plugin\docs\dsh-longtime-memory-v0.3-plan.md，以及当前 git status / HEAD / 已安装 Harness 版本。当前远端基线是 375cd864467955f012217e9014b285dfc1992ec2；工作树可能有未提交的 0.3.0-dev.3 自动工作区读取改动（CHANGELOG.md、client.js、package*.json、src/service.js、test/client.test.js），必须保留，不能 reset/checkout 覆盖。不要假设任何 remediation 批次已完成。

从 R00 开始：在隔离 profile 与临时数据库副本复现恢复会话的 LEASE_CONFLICT，核对实际 Harness session/Client workspace 接口。保护 .deepseek-memory 用户数据，不让测试临时目录位于项目根。先实现 R01 的安全续接写入、租约可读状态、deferred queue 和 GUI 未保存反馈，再推进多任务、时效验证、恢复预算和工作区多窗口验证。真实模型/new-session/compact/overflow 调用前说明预计调用次数并取得用户授权。每批写测试、运行 check/test、更新记录；不要创建正式 tag、Release 或覆盖正式 Desktop profile。
```
