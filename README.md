# 颜色图编辑器（React + TypeScript + WebGL2）

在浏览器中编辑不超过 **50 个节点** 的颜色图，Worker 负责排序与 GLSL 代码生成，
主线程编译 WebGL2 着色器并实时预览。

## 节点类型

| 节点 | 输入 | 输出 | 说明 |
| --- | --- | --- | --- |
| 常量 float | — | `float` | 标量常量 |
| 常量 vec3 | — | `vec3` | 三分量颜色常量 |
| UV | — | `vec3` | `vec3(vUv, 0)` |
| 时间 | — | `float` | uniform `uTime`（秒） |
| 加 / 乘 | `a`,`b`：float 或 vec3（必须同型） | 与输入同型 | 动态类型节点 |
| 插值 | `a`,`b`（同型）, `t:float` | 与 a/b 同型 | `mix(a,b,t)` |
| 颜色输出 | `color:vec3`（接受 float 自动提升） | — | 全图唯一 |

## 核心规则的实现位置

- **连接前类型检查**：`src/graph/validate.ts` 的 `canConnect`（端点/方向/自连/
  输入端口唯一/float↔vec3 兼容/是否成环）；`src/graph/reducer.ts` 的
  `connect` action 对未通过检查的连线直接拒绝（图状态不变、修订不递增）。
- **动态类型推断**：动态端口（加/乘/插值）共享类型变量（并查集），由具体
  float/vec3 数据源锚定；冲突报 `type-conflict`，无锚点报 `unresolved-type`。
- **输出可达子图与无环**：`validateGraph` 从颜色输出反向求可达集合，
  三色 DFS 检环，Kahn 算法产出拓扑序。**断开的节点（含其内部的类型冲突/环）
  完全不参与生成，不影响输出。**
- **Worker 排序与代码生成**：`src/graph/graphWorker.ts` →
  `buildForRevision`（`build.ts`，校验+排序）→ `generateFragmentShader`
  （`glslgen.ts`，严格按拓扑序逐行生成）。
- **代际（generation）防迟到覆盖**：revision 存在于导入文件中，两份不同的
  图可能恰好相同；页面还维护单调递增的 generation。每次结构性编辑、改参数、
  导入或上下文恢复都会产生新代际，Worker 请求/结果与 GLSL 编译结果一律携带
  generation，只有 `generation + revision` 同时匹配当前内容才会被采用。
  移动节点不递增 revision，也不产生新代际；其布局会立即更新到页面状态和后续
  导出，但不会重建着色器。`src/graph/pipeline.ts` 会丢弃所有落后或恢复前的
  迟到结果。
- **预览提交屏障**：GLSL 编译成功后只暂存 program；pipeline 完成最终代际校验
  才调用 `commit()` 上屏。过期结果调用 `discard()` 删除，不能先显示旧/新内容
  再回退。开始构建新图时旧 program 会立即撤下并清空画布，构建/编译期间显示
  遮罩，避免旧颜色冒充新图。
- **上下文丢失/恢复**：`src/webgl/renderer.ts` 监听
  `webglcontextlost`（`preventDefault` 以允许恢复）/`webglcontextrestored`。
  丢失时丢弃全部 GL 资源引用、停止 RAF，页面显示“预览已失效”遮罩，且任何迟到
  结果不得复活预览；恢复时清空旧 program 与画布、重建资源，并由 pipeline 用
  **新代际对当前图**重新走 Worker 生成 → GLSL 编译 → commit 的完整流程，
  绝不沿用或短暂重放旧画面。
- **导出一致性**：仅 `ready` 可导出；`captureExport` 在同一次调用中把当前页面
  图数据（结构化克隆，包含尚未递增 revision 的最新节点位置）、当前就绪状态
  对应的 GLSL 源码与画布 PNG 截图打包为一个 JSON 快照。快照不复用，因此移动
  节点后重新导出不会保留旧布局。

## 常用命令

```bash
npm install
npm run dev        # 开发
npm test           # 26 个测试（node 环境，WebGL 用最小 mock）
npm run build      # 类型检查 + 生产构建
```

## 测试覆盖（对应需求逐条）

- `src/graph/validate.test.ts` — 类型错误（float↔vec3、输入占用、方向、
  自连、动态类型冲突、float 提升）与环错误（连接前拒绝、reducer 不可产生环、
  断开节点不影响输出）。
- `src/graph/build.test.ts` — **生成顺序**：拓扑序的先于关系、输出排最后；
  GLSL 语句顺序、uniform/提升/标量与 vec3 变体；非法图不生成；断开节点不生成。
- `src/graph/pipeline.test.ts` — **迟到结果**：迟到的 Worker 结果与迟到的
  GLSL 编译结果都不能覆盖较新内容；非法图不触发编译；即使导入图与旧图
  revision 相同，也必须用新 generation 拒绝旧结果和旧编译；导出快照锁定当前
  内容；纯移动节点不重建，但导出包含最新布局。
- `src/webgl/context.test.ts` — **上下文恢复**：丢失标失效、迟到结果不复活、
  恢复后清空旧画面并重新编译当前内容（含丢失期间编辑后的最新内容）、恢复前
  排队的同 revision 编译结果不能短暂上屏。

## 操作

- 工具栏添加节点；从输出端口（右圆点）拖到输入端口（左圆点）连线；
  点击已有连线断开；节点右上角 × 删除；选中节点后在右侧检查器改参数。
- “模拟上下文丢失/恢复”按钮可手动演练上下文事件。
- “导出”下载的 JSON 中 `revision`、`graph`、`fragmentSource`、`dataUrl`
  在同一次导出中互相对应；`graph` 还包含当前页面上的最新节点位置。
