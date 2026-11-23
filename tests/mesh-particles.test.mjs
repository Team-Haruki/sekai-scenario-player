import assert from 'node:assert/strict';
import * as PIXI from 'pixi.js';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { FxInstance } from '../src/scenario/particles';

const constant = s => ({ m: 0, s });
const TRIANGLE = { verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], uvs: [[0, 0], [1, 0], [0, 1]], tris: [0, 1, 2] };
const CUBE = { builtin: 10202 };
const QUAD = { builtin: 10210 };

function effect({ mesh = 'm', meshData = TRIANGLE, psr = {}, ps = {}, im = {}, node = {}, material = {} } = {}) {
  return {
    name: 'test',
    roots: [0],
    nodes: [{
      name: 'emitter', active: 1, layer: 0, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], parent: -1, children: [],
      ...node,
      ps: {
        lengthInSec: 5, looping: 1, playOnAwake: 0,
        InitialModule: {
          startLifetime: constant(10), startSpeed: constant(0), startSize: constant(1), startSizeY: constant(1), startSizeZ: constant(1),
          startRotationX: constant(0), startRotationY: constant(0), startRotation: constant(0), startColor: { m: 0, max: [1, 1, 1, 1] },
          gravityModifier: constant(0), maxNumParticles: 1000, ...im,
        },
        ...ps,
      },
      psr: { m_RenderMode: 4, m_RenderAlignment: 0, m_MaxParticleSize: 0.5, pivot: [0, 0, 0], mesh, materials: ['mat'], ...psr },
    }],
    materials: { mat: { shader: 'Sekai/Particles/AlphaBlended', ...material } },
    sprites: {},
    meshes: { m: meshData },
    clips: {},
  };
}

function spawned(options, count = 1) {
  const fx = new FxInstance(effect(options), 'base');
  fx.update(0);
  const em = fx.emitterOf(0);
  for (let i = 0; i < count; i++) em.spawn();
  em.build(1);
  return { fx, em, geometry: em.mesh.geometry };
}
const data = (geometry, name) => [...geometry.getBuffer(name).data];
const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-3, `[${i}] ${v} != ${expected[i]}`));
};

const blankTexture = () => new PIXI.Texture(new PIXI.BaseTexture());
// PIXI's white texture and shader setup need a canvas, which Node does not have
beforeEach(() => {
  vi.spyOn(PIXI.settings.ADAPTER, 'createCanvas').mockReturnValue({ getContext: () => null });
  vi.spyOn(PIXI.Texture, 'WHITE', 'get').mockReturnValue(blankTexture());
});
afterEach(() => vi.restoreAllMocks());

test('a custom mesh draws its own vertices at one unit = 360 stage px', () => {
  const { geometry } = spawned();
  near(data(geometry, 'aVertexPosition'), [640, 360, 1000, 360, 640, 0]);
  assert.deepEqual([...geometry.getIndex().data], [0, 1, 2]);
});

test('the pivot and 3D size move and stretch the vertices', () => {
  const { geometry } = spawned({
    psr: { pivot: [0.5, 0, 0] },
    im: { size3D: 1, startSize: constant(2), startSizeY: constant(0.5), startSizeZ: constant(3) },
  });
  near(data(geometry, 'aVertexPosition'), [280, 360, 1000, 360, 280, 180]);
});

