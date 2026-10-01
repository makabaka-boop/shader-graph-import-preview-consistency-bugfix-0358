import { describe, expect, it } from 'vitest';
import { buildForRevision } from './build';
import { builder } from './testUtils';

describe('Worker 构建：排序与代码生成', () => {
  it('按拓扑序生成：被依赖者先于依赖者', () => {
    // time ─┬─ multiply.a
    // const 0.25 ─ multiply.b ─ lerp.t
    // uv ─ lerp.b
    // const_vec3 ─ lerp.a ─ output
    const b = builder()
      .node('time', 't', 0, 0)
      .node('const_float', 'k', 0, 0)
      .node('multiply', 'm', 0, 0)
      .node('uv', 'u', 0, 0)
      .node('const_vec3', 'c', 0, 0)
      .node('lerp', 'l', 0, 0)
      .node('output', 'o', 0, 0)
      .connect('t', 'out', 'm', 'a')
      .connect('k', 'out', 'm', 'b')
      .connect('c', 'out', 'l', 'a')
      .connect('u', 'out', 'l', 'b')
      .connect('m', 'out', 'l', 't')
      .connect('l', 'out', 'o', 'color');
    // 参数 t 是 float 端口，m 必须解析为 float
    const out = buildForRevision(7, b.graph);
    expect(out.ok).toBe(true);
    expect(out.order).toContain('m');
    expect(out.order).toContain('l');
    expect(out.order.indexOf('t')).toBeLessThan(out.order.indexOf('m'));
    expect(out.order.indexOf('k')).toBeLessThan(out.order.indexOf('m'));
    expect(out.order.indexOf('m')).toBeLessThan(out.order.indexOf('l'));
    expect(out.order.indexOf('l')).toBeLessThan(out.order.indexOf('o'));
    // 输出节点排最后
    expect(out.order[out.order.length - 1]).toBe('o');
  });

  it('生成的 GLSL 中语句顺序与拓扑序一致，且包含 uniforms/UV', () => {
    const b = builder()
      .node('time', 't')
      .node('output', 'o')
      .connect('t', 'out', 'o', 'color');
    const out = buildForRevision(3, b.graph);
    expect(out.ok).toBe(true);
    const src = out.fragmentSource!;
    expect(src).toContain('uniform float uTime');
    expect(src).toContain('in vec2 vUv');
    expect(src).toContain('float n_t = uTime;');
    // float 提升为 vec3
    expect(src).toMatch(/vec3\(n_t, n_t, n_t\)/);
    expect(src.indexOf('n_t')).toBeLessThan(src.indexOf('finalColor'));
  });

  it('vec3 动态节点生成 vec3 运算，float 动态节点生成标量运算', () => {
    const v3 = builder()
      .node('uv', 'u')
      .node('const_vec3', 'c')
      .node('add', 'a')
      .node('output', 'o')
      .connect('u', 'out', 'a', 'a')
      .connect('c', 'out', 'a', 'b')
      .connect('a', 'out', 'o', 'color')
      .graph;
    const out3 = buildForRevision(1, v3);
    expect(out3.ok).toBe(true);
    expect(out3.fragmentSource).toMatch(/vec3 n_a =/);

    const f = builder()
      .node('time', 't')
      .node('const_float', 'k')
      .node('multiply', 'm')
      .node('output', 'o')
      .connect('t', 'out', 'm', 'a')
      .connect('k', 'out', 'm', 'b')
      .connect('m', 'out', 'o', 'color')
      .graph;
    const outf = buildForRevision(2, f);
    expect(outf.ok).toBe(true);
    expect(outf.fragmentSource).toMatch(/float n_m =/);
  });

  it('非法图不生成着色器并返回 issues', () => {
    const b = builder().node('uv', 'u'); // 无输出节点
    const out = buildForRevision(1, b.graph);
    expect(out.ok).toBe(false);
    expect(out.fragmentSource).toBeUndefined();
    expect(out.issues.length).toBeGreaterThan(0);
  });

  it('断开的节点不进入代码', () => {
    const b = builder()
      .node('uv', 'u')
      .node('output', 'o')
      .node('time', 'lonely')
      .connect('u', 'out', 'o', 'color');
    const out = buildForRevision(1, b.graph);
    expect(out.ok).toBe(true);
    expect(out.order).not.toContain('lonely');
    expect(out.fragmentSource).not.toContain('n_lonely');
  });
});
