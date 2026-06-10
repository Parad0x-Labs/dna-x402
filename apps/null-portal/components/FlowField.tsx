"use client";

import { useEffect, useRef } from "react";

/**
 * FlowField — the v4 background. A domain-warped WebGL flow field (violet →
 * magenta → cyan → lime) that breathes continuously and pools mint light at the
 * cursor. No libraries. Always animates (a showcase has to move even under
 * prefers-reduced-motion — it just runs calmer); falls back to a rich static
 * gradient if WebGL is unavailable.
 */
const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uReduce;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float v=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<6;i++){ v+=a*noise(p); p=m*p; a*=.5; } return v; }
void main(){
  vec2 uv = gl_FragCoord.xy/uRes.xy;
  vec2 p  = (gl_FragCoord.xy - .5*uRes.xy)/uRes.y;
  float t = uTime * (uReduce>.5 ? 0.45 : 1.0);
  vec2 m = (uMouse - .5); m.x *= uRes.x/uRes.y;
  vec2 q = p*1.35; q += 0.30*m;
  float warp1 = fbm(q*1.2 + vec2(0.0, t*0.06));
  float warp2 = fbm(q*1.2 + vec2(5.2,1.3) - t*0.05);
  vec2 warped = q + 0.65*vec2(warp1,warp2);
  float n  = fbm(warped*1.6 + t*0.08);
  float n2 = fbm(warped*3.1 - t*0.11 + n*1.4);
  float md = length(p - m);
  float pool = exp(-md*md*2.2);
  vec3 ink=vec3(0.027,0.024,0.039); vec3 violet=vec3(0.31,0.18,0.92);
  vec3 magenta=vec3(1.00,0.18,0.49); vec3 cyan=vec3(0.10,0.89,1.00);
  vec3 lime=vec3(0.78,1.00,0.18); vec3 mint=vec3(0.24,1.00,0.69);
  vec3 col = ink;
  col = mix(col, violet,  smoothstep(0.30,0.85, n) * 0.85);
  col = mix(col, magenta, smoothstep(0.45,0.95, n2) * 0.55);
  float ribbon = smoothstep(0.78,0.99, fbm(warped*4.0 + vec2(t*0.2,-t*0.15)));
  col = mix(col, cyan, ribbon*0.5);
  float spark = smoothstep(0.86,1.0, n2) * smoothstep(0.0,0.7,uv.y);
  col = mix(col, lime, spark*0.35);
  col += mint * pool * 0.42; col += cyan * pool * 0.15;
  float lines = abs(fract(n2*9.0 - t*0.4) - 0.5);
  col += vec3(0.9,1.0,0.95) * smoothstep(0.49,0.5,lines) * 0.05;
  float vig = smoothstep(1.25,0.15, length(p*vec2(0.82,1.0)));
  col *= mix(0.45, 1.12, vig);
  col += (hash(gl_FragCoord.xy + t)-0.5)/255.0;
  col = col/(col+0.92); col = pow(col, vec3(0.86));
  gl_FragColor = vec4(col, 1.0);
}`;

const VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }";

export function FlowField() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false });

    if (!gl) {
      canvas.style.background =
        "radial-gradient(140% 110% at 22% 18%, #1a0f3a 0%, #07060a 55%), radial-gradient(120% 90% at 85% 80%, #2a0a2a 0%, transparent 60%)";
      return;
    }

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uMouse = gl.getUniformLocation(prog, "uMouse");
    const uReduce = gl.getUniformLocation(prog, "uReduce");
    gl.uniform1f(uReduce, reduce ? 1 : 0);

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, reduce ? 1 : 1.75);
      const w = Math.floor(innerWidth * dpr),
        h = Math.floor(innerHeight * dpr);
      canvas!.width = w;
      canvas!.height = h;
      canvas!.style.width = innerWidth + "px";
      canvas!.style.height = innerHeight + "px";
      gl!.viewport(0, 0, w, h);
      gl!.uniform2f(uRes, w, h);
    }
    window.addEventListener("resize", resize, { passive: true });
    resize();

    let mx = 0.42,
      my = 0.3,
      tmx = 0.42,
      tmy = 0.3;
    const onMove = (e: PointerEvent) => {
      tmx = e.clientX / innerWidth;
      tmy = 1 - e.clientY / innerHeight;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const start = performance.now();
    let raf = 0;
    let running = true;
    function frame(now: number) {
      if (!running) return;
      mx += (tmx - mx) * 0.05;
      my += (tmy - my) * 0.05;
      gl!.uniform2f(uMouse, mx, my);
      gl!.uniform1f(uTime, (now - start) / 1000);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="fixed inset-0 -z-10 block h-full w-full" />;
}