test('Unity v is flipped through uST so offsets stay correct', () => {
  const { em, geometry } = spawned({ material: { tex: undefined } });
  near(data(geometry, 'aTextureCoord'), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(em.mesh.shader.uniforms.uST, [1, -1, 0, 1]);
  em.st = [2, 3, 0.25, 0.5];
  em.build(1);
  assert.deepEqual(em.mesh.shader.uniforms.uST, [2, -3, 0.25, 0.5]);
});

test('a texture sheet tile maps the mesh UVs into that tile', () => {
  const { geometry } = spawned({
    ps: { UVModule: { enabled: 1, tilesX: 2, tilesY: 2, animationType: 0, cycles: 1, frameOverTime: constant(0.25), startFrame: constant(0) } },
  });
  // frame 1 = top-right tile: u in 0.5..1, Unity v in 0.5..1
  near(data(geometry, 'aTextureCoord'), [0.5, 0.5, 1, 0.5, 0.5, 1]);
});

test('a row-mode sheet picks the configured row', () => {
  const { geometry } = spawned({
    ps: { UVModule: { enabled: 1, tilesX: 2, tilesY: 2, animationType: 1, rowIndex: 1, cycles: 1, frameOverTime: constant(0), startFrame: constant(0) } },
  });
  near(data(geometry, 'aTextureCoord'), [0, 0, 0.5, 0, 0, 0.5]);
});

test('a cube draws all six faces at full size', () => {
  const { geometry } = spawned({ mesh: CUBE, im: { startSize: constant(9.66) } });
  const pos = data(geometry, 'aVertexPosition');
  assert.equal(pos.length, 24 * 2);
  assert.equal(geometry.getIndex().data.length, 36);
  const xs = pos.filter((_, i) => i % 2 === 0);
  near([Math.min(...xs), Math.max(...xs)], [640 - 1738.8, 640 + 1738.8]);
  // front and back faces cover the same screen area
  near(pos.slice(0, 8), pos.slice(8, 16));
});

test('X rotation turns a flat mesh edge-on under the orthographic camera', () => {
  const { geometry } = spawned({ im: { rotation3D: 1, startRotationX: constant(Math.PI / 2) } });
  near(data(geometry, 'aVertexPosition'), [640, 360, 1000, 360, 640, 360]);
});

test('Z rotation turns a mesh the same way as a billboard', () => {
  const { geometry } = spawned({ im: { rotation3D: 1, startRotation: constant(Math.PI / 2) } });
  // +x goes to screen-down, as the quad path does in y-down stage px
  near(data(geometry, 'aVertexPosition'), [640, 360, 640, 720, 1000, 360]);
});

test('a random rotation direction negates all three axes', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const { em } = spawned({
    im: { rotation3D: 1, randomizeRotationDirection: 1, startRotationX: constant(1), startRotationY: constant(2), startRotation: constant(3) },
  });
  const [p] = em.particles;
  assert.deepEqual([p.rx, p.ry, p.rot], [-1, -2, -3]);
});

test('separate-axis rotation over lifetime spins X and Y too', () => {
  const { em } = spawned({
    im: { rotation3D: 1 },
    ps: { RotationModule: { enabled: 1, separateAxes: 1, x: constant(1), y: constant(2), curve: constant(3) } },
  });
  em.step(0.5);
  const [p] = em.particles;
  near([p.rx, p.ry, p.rot], [0.5, 1, 1.5]);
});

test('only Local alignment follows the emitter rotation', () => {
  const quarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const view = spawned({ node: { rot: quarter } });
  near(data(view.geometry, 'aVertexPosition'), [640, 360, 1000, 360, 640, 0]);
  const local = spawned({ node: { rot: quarter }, psr: { m_RenderAlignment: 2 } });
  near(data(local.geometry, 'aVertexPosition'), [640, 360, 640, 0, 280, 360]);
});

test('a negative emitter scale mirrors the mesh', () => {
  const { geometry } = spawned({ node: { scale: [-1, 1, 1] } });
  near(data(geometry, 'aVertexPosition'), [640, 360, 280, 360, 640, 0]);
});

test('world-space particles keep their simulated position', () => {
  const { em, geometry } = spawned({ ps: { moveWithTransform: 1 } });
  em.particles[0].p = [90, 0, 0];
  em.build(1);
  near(data(geometry, 'aVertexPosition'), [700, 360, 1060, 360, 700, 0]);
});

test('size modules scale all three mesh axes', () => {
  const zMesh = { verts: [[0, 0, 0], [1, 1, 1], [0, 0, 1]], uvs: null, tris: [0, 1, 2] };
  const { geometry } = spawned({
    meshData: zMesh,
    im: { rotation3D: 1, startRotationX: constant(Math.PI / 2) },
    ps: { SizeModule: { enabled: 1, separateAxes: 1, curve: constant(2), y: constant(1), z: constant(0.5) } },
  });
  // X rotation brings z onto the screen's y axis
  near(data(geometry, 'aVertexPosition'), [640, 360, 1360, 540, 640, 540]);
});

