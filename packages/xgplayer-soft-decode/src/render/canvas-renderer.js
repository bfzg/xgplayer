import { describeFrame, resolvePixFmt, slicePlane } from './pixel-formats'

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_y;
uniform sampler2D u_u;
uniform sampler2D u_v;
uniform int u_mode;
uniform int u_fullRange;
uniform int u_swizzle;
uniform int u_swapUV;

void main() {
  if (u_mode == 3) {
    vec4 c = texture2D(u_y, v_uv);
    if (u_swizzle == 1) c = c.bgra;
    gl_FragColor = c;
    return;
  }
  float y = texture2D(u_y, v_uv).r;
  vec2 uv;
  if (u_mode == 1) {
    uv = texture2D(u_u, v_uv).rg;
    // NV21 stores the pair as V,U, so the two components trade places.
    if (u_swapUV == 1) uv = uv.yx;
  } else if (u_mode == 2) {
    uv = vec2(0.5, 0.5);
  } else {
    uv = vec2(texture2D(u_u, v_uv).r, texture2D(u_v, v_uv).r);
  }
  if (u_fullRange == 0) {
    y = (y - 0.062745098) * 1.164383562;
    uv = (uv - 0.501960784) * 1.138392857;
  } else {
    uv = uv - 0.5;
  }
  vec3 rgb = mat3(1.0, 1.0, 1.0, 0.0, -0.344136, 1.772, 1.402, -0.714136, 0.0) * vec3(y, uv.x, uv.y);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`[xgplayer-soft-decode] shader compile failed: ${log}`)
  }
  return shader
}

function createProgram(gl) {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      `[xgplayer-soft-decode] program link failed: ${gl.getProgramInfoLog(program)}`
    )
  }
  return program
}

/** One texture unit per plane, so a sampler always reads its own texture. */
const SAMPLER_UNIT = { y: 0, u: 1, v: 2 }

function createTexture(gl, unit) {
  const texture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

const TEXTURE_FORMAT = {
  luma: 'LUMINANCE',
  chroma: 'LUMINANCE',
  'chroma-pair': 'LUMINANCE_ALPHA',
  rgba: 'RGBA'
}

/**
 * Upload one plane into the texture bound to `unit`.
 *
 * `state.size` remembers what the texture currently holds, so a steady stream
 * only pays for `texSubImage2D`; reallocating the storage on every picture is
 * measurable at 1440p, where three planes are about 7 MB per frame.
 */
function uploadPlane(gl, texture, plane, data, unit, state) {
  if (!data) return false
  const format = gl[TEXTURE_FORMAT[plane.kind] || 'LUMINANCE']
  const size = plane.width + 'x' + plane.height + ':' + format
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  if (state.size === size) {
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      plane.width,
      plane.height,
      format,
      gl.UNSIGNED_BYTE,
      data
    )
    return true
  }
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    format,
    plane.width,
    plane.height,
    0,
    format,
    gl.UNSIGNED_BYTE,
    data
  )
  state.size = size
  return true
}

function createWebGLRenderer(canvas, options) {
  const gl =
    canvas.getContext('webgl', { premultipliedAlpha: false, alpha: false }) ||
    canvas.getContext('experimental-webgl', { premultipliedAlpha: false, alpha: false })
  if (!gl) return null

  const program = createProgram(gl)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    gl.STATIC_DRAW
  )
  const loc = {
    pos: gl.getAttribLocation(program, 'a_pos'),
    y: gl.getUniformLocation(program, 'u_y'),
    u: gl.getUniformLocation(program, 'u_u'),
    v: gl.getUniformLocation(program, 'u_v'),
    mode: gl.getUniformLocation(program, 'u_mode'),
    fullRange: gl.getUniformLocation(program, 'u_fullRange'),
    swizzle: gl.getUniformLocation(program, 'u_swizzle'),
    swapUV: gl.getUniformLocation(program, 'u_swapUV')
  }
  gl.useProgram(program)
  gl.enableVertexAttribArray(loc.pos)
  gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0)
  gl.uniform1i(loc.y, SAMPLER_UNIT.y)
  gl.uniform1i(loc.u, SAMPLER_UNIT.u)
  gl.uniform1i(loc.v, SAMPLER_UNIT.v)

  const textures = [
    createTexture(gl, SAMPLER_UNIT.y),
    createTexture(gl, SAMPLER_UNIT.u),
    createTexture(gl, SAMPLER_UNIT.v)
  ]
  const uploads = [{}, {}, {}]
  const modeCode = { yuv420p: 0, nv12: 1, gray: 2, rgba: 3 }
  const pixFmt = resolvePixFmt(options.pixelFormats)

  return {
    kind: 'webgl',
    render(frame) {
      const described = describeFrame(frame.format, frame.width, frame.height, pixFmt)
      if (!described) return false
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width
        canvas.height = frame.height
      }
      gl.viewport(0, 0, canvas.width, canvas.height)
      let uploaded = 0
      described.planes.forEach((plane, index) => {
        const data = slicePlane(frame, index, plane)
        if (uploadPlane(gl, textures[index], plane, data, index, uploads[index])) {
          uploaded += 1
        }
      })
      if (uploaded < described.planes.length) return false
      gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNIT.y)
      gl.useProgram(program)
      gl.uniform1i(loc.mode, modeCode[described.mode] ?? 0)
      gl.uniform1i(loc.fullRange, described.range === 'full' ? 1 : 0)
      gl.uniform1i(loc.swizzle, described.swizzle === 'bgra' ? 1 : 0)
      gl.uniform1i(loc.swapUV, described.swapUV ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      return true
    },
    destroy() {
      textures.forEach((texture) => gl.deleteTexture(texture))
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    }
  }
}

