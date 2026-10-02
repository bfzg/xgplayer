/**
 * The WebGL painter is where a soft decoded frame becomes pixels, and the one
 * bug that a fake context catches for free is texture unit bookkeeping: three
 * planes need three units, because a sampler that points at an empty texture
 * reads zero chroma and the whole picture turns green.
 */
import { createCanvasRenderer } from '../src/render/canvas-renderer'

const GL = {
  TEXTURE0: 0x84c0,
  TEXTURE_2D: 0x0de1,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  LINEAR: 0x2601,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  CLAMP_TO_EDGE: 0x812f,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNPACK_FLIP_Y_WEBGL: 0x924c,
  UNSIGNED_BYTE: 0x1401,
  LUMINANCE: 0x1909,
  LUMINANCE_ALPHA: 0x190a,
  RGBA: 0x1908,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  TRIANGLES: 0x0004,
  FLOAT: 0x1406
}

function createFakeGL () {
  const uploads = []
  const uniforms = {}
  const binds = {}
  let active = 0
  let textures = 0
  const gl = {
    ...GL,
    uploads,
    uniforms,
    binds,
    getActive: () => active,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: (program, name) => ({ name }),
    useProgram: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    createTexture: () => ({ id: (textures += 1) }),
    deleteTexture: () => {},
    deleteBuffer: () => {},
    deleteProgram: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    viewport: () => {},
    drawArrays: () => {},
    activeTexture: (unit) => {
      active = unit - GL.TEXTURE0
    },
    bindTexture: (target, texture) => {
      binds[active] = texture
    },
    uniform1i: (location, value) => {
      uniforms[location.name] = value
    },
    texImage2D: (target, level, format, width, height, _border, _f, _t, data) => {
      uploads.push({ op: 'image', unit: active, format, width, height, texture: binds[active], length: data.length })
    },
    texSubImage2D: (target, level, x, y, width, height, format, _t, data) => {
      uploads.push({ op: 'sub', unit: active, format, width, height, texture: binds[active], length: data.length })
    }
  }
  return gl
}

function fakeCanvas (gl) {
  return {
    width: 300,
    height: 150,
    getContext: (type) => (type === 'webgl' ? gl : null)
  }
}

/** A packed yuv420p picture, exactly the shape `packFrame` produces. */
function frame420 (width, height, overrides = {}) {
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  const data = new Uint8Array(width * height + cw * ch * 2)
  data.fill(64, 0, width * height)
  data.fill(128, width * height, width * height + cw * ch)
  data.fill(128, width * height + cw * ch)
  return {
    width,
    height,
    format: 0,
    data,
    layout: [
      { offset: 0, size: width * height, plane: 0 },
      { offset: width * height, size: cw * ch, plane: 1 },
      { offset: width * height + cw * ch, size: cw * ch, plane: 2 }
    ],
    timestamp: 0,
    pts: 0,
    ...overrides
  }
}

describe('webgl canvas renderer', () => {
  test('uploads each plane to its own texture unit', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    expect(renderer.kind).toBe('webgl')
    expect(renderer.render(frame420(16, 8))).toBe(true)

    expect(gl.uploads.map((upload) => upload.unit)).toEqual([0, 1, 2])
    expect(new Set(gl.uploads.map((upload) => upload.texture.id)).size).toBe(3)
    expect(gl.uniforms.u_y).toBe(0)
    expect(gl.uniforms.u_u).toBe(1)
    expect(gl.uniforms.u_v).toBe(2)
    expect(gl.uniforms.u_mode).toBe(0)
    expect(gl.uniforms.u_fullRange).toBe(0)
    // Chroma is half size in both directions for 4:2:0.
    expect(gl.uploads[1].width).toBe(8)
    expect(gl.uploads[1].height).toBe(4)
    expect(gl.uploads[1].length).toBe(32)
  })

  test('full range pictures reach the shader as full range', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    renderer.render(frame420(16, 8, { format: 12 }))
    expect(gl.uniforms.u_fullRange).toBe(1)
  })

  test('a steady stream reuses the texture storage', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    const frame = frame420(16, 8)
    renderer.render(frame)
    renderer.render(frame)
    expect(gl.uploads.slice(0, 3).every((upload) => upload.op === 'image')).toBe(true)
    expect(gl.uploads.slice(3).every((upload) => upload.op === 'sub')).toBe(true)
    expect(gl.uploads.length).toBe(6)
  })

  test('a resolution change reallocates instead of sub-uploading the old size', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    renderer.render(frame420(16, 8))
    gl.uploads.length = 0
    renderer.render(frame420(32, 16))
    expect(gl.uploads.every((upload) => upload.op === 'image')).toBe(true)
  })

  test('the last active unit is the luma texture', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    renderer.render(frame420(16, 8))
    expect(gl.getActive()).toBe(0)
  })

  test('gray frames upload one plane and neutral chroma', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    const data = new Uint8Array(16 * 8)
    expect(
      renderer.render({
        width: 16,
        height: 8,
        format: 8,
        data,
        layout: [{ offset: 0, size: 128, plane: 0 }]
      })
    ).toBe(true)
    expect(gl.uploads.length).toBe(1)
    expect(gl.uniforms.u_mode).toBe(2)
  })

  test('nv21 swaps the interleaved pair in the shader', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    const data = new Uint8Array(16 * 8 + 8 * 4 * 2)
    expect(
      renderer.render({
        width: 16,
        height: 8,
        format: 24,
        data,
        layout: [
          { offset: 0, size: 128, plane: 0 },
          { offset: 128, size: 64, plane: 1 }
        ]
      })
    ).toBe(true)
    expect(gl.uniforms.u_mode).toBe(1)
    expect(gl.uniforms.u_swapUV).toBe(1)
    expect(gl.uploads[1].length).toBe(64)
  })

  test('a frame shorter than its description is refused, not half painted', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    const frame = frame420(16, 8)
    frame.data = frame.data.subarray(0, 100)
    expect(renderer.render(frame)).toBe(false)
    expect(gl.uploads.filter((upload) => upload.unit === 2).length).toBe(0)
  })

  test('an unknown pixel format paints nothing', () => {
    const gl = createFakeGL()
    const renderer = createCanvasRenderer(fakeCanvas(gl), {})
    expect(renderer.render(frame420(16, 8, { format: 999 }))).toBe(false)
    expect(gl.uploads.length).toBe(0)
  })

  test('the canvas is resized to the picture', () => {
    const gl = createFakeGL()
    const canvas = fakeCanvas(gl)
    const renderer = createCanvasRenderer(canvas, {})
    renderer.render(frame420(64, 32))
    expect(canvas.width).toBe(64)
    expect(canvas.height).toBe(32)
  })
})
