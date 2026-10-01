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
- **构建代次（token）防迟到覆盖**：结构变化（节点种类/参数/连线，忽略坐标）
  使 `revision + 1` 并领取会话内单调递增、绝不重复的构建 token；移动节点既不
  递增修订也不更换 token。`src/graph/pipeline.ts` 对 Worker 结果与 GLSL 编译
  结果一律校验 `token === 当前代次`，落后的迟到结果（哪怕修订号恰好与新图相同）
  直接丢弃。这覆盖“导入一份同修订号的旧导出图”：修订号会撞号，token 不会。
- **编译结果两步上屏**：`renderer.compileFragment` 只把链接好的程序放入
  pending、不改变正在显示的画面；pipeline 确认 token 仍为当前代次后才调用
  `commitPending` 上屏。迟到编译因此不可能闪回旧颜色。
- **移动节点与导出布局**：任何图引用变化（含不递增修订的 move-node）都会同步
  到 pipeline；纯布局变化不重新生成/编译，但会失效导出缓存。`captureExport`
  仅在修订、GLSL、布局指纹三者都一致时才复用截图包，故导出的图布局永远跟页面一致。
- **上下文丢失/恢复**：`src/webgl/renderer.ts` 监听
  `webglcontextlost`（`preventDefault` 以允许恢复）/`webglcontextrestored`。
  丢失时丢弃全部 GL 资源引用（含 pending 程序与旧源码）、停止 RAF，页面显示
  “预览已失效”遮罩，且任何迟到结果不得复活预览；恢复时**只重建 GL 骨架、绝不
  自行重放旧源码**，并由 pipeline 以全新 token 对**当前图**重新走
  Worker 生成 → GLSL 编译 → 提交上屏的完整流程，同修订号的旧代次结果也无法重现。
- **导出一致性**：仅 `ready` 可导出；`captureExport` 把**同一就绪结果**的
  图数据（结构化克隆）、GLSL 源码与画布 PNG 截图原子打包为一个 JSON 快照。

## 常用命令

```bash
npm install
npm run dev        # 开发
npm test           # 27 个测试（node 环境，WebGL 用最小 mock）
npm run build      # 类型检查 + 生产构建
```

## 测试覆盖（对应需求逐条）

- `src/graph/validate.test.ts` — 类型错误（float↔vec3、输入占用、方向、
  自连、动态类型冲突、float 提升）与环错误（连接前拒绝、reducer 不可产生环、
  断开节点不影响输出）。
- `src/graph/build.test.ts` — **生成顺序**：拓扑序的先于关系、输出排最后；
  GLSL 语句顺序、uniform/提升/标量与 vec3 变体；非法图不生成；断开节点不生成。
- `src/graph/pipeline.test.ts` — **迟到结果**：迟到的 Worker 结果与迟到的
  GLSL 编译结果都不能覆盖较新代次（迟到编译连屏幕都上不了）；非法图不触发编译；
  导出快照锁定内容。**同修订号导入**：必须重新构建、旧代次结果一律丢弃、导出的是
  新图。**只移动节点**：不重建但导出布局跟随页面、布局不变时复用截图。
- `src/webgl/context.test.ts` — **上下文恢复**：丢失标失效、迟到结果不复活、
  恢复瞬间不重放旧程序、恢复后以新代次重建当前图（含丢失期间编辑后的最新修订）、
  恢复后同修订号旧代次结果不得重现旧预览。

## 操作

- 工具栏添加节点；从输出端口（右圆点）拖到输入端口（左圆点）连线；
  点击已有连线断开；节点右上角 × 删除；选中节点后在右侧检查器改参数。
- “模拟上下文丢失/恢复”按钮可手动演练上下文事件。
- “导出”下载的 JSON 中 `revision`、`graph`、`fragmentSource`、`dataUrl`
  必然属于同一修订。