test('size by speed scales a mesh', () => {
  const { geometry } = spawned({
    im: { startSpeed: constant(1) },
    ps: { SizeBySpeedModule: { enabled: 1, range: { x: 0, y: 1 }, curve: constant(0.5) } },
  });
  near(data(geometry, 'aVertexPosition'), [640, 360, 820, 360, 640, 180]);
});

test('colour over lifetime multiplies every vertex', () => {
  const { geometry } = spawned({
    im: { startColor: { m: 0, max: [1, 0.5, 0.5, 1] } },
    ps: { ColorModule: { enabled: 1, gradient: { m: 0, max: [0.5, 1, 0.5, 0.5] } } },
  });
  near(data(geometry, 'aColor').slice(0, 4), [0.5, 0.5, 0.25, 0.5]);
  near(data(geometry, 'aColor').slice(8), [0.5, 0.5, 0.25, 0.5]);
});

for (const [name, material, ps, expected] of [
  ['additive writes no alpha', { shader: 'Sekai/Particles/Additive' }, {}, 0],
  ['alpha blending keeps alpha', { shader: 'Sekai/Particles/AlphaBlended' }, {}, 1],
  ['Additive+AlphaBlend without custom data blends', { shader: 'Sekai/Particles/Additive+AlphaBlend' }, {}, 1],
]) {
  test(name, () => {
    const { geometry } = spawned({ material, ps });
    assert.deepEqual(data(geometry, 'aKeep'), [expected, expected, expected]);
  });
}

test('Additive+AlphaBlend reads Custom1.x per particle', () => {
  const { geometry } = spawned({
    material: { shader: 'Sekai/Particles/Additive+AlphaBlend' },
    psr: { m_UseCustomVertexStreams: 1, m_VertexStreams: '000103041f' },
    ps: { CustomDataModule: { enabled: 1, vector0_0: constant(1) } },
  });
  assert.deepEqual(data(geometry, 'aKeep'), [0, 0, 0]);
});

test('many mesh vertices switch to a 32-bit index', () => {
  const big = { verts: Array.from({ length: 300 }, () => [0, 0, 0]), uvs: null, tris: [0, 1, 299] };
  const small = spawned({ meshData: big }, 10);
  assert.ok(small.geometry.getIndex().data instanceof Uint16Array);
  const large = spawned({ meshData: big }, 300);
  const index = large.geometry.getIndex().data;
  assert.ok(index instanceof Uint32Array);
  assert.equal(index[index.length - 1], 299 * 300 + 299);
});

test('UVs past 1 turn on Repeat for that texture only', () => {
  const texture = blankTexture();
  vi.spyOn(PIXI.Texture, 'from').mockReturnValue(texture);
  const material = { tex: { _MainTex: { file: 'tex.png' } } };
  texture.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
  new FxInstance(effect({ material }), 'base-clamped');
  assert.equal(texture.baseTexture.wrapMode, PIXI.WRAP_MODES.CLAMP);
  const lightning = { ...TRIANGLE, uvs: [[0, 0], [1.5, 0], [0, 1]] };
  new FxInstance(effect({ material, meshData: lightning }), 'base-repeat');
  assert.equal(texture.baseTexture.wrapMode, PIXI.WRAP_MODES.REPEAT);
});

test('the built-in Quad and undecoded meshes stay on the quad path', () => {
  for (const options of [{ mesh: QUAD }, { meshData: { error: 'unreadable' } }]) {
    const { em, geometry } = spawned(options);
    assert.equal(em.shape, undefined);
    assert.equal(data(geometry, 'aVertexPosition').length, 8);
    assert.equal(geometry.getIndex().data.length, 6);
  }
});

test('an inherited size also scales the mesh depth', () => {
  const fx = new FxInstance(effect(), 'base');
  fx.update(0);
  const em = fx.emitterOf(0);
  const parent = em.spawn();
  parent.size = [2, 3, 4];
  const child = em.spawn(undefined, parent, 2);
  assert.deepEqual(child.size, [2, 3, 4]);
});
