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
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform vec2 uGlow; uniform float uReduce;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float v=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<5;i++){ v+=a*noise(p); p=m*p; a*=.52; } return v; }
void main(){
  vec2 uv = gl_FragCoord.xy/uRes.xy;
  vec2 p  = (gl_FragCoord.xy - .5*uRes.xy)/uRes.y;
  float t = uTime * (uReduce>.5 ? 0.5 : 1.0);
  vec2 m = (uMouse - .5); m.x *= uRes.x/uRes.y;   // slow-drifting field
  vec2 g = (uGlow  - .5); g.x *= uRes.x/uRes.y;   // responsive cursor light
  vec2 q = p*1.3; q += 0.24*m;

  // STORM — two-stage domain warp = turbulent, swirling filaments
  float w1 = fbm(q*1.1 + vec2(0.0, t*0.085));
  float w2 = fbm(q*1.1 + vec2(5.2,1.3) - t*0.07);
  vec2 warped = q + 0.95*vec2(w1,w2);
  float w3 = fbm(warped*1.7 + vec2(t*0.13,-t*0.10));
  float w4 = fbm(warped*1.7 + vec2(-1.7,3.4) + t*0.11);
  warped += 0.55*vec2(w3,w4);

  float n  = fbm(warped*1.5 + t*0.10);
  float n2 = fbm(warped*2.9 - t*0.13 + n*1.6);
  float n3 = fbm(warped*5.6 + t*0.21 - n2*1.2);   // fine filament detail
  float md = length(p - g);
  float pool = exp(-md*md*2.0);

  vec3 ink=vec3(0.018,0.016,0.032); vec3 violet=vec3(0.34,0.18,0.98);
  vec3 magenta=vec3(1.00,0.16,0.48); vec3 cyan=vec3(0.08,0.92,1.00);
  vec3 lime=vec3(0.80,1.00,0.16); vec3 mint=vec3(0.24,1.00,0.69);
  vec3 col = ink;
  col = mix(col, violet,  smoothstep(0.24,0.80, n) * 0.95);
  col = mix(col, magenta, smoothstep(0.40,0.92, n2) * 0.70);
  float ribbon = smoothstep(0.70,0.97, fbm(warped*3.6 + vec2(t*0.26,-t*0.20)));
  col = mix(col, cyan, ribbon*0.60);
  float spark = smoothstep(0.82,1.0, n2) * smoothstep(0.0,0.7,uv.y);
  col = mix(col, lime, spark*0.45);
  // hot white-violet storm cores — bright filament crests
  float core = smoothstep(0.86,1.0, n3) * smoothstep(0.45,0.95, n2);
  col += vec3(0.95,0.92,1.0) * core * 0.55;
  col += mint * pool * 0.45; col += cyan * pool * 0.16;
  float lines = abs(fract(n2*10.0 - t*0.5) - 0.5);
  col += vec3(0.9,1.0,0.95) * smoothstep(0.48,0.5,lines) * 0.06;
  float vig = smoothstep(1.30,0.18, length(p*vec2(0.80,1.0)));
  col *= mix(0.36, 1.08, vig);
  col += (hash(gl_FragCoord.xy + t)-0.5)/255.0;
  col = col/(col+0.86); col = pow(col, vec3(0.83));   // filmic, a touch more contrast
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
    const uGlow = gl.getUniformLocation(prog, "uGlow");
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

    // Two trackers off one cursor target: the FIELD drifts in slow motion (heavy,
    // laggy — the nebula has inertia), while the cursor GLOW follows closely so
    // pointing still feels responsive.
    let fx = 0.42, fy = 0.3,   // field (slow)
      gx = 0.42, gy = 0.3,     // glow (fast)
      tmx = 0.42, tmy = 0.3;   // target
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
      fx += (tmx - fx) * 0.018; // slow-motion field drift (no sudden jerk)
      fy += (tmy - fy) * 0.018;
      gx += (tmx - gx) * 0.10;  // responsive cursor light
      gy += (tmy - gy) * 0.10;
      gl!.uniform2f(uMouse, fx, fy);
      gl!.uniform2f(uGlow, gx, gy);
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