function toRgba(described, frame) {
  const planes = described.planes.map((plane, index) => slicePlane(frame, index, plane))
  const { width, height } = frame
  const out = new Uint8ClampedArray(width * height * 4)
  const full = described.range === 'full'
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)
  const yScale = full ? 1 : 255 / 219
  const yOffset = full ? 0 : -16

  const luma = planes[0]
  const chromaWidth = described.planes[1]?.width || 1
  const chromaHeight = described.planes[1]?.height || 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const yi = y * width + x
      const Y = clamp((luma[yi] + yOffset) * yScale)
      let U = 128
      let V = 128
      if (described.mode === 'yuv420p') {
        const ci =
          Math.min(chromaHeight - 1, y >> 1) * chromaWidth +
          Math.min(chromaWidth - 1, x >> 1)
        U = planes[1][ci]
        V = planes[2][ci]
      } else if (described.mode === 'nv12') {
        const ci =
          (Math.min(chromaHeight - 1, y >> 1) * chromaWidth +
            Math.min(chromaWidth - 1, x >> 1)) *
          2
        U = planes[1][ci]
        V = planes[1][ci + 1]
      }
      if (full) {
        U -= 128
        V -= 128
      } else {
        U = (U - 128) * (255 / 224)
        V = (V - 128) * (255 / 224)
      }
      const o = yi * 4
      out[o] = clamp(Y + 1.402 * V)
      out[o + 1] = clamp(Y - 0.344136 * U - 0.714136 * V)
      out[o + 2] = clamp(Y + 1.772 * U)
      out[o + 3] = 255
    }
  }
  return out
}

function create2DRenderer(canvas) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const pixFmt = resolvePixFmt()
  return {
    kind: '2d',
    render(frame) {
      const described = describeFrame(frame.format, frame.width, frame.height, pixFmt)
      if (!described) return false
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width
        canvas.height = frame.height
      }
      if (described.mode === 'rgba') {
        const plane = described.planes[0]
        const bytes = slicePlane(frame, 0, plane)
        const image = new ImageData(
          new Uint8ClampedArray(bytes),
          plane.width,
          plane.height
        )
        if (described.swizzle === 'bgra') {
          for (let i = 0; i < image.data.length; i += 4) {
            const b = image.data[i]
            image.data[i] = image.data[i + 2]
            image.data[i + 2] = b
          }
        }
        ctx.putImageData(image, 0, 0)
        return true
      }
      const rgba = toRgba(described, frame)
      ctx.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0)
      return true
    },
    destroy() {}
  }
}

/**
 * Build a canvas renderer. WebGL is preferred because it keeps the YUV -> RGB
 * conversion on the GPU; a 2D software path keeps things working on the rare
 * device without WebGL.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 * @param {{pixelFormats?: Record<string, number>, draw?: (frame: any) => boolean}} [options]
 */
export function createCanvasRenderer(canvas, options = {}) {
  if (!canvas) return null
  let renderer = null
  try {
    renderer = createWebGLRenderer(canvas, options)
  } catch {
    renderer = null
  }
  if (!renderer) renderer = create2DRenderer(canvas)
  return renderer
}
