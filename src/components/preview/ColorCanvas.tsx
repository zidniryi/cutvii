import { useEffect, useRef } from "react";
import type { Lut } from "@/timeline/color";

const VERT = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

/**
 * The colour table applied exactly as FFmpeg's \`lut3d\` applies it in the export: tetrahedral interpolation
 * between the table's points (read one by one, never the GPU's own filtering), and the fraction cut off
 * instead of rounded when going back to 8 bits. Measured in the 6p spike: at most 1 level of 255 apart, on
 * fewer than 0.001 % of values. Do not "simplify" either step.
 */
const FRAG = `#version 300 es
precision highp float; precision highp sampler3D; precision highp sampler2D;
uniform sampler2D src; uniform sampler3D lut; uniform float size;
in vec2 uv; out vec4 o;
vec3 at(ivec3 i){ return texelFetch(lut, i, 0).rgb; }
void main(){
  vec4 s = texture(src, uv);
  vec3 p = clamp(s.rgb, 0.0, 1.0) * (size - 1.0);
  vec3 f0 = min(floor(p), vec3(size - 2.0));
  ivec3 i = ivec3(f0);
  vec3 d = p - f0;
  vec3 c000 = at(i); vec3 c111 = at(i + ivec3(1));
  vec4 w; ivec3 a1; ivec3 a2;
  if (d.r > d.g) {
    if (d.g > d.b) { w = vec4(1.0 - d.r, d.r - d.g, d.g - d.b, d.b); a1 = ivec3(1,0,0); a2 = ivec3(1,1,0); }
    else if (d.r > d.b) { w = vec4(1.0 - d.r, d.r - d.b, d.b - d.g, d.g); a1 = ivec3(1,0,0); a2 = ivec3(1,0,1); }
    else { w = vec4(1.0 - d.b, d.b - d.r, d.r - d.g, d.g); a1 = ivec3(0,0,1); a2 = ivec3(1,0,1); }
  } else if (d.b > d.g) { w = vec4(1.0 - d.b, d.b - d.g, d.g - d.r, d.r); a1 = ivec3(0,0,1); a2 = ivec3(0,1,1); }
  else if (d.b > d.r) { w = vec4(1.0 - d.g, d.g - d.b, d.b - d.r, d.r); a1 = ivec3(0,1,0); a2 = ivec3(0,1,1); }
  else { w = vec4(1.0 - d.g, d.g - d.r, d.r - d.b, d.b); a1 = ivec3(0,1,0); a2 = ivec3(1,1,0); }
  vec3 r = clamp(w.x * c000 + w.y * at(i + a1) + w.z * at(i + a2) + w.w * c111, 0.0, 1.0);
  r = (floor(r * 255.0) + 0.25) / 255.0;
  o = vec4(r * s.a, s.a);
}`;

/** The longer side of the drawing surface is capped; larger sources are scaled down for the preview only. */
const MAX_SIDE = 1920;

type Source = HTMLVideoElement | HTMLImageElement;

function sourceSize(el: Source): [number, number] | null {
  if (el instanceof HTMLVideoElement) {
    return el.readyState >= 2 && el.videoWidth > 0 ? [el.videoWidth, el.videoHeight] : null;
  }
  return el.complete && el.naturalWidth > 0 ? [el.naturalWidth, el.naturalHeight] : null;
}

interface Gl {
  gl: WebGL2RenderingContext;
  sizeUniform: WebGLUniformLocation | null;
  srcTexture: WebGLTexture | null;
  lutTexture: WebGLTexture | null;
}

function setup(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext?.("webgl2", { antialias: false, premultipliedAlpha: true });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const program = gl.createProgram();
  const vert = compile(gl.VERTEX_SHADER, VERT);
  const frag = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!program || !vert || !frag) return null;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  // the picture goes in as it is: no colour conversion, no premultiplying on upload
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const srcTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  for (const [name, value] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ]) {
    gl.texParameteri(gl.TEXTURE_2D, name, value);
  }
  const lutTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTexture);
  for (const name of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
    gl.texParameteri(gl.TEXTURE_3D, name, gl.NEAREST);
  }
  for (const name of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
    gl.texParameteri(gl.TEXTURE_3D, name, gl.CLAMP_TO_EDGE);
  }
  gl.uniform1i(gl.getUniformLocation(program, "src"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "lut"), 1);
  return { gl, sizeUniform: gl.getUniformLocation(program, "size"), srcTexture, lutTexture };
}

/**
 * The picture of `source` with a colour table applied, drawn over that element (which stays in place: a
 * video keeps decoding there). `source` must be loaded with CORS (`crossOrigin="anonymous"`), or the
 * browser will not let a shader read it. If WebGL 2 is not available nothing is drawn and the ungraded
 * picture underneath stays visible.
 */
export function ColorCanvas({
  source,
  lut,
  live,
  style,
  className,
}: {
  source: () => Source | null;
  lut: Lut;
  /** Redraw every frame (video). A still is redrawn when it or the table changes. */
  live: boolean;
  style?: React.CSSProperties;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef<Gl | null>(null);
  const getSource = useRef(source);
  useEffect(() => {
    getSource.current = source;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    state.current = setup(canvas);
    return () => {
      state.current?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      state.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = state.current;
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const { gl } = ctx;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, ctx.lutTexture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.table);
    gl.uniform1f(ctx.sizeUniform, lut.size);

    let raf = 0;
    let stopped = false;
    const draw = () => {
      const el = getSource.current();
      const size = el && sourceSize(el);
      if (el && size) {
        const scale = Math.min(1, MAX_SIDE / Math.max(size[0], size[1]));
        const [w, h] = [Math.max(1, Math.round(size[0] * scale)), Math.max(1, Math.round(size[1] * scale))];
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        try {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, ctx.srcTexture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
          gl.viewport(0, 0, w, h);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          canvas.dataset.drawn = "true";
        } catch {
          // the element is not readable yet (still loading with CORS): the next frame tries again
        }
      }
      if (!stopped && (live || canvas.dataset.drawn !== "true")) raf = requestAnimationFrame(draw);
    };
    delete canvas.dataset.drawn;
    draw();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [lut, live]);

  return (
    <canvas ref={canvasRef} aria-hidden data-testid="color-canvas" className={className} style={style} />
  );
}
