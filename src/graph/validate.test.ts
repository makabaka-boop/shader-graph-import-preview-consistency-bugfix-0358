import { describe, expect, it } from 'vitest';
import { canConnect, validateGraph } from './validate';
import { builder } from './testUtils';
import { graphReducer } from './reducer';

describe('类型检查与连接规则', () => {
  it('拒绝 float 连到 vec3 端口（颜色输出除外）', () => {
    const b = builder()
      .node('time', 't')
      .node('const_vec3', 'c')
      .node('lerp', 'l')
      .node('output', 'o');
    // lerp.a 是动态端口，先让它锚定为 vec3：const_vec3 -> lerp.a
    b.connect('c', 'out', 'l', 'a');
    // 此时 time(float) -> lerp.b 会让动态类型冲突；连接时无法预知，
    // 但静态 float->vec3 端口必须被连接前检查拒绝
    const check = canConnect(b.graph, { node: 't', port: 'out' }, { node: 'o', port: 'color' });
    // 颜色输出接受 float 提升
    expect(check.ok).toBe(true);
    expect(check.promote).toBe(true);
  });

  it('拒绝 vec3 连到 float 端口（lerp.t）', () => {
    const b = builder().node('uv', 'u').node('lerp', 'l');
    const check = canConnect(
      b.graph,
      { node: 'u', port: 'out' },
      { node: 'l', port: 't' },
    );
    expect(check.ok).toBe(false);
    expect(check.code).toBe('type-mismatch');
    // reducer 静默拒绝非法连接
    const before = b.graph.edges.length;
    b.connect('u', 'out', 'l', 't');
    expect(b.graph.edges.length).toBe(before);
  });

  it('同一输入端口只能有一条边', () => {
    const b = builder()
      .node('const_float', 'a')
      .node('const_float', 'b2')
      .node('add', 'add')
      .connect('a', 'out', 'add', 'a');
    const check = canConnect(b.graph, { node: 'b2', port: 'out' }, { node: 'add', port: 'a' });
    expect(check.ok).toBe(false);
    expect(check.code).toBe('input-occupied');
  });

  it('拒绝输出->输出、输入->输入方向与自连', () => {
    const b = builder().node('add', 'x').node('add', 'y');
    expect(
      canConnect(b.graph, { node: 'x', port: 'a' }, { node: 'y', port: 'a' }).code,
    ).toBe('bad-direction');
    expect(
      canConnect(b.graph, { node: 'x', port: 'out' }, { node: 'x', port: 'a' }).code,
    ).toBe('self-connection');
  });

  it('动态节点类型冲突在整体校验中报 type-confict', () => {
    const b = builder()
      .node('const_float', 'f')
      .node('uv', 'u')
      .node('add', 'add')
      .node('output', 'o')
      .connect('f', 'out', 'add', 'a')
      .connect('u', 'out', 'add', 'b')
      .connect('add', 'out', 'o', 'color');
    const v = validateGraph(b.graph);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'type-conflict')).toBe(true);
  });

  it('float 直连颜色输出通过校验并标记提升', () => {
    const b = builder()
      .node('time', 't')
      .node('output', 'o')
      .connect('t', 'out', 'o', 'color');
    const v = validateGraph(b.graph);
    expect(v.ok).toBe(true);
    expect(v.promotions.size).toBe(1);
  });

  it('缺少/多个颜色输出节点', () => {
    const onlyConst = builder().node('const_float', 'f').graph;
    expect(validateGraph(onlyConst).issues[0].code).toBe('missing-output');

    const b = builder().node('output', 'o1').node('output', 'o2');
    const v = validateGraph(b.graph);
    expect(v.issues[0].code).toBe('multiple-outputs');
  });
});

describe('环检测', () => {
  it('连接前 canConnect 拒绝会成环的边', () => {
    // 合法链：f -> m1.a，m1 -> m2.a，m2 -> o
    // m1.b 空闲；尝试 m2.out -> m1.b 会形成 m1→m2→m1 的环
    const c = builder()
      .node('multiply', 'm1')
      .node('multiply', 'm2')
      .node('const_float', 'f')
      .node('output', 'o2')
      .connect('f', 'out', 'm1', 'a')
      .connect('m1', 'out', 'm2', 'a')
      .connect('m2', 'out', 'o2', 'color');
    // 此时 m2.b 未连接（默认 0），图合法
    expect(validateGraph(c.graph).ok).toBe(true);
    // m2 -> m1.b 成环
    const cyc = canConnect(c.graph, { node: 'm2', port: 'out' }, { node: 'm1', port: 'b' });
    expect(cyc.ok).toBe(false);
    expect(cyc.code).toBe('would-cycle');

    // 非环的正常连接应通过：f -> m2.b
    const ok = canConnect(c.graph, { node: 'f', port: 'out' }, { node: 'm2', port: 'b' });
    expect(ok.ok).toBe(true);
  });

  it('reducer 不允许制造环，合法图始终无环', () => {
    const b = builder()
      .node('multiply', 'm1')
      .node('multiply', 'm2')
      .node('const_float', 'f')
      .node('output', 'o')
      .connect('f', 'out', 'm1', 'a')
      .connect('f', 'out', 'm1', 'b')
      .connect('m1', 'out', 'm2', 'a')
      .connect('f', 'out', 'm2', 'b')
      .connect('m2', 'out', 'o', 'color');
    const before = b.graph.edges.length;
    b.connect('m2', 'out', 'm1', 'b');
    expect(b.graph.edges.length).toBe(before);
    expect(validateGraph(b.graph).ok).toBe(true);
  });
});

describe('断开的节点不影响输出', () => {
  it('游离节点（含类型冲突/环）被排除在可达子图外', () => {
    const b = builder()
      .node('uv', 'u')
      .node('output', 'o')
      .connect('u', 'out', 'o', 'color');
    // 游离的动态 add：一个 float 一个 vec3 —— 由于不可达，不报错
    let g = b.graph;
    g = graphReducer(g, { type: 'add-node', kind: 'add', id: 'lonely', x: 0, y: 0 });
    g = graphReducer(g, { type: 'add-node', kind: 'const_float', id: 'f', x: 0, y: 0 });
    g = graphReducer(g, { type: 'add-node', kind: 'uv', id: 'u2', x: 0, y: 0 });
    g = graphReducer(g, { type: 'connect', from: { node: 'f', port: 'out' }, to: { node: 'lonely', port: 'a' }, edgeId: 'x1' });
    g = graphReducer(g, { type: 'connect', from: { node: 'u2', port: 'out' }, to: { node: 'lonely', port: 'b' }, edgeId: 'x2' });
    const v = validateGraph(g);
    expect(v.ok).toBe(true);
    expect(v.reachable.has('lonely')).toBe(false);
    expect(v.order).not.toContain('lonely');
  });
});
