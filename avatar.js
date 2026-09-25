/* Cursor-tracking portrait
 *
 * Three renderers share one "where is the viewer looking" signal:
 *   1. Single portrait (WebGL): one front-facing image. Face landmarks drive a warp
 *      that turns the head a few degrees, moves the irises, blinks, lifts the brows
 *      and the corners of the mouth.
 *   2. Character sheet: a grid of the same face looking in N×M directions; we show the
 *      nearest frame, crossfade, and add a little parallax so steps never feel jumpy.
 *   3. Illustrated SVG rig: the placeholder shown until one of the above exists.
 *
 * Source order at load: this browser's saved upload → data-portrait → data-sprite → SVG.
 */
(() => {
  const el = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hero = el('hero'), stage = el('stage'), svg = el('avatar'), spriteCv = el('sprite'), glCv = el('portrait-gl'), nameEl = el('name');
  const STORE = 'cursor-portrait-v2';
  const FACE_API = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js';
  const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';

  /* ---------------- film grain ---------------- */
  try {
    const c = document.createElement('canvas'); c.width = c.height = 140;
    const x = c.getContext('2d'), d = x.createImageData(140, 140);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0);
    hero.style.setProperty('--grain', `url(${c.toDataURL()})`);
  } catch { /* decorative only */ }

  /* ---------------- where to look ---------------- */
  const pointer = { x: innerWidth * 0.35, y: innerHeight * 0.35, last: -1e9 };
  addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.last = performance.now(); }, { passive: true });
  addEventListener('pointerdown', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.last = performance.now(); }, { passive: true });

  // When nobody is moving the mouse (or on touch screens), glance around naturally.
  let glance = null;
  const GLANCES = [[0, 0], [0, 0], [-0.8, -0.2], [0.8, -0.2], [-0.5, 0.5], [0.5, 0.5], [0, -0.7], [0.3, 0]];
  function lookPoint(now, rect) {
    if (now - pointer.last < 5000) { glance = null; return pointer; }
    if (!glance || now > glance.until) {
      const g = GLANCES[Math.floor(Math.random() * GLANCES.length)];
      glance = {
        x: rect.left + rect.width / 2 + g[0] * innerWidth * 0.4,
        y: rect.top + rect.height * 0.34 + g[1] * innerHeight * 0.4,
        until: now + 1400 + Math.random() * 2200
      };
    }
    return glance;
  }
  // Direction from the face to the target, each axis in [-1, 1].
  function direction(now, rect, face = 0.34) {
    const t = lookPoint(now, rect);
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height * face;
    return {
      fx: clamp((t.x - cx) / Math.max(260, innerWidth * 0.36), -1, 1),
      fy: clamp((t.y - cy) / Math.max(220, innerHeight * 0.38), -1, 1),
      dist: Math.hypot(t.x - cx, t.y - cy)
    };
  }

  /* ---------------- expression state (shared by the rig and the portrait) ---------------- */
  // mw/mc/mo/pr/brow: SVG mouth, pupils, brows · lid: both · sm/br: portrait smile + brow lift
  const MOODS = {
    neutral:   { mw: 15, mc: 6,  mo: 0,  lid: 0,   brow: 0,   pr: 5.5, sm: 0,   br: 0 },
    happy:     { mw: 20, mc: 12, mo: 7,  lid: .1,  brow: -4,  pr: 6,   sm: .9,  br: .35 },
    surprised: { mw: 8,  mc: -8, mo: 18, lid: 0,   brow: -10, pr: 4,   sm: 0,   br: 1 },
    sleepy:    { mw: 10, mc: 2,  mo: 0,  lid: .7,  brow: 3,   pr: 5.5, sm: 0,   br: -.2 }
  };
  let mood = 'neutral', moodTimer, blink = 0, winkUntil = 0;
  const X = { ...MOODS.neutral, nx: 0, ny: 0, gx: 0, gy: 0, conv: 0 };
  const saccade = { x: 0, y: 0 };
  const setMood = (m, ms) => { mood = m; clearTimeout(moodTimer); if (ms) moodTimer = setTimeout(() => (mood = 'neutral'), ms); };
  document.addEventListener('pointerover', e => { if (e.target.closest('a, button')) setMood('happy'); });
  document.addEventListener('pointerout', e => { if (e.target.closest('a, button') && !e.relatedTarget?.closest?.('a, button')) setMood('neutral'); });
  svg.addEventListener('click', () => setMood('surprised', 500));
  glCv.addEventListener('click', () => { winkUntil = performance.now() + 380; setMood('happy', 1200); });
  (function scheduleBlink() {
    setTimeout(() => {
      blink = 1; setTimeout(() => (blink = 0), 120);
      if (Math.random() < 0.2) setTimeout(() => { blink = 1; setTimeout(() => (blink = 0), 110); }, 250);
      scheduleBlink();
    }, 2400 + Math.random() * 3600);
  })();
  (function scheduleSaccade() { // tiny eye darts keep a still face alive
    setTimeout(() => { saccade.x = (Math.random() - 0.5) * 0.18; saccade.y = (Math.random() - 0.5) * 0.12; scheduleSaccade(); }, 600 + Math.random() * 1700);
  })();

  function updateExpression(d, rect) {
    const idle = pointer.last > 0 && performance.now() - pointer.last > 14000;
    const m = MOODS[idle ? 'sleepy' : mood];
    for (const k in m) X[k] = lerp(X[k], m[k], reduce ? 1 : 0.14);
    X.nx = lerp(X.nx, Math.tanh(d.fx * 1.6), reduce ? 1 : 0.09);
    X.ny = lerp(X.ny, Math.tanh(d.fy * 1.6), reduce ? 1 : 0.09);
    // eyes lead the head: they get there faster and go a little further
    X.gx = lerp(X.gx, clamp(Math.tanh(d.fx * 2.2) + saccade.x, -1, 1), reduce ? 1 : 0.25);
    X.gy = lerp(X.gy, clamp(Math.tanh(d.fy * 2.2) + saccade.y, -1, 1), reduce ? 1 : 0.25);
    X.conv = lerp(X.conv, clamp(1 - d.dist / (rect.width * 0.28), 0, 1), 0.12);
  }

  /* ---------------- face geometry ---------------- */
  // Geometry in image pixels: { eyeL, eyeR, eyeRx, eyeRy, mouthL, mouthR, faceC, faceR }
  const mean = pts => pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.y / pts.length], [0, 0]);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function geomFromLandmarks(p) {
    const eyeRx = (dist(p[36], p[39]) + dist(p[42], p[45])) / 4;
    const open = ((p[41].y + p[40].y) - (p[37].y + p[38].y) + (p[47].y + p[46].y) - (p[43].y + p[44].y)) / 8;
    const browY = Math.min(...p.slice(17, 27).map(q => q.y)), chinY = p[8].y, topY = browY - (p[33].y - browY) * 0.75;
    return {
      eyeL: mean(p.slice(36, 42)), eyeR: mean(p.slice(42, 48)), eyeRx, eyeRy: clamp(open, eyeRx * 0.28, eyeRx * 0.6),
      mouthL: [p[48].x, p[48].y], mouthR: [p[54].x, p[54].y],
      faceC: [p.slice(0, 17).reduce((a, q) => a + q.x, 0) / 17, (topY + chinY) / 2],
      faceR: [(p[16].x - p[0].x) / 2, (chinY - topY) / 2]
    };
  }
  function geomFromClicks(eL, eR, m) {
    if (eL[0] > eR[0]) [eL, eR] = [eR, eL];
    const d = Math.hypot(eR[0] - eL[0], eR[1] - eL[1]), mid = [(eL[0] + eR[0]) / 2, (eL[1] + eR[1]) / 2];
    return {
      eyeL: eL, eyeR: eR, eyeRx: d * 0.2, eyeRy: d * 0.2 * 0.4,
      mouthL: [m[0] - d * 0.36, m[1]], mouthR: [m[0] + d * 0.36, m[1]],
      faceC: [mid[0], mid[1] + d * 0.3], faceR: [d * 1.05, d * 1.5]
    };
  }

  let apiPromise = null;
  function loadFaceApi() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((res, rej) => {
      if (window.faceapi) return res(window.faceapi);
      const s = document.createElement('script');
      s.src = FACE_API; s.onload = () => res(window.faceapi); s.onerror = () => rej(new Error('script'));
      document.head.appendChild(s);
    }).then(async api => {
      await api.nets.tinyFaceDetector.loadFromUri(MODELS);
      await api.nets.faceLandmark68Net.loadFromUri(MODELS);
      return api;
    });
    apiPromise.catch(() => (apiPromise = null));
    return apiPromise;
  }
  async function detectFace(img) {
    const api = await loadFaceApi();
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height, k = Math.min(1, 1400 / Math.max(W, H));
    const c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
    const x = c.getContext('2d'); x.fillStyle = '#808080'; x.fillRect(0, 0, c.width, c.height); // transparent PNGs detect better on grey
    x.drawImage(img, 0, 0, c.width, c.height);
    const det = await api.detectSingleFace(c, new api.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.3 })).withFaceLandmarks();
    if (!det) throw new Error('noface');
    return geomFromLandmarks(det.landmarks.positions.map(p => ({ x: p.x / k, y: p.y / k })));
  }

  // Head-and-shoulders crop that fills the stage; geometry converted to "q space" (pixel / crop height).
  function cropPortrait(img, g) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height, ratio = 0.87;
    let ch = g.faceR[0] * 2 * 3.3, cw = ch * ratio;
    const fit = Math.min(1, W / cw, H / ch); ch *= fit; cw *= fit;
    const x0 = clamp(g.faceC[0] - cw / 2, 0, W - cw), y0 = clamp(g.faceC[1] - ch * 0.42, 0, H - ch);
    const k = Math.min(1, 1300 / ch);
    const out = document.createElement('canvas'); out.width = Math.round(cw * k); out.height = Math.round(ch * k);
    const ox = out.getContext('2d'); ox.imageSmoothingQuality = 'high';
    ox.drawImage(img, x0, y0, cw, ch, 0, 0, out.width, out.height);
    const Q = p => [(p[0] - x0) / ch, (p[1] - y0) / ch];
    const q = {
      eyeL: Q(g.eyeL), eyeR: Q(g.eyeR), eyeRx: g.eyeRx / ch, eyeRy: g.eyeRy / ch,
      mouthL: Q(g.mouthL), mouthR: Q(g.mouthR), faceC: Q(g.faceC), faceR: [g.faceR[0] / ch, g.faceR[1] / ch]
    };
    q.mouthW = Math.hypot(q.mouthR[0] - q.mouthL[0], q.mouthR[1] - q.mouthL[1]);
    return { canvas: out, geom: q };
  }

  /* ---------------- portrait engine (WebGL warp) ---------------- */
  const Portrait = (() => {
    const VERT = `attribute vec2 aPos; varying vec2 vUv;
      void main(){ vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
    const FRAG = `precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      uniform float uAspect, uEyeRx, uEyeRy, uMouthW, uSmile, uBrow, uBreath;
      uniform vec2 uFaceC, uFaceR, uEyeL, uEyeR, uMouthL, uMouthR, uLook, uGaze, uBlink;

      vec2 eyeWarp(vec2 s, vec2 c, float blink, inout float dark){
        // irises slide inside the eye opening
        vec2 e = (s - c) / vec2(uEyeRx * 1.1, uEyeRy * 1.45);
        float w = max(0.0, 1.0 - dot(e, e)); w *= w;
        s -= uGaze * vec2(uEyeRx * 0.36, uEyeRy * 0.38) * w;
        // brows lift
        vec2 b = (s - (c + vec2(0.0, -uEyeRx * 1.15))) / vec2(uEyeRx * 1.7, uEyeRx * 0.85);
        float bw = max(0.0, 1.0 - dot(b, b)); bw *= bw;
        s.y += uBrow * uEyeRx * 0.13 * bw;
        // blink: stretch the upper-lid skin down over the eye
        float top = c.y - uEyeRy * 1.05, H = uEyeRy * 2.25;
        float hx = 1.0 - pow(clamp(abs(s.x - c.x) / (uEyeRx * 1.3), 0.0, 1.0), 2.0);
        float sh = blink * H * sqrt(max(hx, 0.0));
        float A = top - uEyeRx * 0.55;
        if (sh > 0.0002 && s.y > A && s.y < top + sh) {
          float yo = s.y;
          float yy = A + (s.y - A) * (top - A) / (top + sh - A);
          s.y = mix(s.y, yy, smoothstep(0.0, 0.3, hx));
          dark = max(dark, blink * hx * 0.5 * (1.0 - smoothstep(0.0, uEyeRy * 0.35, abs(yo - (top + sh)))));
        }
        return s;
      }
      vec2 cornerWarp(vec2 s, vec2 c, float dir){
        float sig = uMouthW * 0.24;
        vec2 d = s - c; float w = exp(-dot(d, d) / (2.0 * sig * sig));
        return s - vec2(dir * 0.3, -1.0) * uSmile * uMouthW * 0.06 * w;
      }
      void main(){
        vec2 q = vec2(vUv.x * uAspect, vUv.y);
        // head turn: the face is a sphere (centre moves most) plus a small rigid shift of the whole head
        vec2 d = (q - uFaceC) / uFaceR;
        float r = length(d);
        float z = sqrt(max(0.0, 1.0 - r * r));
        float rigid = (1.0 - smoothstep(0.9, 2.0, r)) * (1.0 - smoothstep(0.95, 1.7, d.y));
        vec2 D = uLook * vec2(uFaceR.x * 0.18, uFaceR.y * 0.11) * (0.4 * rigid + 0.6 * z);
        D.y += uBreath * rigid;
        vec2 s = q - D;
        float shade = 1.0 - (uLook.x * d.x * 0.06 + uLook.y * d.y * 0.035) * z;
        float dark = 0.0;
        s = eyeWarp(s, uEyeL, uBlink.x, dark);
        s = eyeWarp(s, uEyeR, uBlink.y, dark);
        s = cornerWarp(s, uMouthL, -1.0);
        s = cornerWarp(s, uMouthR, 1.0);
        vec4 col = texture2D(uTex, vec2(s.x / uAspect, s.y)); // premultiplied
        col.rgb *= shade * (1.0 - dark);
        gl_FragColor = col;
      }`;
    let gl = null, U = {}, geom = null, aspect = 1;
    function init() {
      if (gl) return true;
      gl = glCv.getContext('webgl', { alpha: true, premultipliedAlpha: true });
      if (!gl) return false;
      const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog); gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      'uTex uAspect uEyeRx uEyeRy uMouthW uSmile uBrow uBreath uFaceC uFaceR uEyeL uEyeR uMouthL uMouthR uLook uGaze uBlink'.split(' ').forEach(n => (U[n] = gl.getUniformLocation(prog, n)));
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]
        .forEach(([p, v]) => gl.texParameteri(gl.TEXTURE_2D, p, v));
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      return true;
    }
    function load(canvas, g) {
      try { if (!init()) return false; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas); }
      catch { return false; }
      aspect = canvas.width / canvas.height; geom = g; return true;
    }
    function draw(now) {
      const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.round(glCv.clientWidth * dpr), h = Math.round(glCv.clientHeight * dpr);
      if (w && h && (glCv.width !== w || glCv.height !== h)) { glCv.width = w; glCv.height = h; }
      gl.viewport(0, 0, glCv.width, glCv.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const g = geom;
      gl.uniform1i(U.uTex, 0); gl.uniform1f(U.uAspect, aspect);
      gl.uniform2fv(U.uFaceC, g.faceC); gl.uniform2fv(U.uFaceR, g.faceR);
      gl.uniform2fv(U.uEyeL, g.eyeL); gl.uniform2fv(U.uEyeR, g.eyeR);
      gl.uniform2fv(U.uMouthL, g.mouthL); gl.uniform2fv(U.uMouthR, g.mouthR);
      gl.uniform1f(U.uEyeRx, g.eyeRx); gl.uniform1f(U.uEyeRy, g.eyeRy); gl.uniform1f(U.uMouthW, g.mouthW);
      gl.uniform2f(U.uLook, X.nx, X.ny); gl.uniform2f(U.uGaze, X.gx, X.gy);
      const lid = Math.max(X.lid, blink), wink = now < winkUntil ? 1 : 0;
      gl.uniform2f(U.uBlink, Math.max(lid, wink), lid);
      gl.uniform1f(U.uSmile, X.sm); gl.uniform1f(U.uBrow, X.br);
      gl.uniform1f(U.uBreath, reduce ? 0 : Math.sin(now / 1000) * g.faceR[1] * 0.005);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return { load, draw };
  })();

  /* ---------------- character sheet engine ---------------- */
  function sliceSheet(img, o) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const cw = W / o.cols, ch = H / o.rows, ix = cw * o.inset, iy = ch * o.inset;
    const sw = cw - 2 * ix, sh = ch - 2 * iy;
    const k = Math.min(1, 1100 / sh);
    const w = Math.round(sw * k), h = Math.round(sh * k);
    let frames = [];
    for (let r = 0; r < o.rows; r++) {
      const row = [];
      for (let c = 0; c < o.cols; c++) {
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const x = cv.getContext('2d'); x.imageSmoothingQuality = 'high';
        x.drawImage(img, c * cw + ix, r * ch + iy, sw, sh, 0, 0, w, h);
        row.push(cv);
      }
      frames.push(o.flipX ? row.reverse() : row);
    }
    if (o.flipY) frames = frames.reverse();
    return { frames, w, h, cols: o.cols, rows: o.rows };
  }
  function makePlayer(canvas) {
    const ctx = canvas.getContext('2d');
    const p = { sheet: null, c: 0, r: 0, prev: null, fade: 1, dirty: true };
    p.load = sheet => {
      p.sheet = sheet; p.c = Math.floor(sheet.cols / 2); p.r = Math.floor(sheet.rows / 2);
      p.prev = null; p.fade = 1; p.dirty = true;
      canvas.width = sheet.w; canvas.height = sheet.h;
    };
    // Hysteresis: only switch once the cursor is clearly past the halfway line (no flicker at boundaries).
    p.update = (fx, fy, dt) => {
      const s = p.sheet; if (!s) return;
      const tc = (fx + 1) / 2 * (s.cols - 1), tr = (fy + 1) / 2 * (s.rows - 1);
      let c = p.c, r = p.r;
      if (Math.abs(tc - c) > 0.62) c = clamp(Math.round(tc), 0, s.cols - 1);
      if (Math.abs(tr - r) > 0.62) r = clamp(Math.round(tr), 0, s.rows - 1);
      if (c !== p.c || r !== p.r) { p.prev = s.frames[p.r][p.c]; p.c = c; p.r = r; p.fade = reduce ? 1 : 0; p.dirty = true; }
      if (p.fade < 1) { p.fade = Math.min(1, p.fade + dt / 110); p.dirty = true; }
      if (!p.dirty) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (p.prev && p.fade < 1) { ctx.globalAlpha = 1; ctx.drawImage(p.prev, 0, 0); ctx.globalAlpha = p.fade * p.fade * (3 - 2 * p.fade); }
      ctx.drawImage(s.frames[p.r][p.c], 0, 0); ctx.globalAlpha = 1;
      p.dirty = false;
    };
    return p;
  }
  const mainPlayer = makePlayer(spriteCv);

  /* ---------------- which renderer is live ---------------- */
  let active = 'svg', activeSource = null; // 'saved' | 'file'
  const smooth = { x: 0, y: 0 };

  function matchBackground(frame, enabled) {
    const reset = () => { hero.classList.remove('matched'); ['--hero', '--hero-hi', '--hero-lo'].forEach(v => hero.style.removeProperty(v)); };
    if (!enabled || !frame) return reset();
    try {
      const x = frame.getContext('2d'), s = Math.max(4, Math.round(frame.width * 0.03));
      let R = 0, G = 0, B = 0, A = 0, n = 0;
      for (const [px, py] of [[0, 0], [frame.width - s, 0], [0, Math.round(frame.height * 0.3)], [frame.width - s, Math.round(frame.height * 0.3)]]) {
        const d = x.getImageData(px, py, s, s).data;
        for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; A += d[i + 3]; n++; }
      }
      if (A / n < 230) return reset(); // transparent background: keep the page red
      R /= n; G /= n; B /= n;
      const f = (k, a) => `rgb(${Math.round(clamp(R * k + a, 0, 255))},${Math.round(clamp(G * k + a, 0, 255))},${Math.round(clamp(B * k + a, 0, 255))})`;
      hero.style.setProperty('--hero', f(1, 0)); hero.style.setProperty('--hero-hi', f(1.08, 12)); hero.style.setProperty('--hero-lo', f(0.55, 0));
      hero.classList.add('matched');
    } catch { reset(); }
  }
  function show(kind, source) {
    active = kind; activeSource = source;
    stage.classList.toggle('has-sprite', kind === 'sheet');
    stage.classList.toggle('has-portrait', kind === 'portrait');
    if (kind === 'svg') { stage.style.aspectRatio = ''; matchBackground(null, false); }
    updateFab();
  }
  function useSheet(sheet, opts, source) {
    mainPlayer.load(sheet);
    stage.style.aspectRatio = `${sheet.w} / ${sheet.h}`;
    show('sheet', source);
    matchBackground(sheet.frames[Math.floor(sheet.rows / 2)][Math.floor(sheet.cols / 2)], opts.match !== false);
  }
  function usePortrait(canvas, geom, source, match = true) {
    if (!Portrait.load(canvas, geom)) return false;
    stage.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    show('portrait', source);
    matchBackground(canvas, match);
    return true;
  }

  const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const imgToCanvas = img => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; };

  /* ---------------- illustrated placeholder rig ---------------- */
  const P = {
    body: el('av-body'), head: el('av-head'), face: el('av-face'), ears: el('av-ears'), hairBack: el('av-hairback'), fringe: el('av-fringe'),
    pupilL: el('pupil-l'), pupilR: el('pupil-r'), lidL: el('lid-l'), lidR: el('lid-r'), browL: el('brow-l'), browR: el('brow-r'), mouth: el('mouth'),
    pupils: svg.querySelectorAll('.pupil')
  };
  function drawRig(now) {
    const { nx, ny } = X, br = reduce ? 0 : Math.sin(now / 900) * 1.6;
    P.body.setAttribute('transform', `rotate(${nx * 1.6} 200 460) translate(0 ${br * 0.4})`);
    P.head.setAttribute('transform', `translate(${nx * 12} ${ny * 9 + br}) rotate(${nx * 6} 200 300)`);
    P.hairBack.setAttribute('transform', `translate(${-nx * 6} ${-ny * 4})`);
    P.ears.setAttribute('transform', `translate(${-nx * 8} ${ny * 2})`);
    P.face.setAttribute('transform', `translate(${nx * 15} ${ny * 11})`);
    P.fringe.setAttribute('transform', `translate(${nx * 9} ${ny * 5})`);
    const px = X.gx * 8, py = X.gy * 5, c = X.conv * 5;
    P.pupilL.setAttribute('transform', `translate(${px + c} ${py})`);
    P.pupilR.setAttribute('transform', `translate(${px - c} ${py})`);
    P.pupils.forEach(p => p.setAttribute('r', X.pr.toFixed(2)));
    const lid = (Math.max(X.lid, blink) * 35).toFixed(2);
    P.lidL.setAttribute('height', lid); P.lidR.setAttribute('height', lid);
    const up = Math.min(0, ny) * 5;
    P.browL.setAttribute('transform', `translate(0 ${X.brow + up}) rotate(${X.brow * -0.4} 160 146)`);
    P.browR.setAttribute('transform', `translate(0 ${X.brow + up}) rotate(${X.brow * 0.4} 240 146)`);
    const y0 = 260, w = X.mw;
    P.mouth.setAttribute('d', `M${200 - w} ${y0} Q200 ${y0 + X.mc} ${200 + w} ${y0} Q200 ${y0 + X.mc + X.mo} ${200 - w} ${y0} Z`);
  }

  /* ---------------- frame loop ---------------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - last); last = now;
    const rect = stage.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < innerHeight) {
      const d = direction(now, rect);
      updateExpression(d, rect);
      smooth.x = lerp(smooth.x, d.fx, reduce ? 1 : 0.1);
      smooth.y = lerp(smooth.y, d.fy, reduce ? 1 : 0.1);
      if (active === 'portrait') Portrait.draw(now);
      else if (active === 'sheet') {
        mainPlayer.update(d.fx, d.fy, dt);
        const bob = reduce ? 0 : Math.sin(now / 1100) * 0.35;
        spriteCv.style.transform = `translate3d(${(smooth.x * 1.4).toFixed(2)}%, ${(smooth.y * 0.9 + bob).toFixed(2)}%, 0) rotate(${(smooth.x * 0.7).toFixed(2)}deg)`;
      } else drawRig(now);
      nameEl.style.setProperty('--nx', `${(-smooth.x * 10).toFixed(1)}px`);
    }
    if (setupState.live && dialog.open && modeOf() === 'sheet') setupState.live.update(...liveDir(), dt);
    requestAnimationFrame(frame);
  }

  /* ---------------- setup panel ---------------- */
  const dialog = el('setup'), fab = el('setup-open');
  const S = id => el('s-' + id);
  const setupState = { img: null, live: null, geom: null, clicks: null, token: 0 };
  const modeOf = () => (S('mode-sheet').checked ? 'sheet' : 'single');

  function updateFab() { fab.hidden = !(activeSource !== 'file' || location.hash === '#setup'); }
  fab.addEventListener('click', () => openSetup());
  function openSetup() {
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
    renderPrompt(); renderSnippet();
  }
  addEventListener('hashchange', () => { updateFab(); if (location.hash === '#setup') openSetup(); });

  function applyModeUI() {
    const m = modeOf();
    dialog.classList.toggle('mode-single', m === 'single');
    dialog.classList.toggle('mode-sheet', m === 'sheet');
    S('color-wrap').hidden = m === 'single' && S('bg').value === 'transparent';
    S('filename').textContent = m === 'single' ? 'avatar.png' : 'avatar-grid.png';
    renderPrompt(); renderSnippet();
    if (setupState.img) processUpload();
  }
  ['mode-single', 'mode-sheet'].forEach(id => S(id).addEventListener('change', applyModeUI));
  S('bg').addEventListener('change', applyModeUI);

  function singlePrompt(bg, color) {
    const background = bg === 'transparent'
      ? 'fully transparent background (PNG with alpha). No environment, room, floor, background shadow or vignette.'
      : `one flat solid colour ${color.toUpperCase()}. No gradient, environment, floor, shadow or vignette.`;
    return `Create a premium 3D avatar of the person in the uploaded photo. Use the photo as the STRICT and ONLY reference for identity: the result must clearly be the SAME person, not a generic man.

IDENTITY (critical): keep the exact face shape and proportions, forehead and hairline, hairstyle (direction, volume and silhouette), eyebrows, eye shape, size and spacing, nose, lips and mouth, cheeks, jawline, chin, ears and skin tone. Keep facial hair exactly as in the photo: do not add or remove any. Do not beautify, do not enlarge the eyes, do not change ethnicity or age.

STYLE: realistic, slightly stylised high-end 3D render. Realistic skin texture with natural imperfections, detailed individual hair strands, realistic eyes, soft cinematic studio lighting, subtle ambient occlusion. Not anime, not cartoon, no Pixar-like exaggeration, no plastic or toy-like skin, no fantasy styling.

EXPRESSION: friendly, calm and confident, with a subtle natural closed-mouth smile.

POSE AND CAMERA: head and shoulders, perfectly front-facing, head upright with no tilt or turn, eye-level straight-on camera, no lens distortion. Shoulders symmetrical and relaxed. He looks directly into the camera.

EYES (most important: a website will animate them to follow the mouse cursor and blink):
- both eyes fully open and evenly lit, with white sclera visible on both sides of each iris
- clearly defined iris and pupil, a small natural catchlight in each eye
- clean upper and lower eyelid edges
- nothing over the eyes: no hair, glasses, glare or deep shadow
- eyebrows fully visible
Mouth closed. Nothing covering the face.

CLOTHING: plain white crew-neck t-shirt. No logos, text, jewellery or accessories.

FRAMING: portrait 4:5 image, avatar centred. Leave about 10% empty space above the hair. The shoulders are cut off by the bottom edge of the image.

BACKGROUND: ${background}

OUTPUT: one high-resolution image of this single avatar.`;
  }
  function sheetPrompt(n, color) {
    const rows = n === 3
      ? ['looking up', 'looking straight ahead', 'looking down']
      : ['looking up high', 'looking up slightly', 'looking straight ahead', 'looking down slightly', 'looking down low'];
    const cols = n === 3
      ? ['head turned toward the LEFT edge of the image', 'facing the camera', 'head turned toward the RIGHT edge of the image']
      : ['head turned far toward the LEFT edge of the image', 'head turned slightly left', 'facing the camera', 'head turned slightly right', 'head turned far toward the RIGHT edge of the image'];
    const mid = Math.ceil(n / 2);
    return `Using the photo I uploaded as the only reference for identity, create a CHARACTER SHEET of one person.

STYLE: realistic, slightly stylised high-end 3D portrait: soft cinematic lighting, detailed hair strands, realistic eyes, subtle skin texture. It must clearly be ME: keep my exact face shape, skin tone, eye shape, nose, jawline, hairstyle, hairline and facial hair. Do not beautify, change age or change ethnicity.

LAYOUT: one square image split into a perfect ${n} x ${n} grid of ${n * n} equal cells. No gaps, no borders, no lines, no text, no numbers.

EVERY CELL IS IDENTICAL EXCEPT FOR HEAD AND EYE DIRECTION:
- Same person, same plain white crew-neck t-shirt, same lighting, same size and same position.
- Head-and-shoulders framing, centred. Top of the hair about 10% below the top of the cell; shoulders cut off by the bottom edge of the cell.
- Friendly expression with a slight closed-mouth smile.

DIRECTIONS (the eyes always point the same way as the head, slightly further):
- Rows, top to bottom: ${rows.map((t, i) => `row ${i + 1} ${t}`).join('; ')}.
- Columns, left to right: ${cols.map((t, i) => `column ${i + 1} ${t}`).join('; ')}.
- The centre cell (row ${mid}, column ${mid}) looks straight into the camera.

BACKGROUND: one flat solid colour ${color.toUpperCase()} filling every cell, exactly the same in all cells. No gradient, no shadow, no vignette, no floor.`;
  }
  function renderPrompt() {
    S('prompt').textContent = modeOf() === 'single' ? singlePrompt(S('bg').value, S('color').value) : sheetPrompt(+S('grid').value, S('color').value);
  }
  S('grid').addEventListener('change', () => { S('cols').value = S('rows').value = S('grid').value; renderPrompt(); if (setupState.img) processUpload(); });
  S('color').addEventListener('input', renderPrompt);
  S('copy').addEventListener('click', async () => {
    const st = S('copy-status');
    try { await navigator.clipboard.writeText(S('prompt').textContent); st.textContent = 'Prompt copied. Paste it into ChatGPT together with your photo.'; st.className = 'status ok'; }
    catch {
      const r = document.createRange(); r.selectNodeContents(S('prompt'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      st.textContent = 'Prompt selected. Press Ctrl+C (or Cmd+C) to copy.'; st.className = 'status';
    }
  });

  const sheetOpts = () => ({
    cols: clamp(+S('cols').value || 5, 2, 9), rows: clamp(+S('rows').value || 5, 2, 9),
    inset: +S('inset').value, flipX: S('flipx').checked, flipY: S('flipy').checked, match: S('match').checked
  });
  const r1 = v => Math.round(v * 10) / 10;
  function renderSnippet() {
    if (modeOf() === 'sheet') {
      const o = sheetOpts();
      S('snippet').textContent = `<div class="stage" id="stage"\n     data-sprite="avatar-grid.png"\n     data-cols="${o.cols}" data-rows="${o.rows}"\n     data-inset="${o.inset}"\n     data-flip-x="${o.flipX}" data-flip-y="${o.flipY}">`;
    } else {
      const g = setupState.geom;
      const face = g ? JSON.stringify({
        eyeL: g.eyeL.map(r1), eyeR: g.eyeR.map(r1), eyeRx: r1(g.eyeRx), eyeRy: r1(g.eyeRy),
        mouthL: g.mouthL.map(r1), mouthR: g.mouthR.map(r1), faceC: g.faceC.map(r1), faceR: g.faceR.map(r1)
      }) : '(upload your image in step 2 first)';
      S('snippet').textContent = `<div class="stage" id="stage"\n     data-portrait="avatar.png"\n     data-match="${S('match').checked}"\n     data-face='${face}'>`;
    }
  }
  function setStatus(t, kind = '') { const s = S('status'); s.textContent = t; s.className = 'status ' + kind; }

  /* upload handling */
  function processUpload() { if (modeOf() === 'sheet') refreshSheetPreview(); else runSingleDetection(); }

  function refreshSheetPreview() {
    renderSnippet();
    const img = setupState.img; if (!img) return;
    const o = sheetOpts();
    S('preview-wrap').hidden = false; S('apply').disabled = false;
    const sc = S('sheet'), k = Math.min(1, 900 / img.naturalWidth);
    sc.width = Math.round(img.naturalWidth * k); sc.height = Math.round(img.naturalHeight * k);
    const x = sc.getContext('2d');
    x.drawImage(img, 0, 0, sc.width, sc.height);
    const cw = sc.width / o.cols, ch = sc.height / o.rows;
    x.lineWidth = 2;
    for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.cols; c++) {
      const centre = r === Math.floor(o.rows / 2) && c === Math.floor(o.cols / 2);
      x.strokeStyle = centre ? '#FFF1EC' : 'rgba(255,241,236,.55)';
      x.setLineDash(centre ? [] : [6, 5]);
      x.strokeRect(c * cw + cw * o.inset, r * ch + ch * o.inset, cw * (1 - 2 * o.inset), ch * (1 - 2 * o.inset));
    }
    if (!setupState.live) setupState.live = makePlayer(S('live'));
    setupState.live.load(sliceSheet(img, o));
    const ratio = img.naturalWidth / o.cols / (img.naturalHeight / o.rows);
    if (Math.abs(ratio - 1) > 0.25) setStatus(`Each cell is ${ratio.toFixed(2)}:1, not square. Check that Columns and Rows match your image.`, 'err');
    else setStatus('Move your cursor around: the live test should follow it.');
  }
  function liveDir() {
    const r = S('live').getBoundingClientRect();
    return [clamp((pointer.x - (r.left + r.width / 2)) / 240, -1, 1), clamp((pointer.y - (r.top + r.height * 0.4)) / 200, -1, 1)];
  }
  ['cols', 'rows', 'inset', 'flipx', 'flipy'].forEach(id => S(id).addEventListener('input', () => setupState.img && refreshSheetPreview()));
  S('match').addEventListener('input', renderSnippet);

  // single portrait: detection preview
  const faceCv = S('face');
  let faceFit = null;
  function drawFacePreview() {
    const img = setupState.img; if (!img) return;
    S('face-wrap').hidden = false;
    const k = Math.min(1, 720 / img.naturalWidth);
    faceCv.width = Math.round(img.naturalWidth * k); faceCv.height = Math.round(img.naturalHeight * k);
    faceFit = k;
    const x = faceCv.getContext('2d');
    x.clearRect(0, 0, faceCv.width, faceCv.height);
    x.drawImage(img, 0, 0, faceCv.width, faceCv.height);
    const g = setupState.geom, lw = Math.max(2, faceCv.width / 300);
    if (g) {
      x.lineWidth = lw; x.setLineDash([8, 6]); x.strokeStyle = 'rgba(255,241,236,.7)';
      x.beginPath(); x.ellipse(g.faceC[0] * k, g.faceC[1] * k, g.faceR[0] * k, g.faceR[1] * k, 0, 0, Math.PI * 2); x.stroke();
      x.setLineDash([]); x.strokeStyle = '#FFC83D';
      for (const e of [g.eyeL, g.eyeR]) { x.beginPath(); x.ellipse(e[0] * k, e[1] * k, g.eyeRx * k * 1.15, g.eyeRy * k * 1.4, 0, 0, Math.PI * 2); x.stroke(); }
      x.fillStyle = '#6FA8FF';
      for (const m of [g.mouthL, g.mouthR]) { x.beginPath(); x.arc(m[0] * k, m[1] * k, lw * 2.2, 0, Math.PI * 2); x.fill(); }
    }
    (setupState.clicks || []).forEach(([cx, cy], i) => {
      x.beginPath(); x.arc(cx * k, cy * k, lw * 3, 0, Math.PI * 2);
      x.fillStyle = i < 2 ? '#FFC83D' : '#6FA8FF'; x.fill(); x.strokeStyle = '#130A0B'; x.lineWidth = 2; x.stroke();
    });
  }
  const PICK = ['Click the centre of the eye on the left of the image.', 'Now click the centre of the other eye.', 'Last one: click the middle of the mouth.'];
  function startManual(msg) {
    if (!setupState.img) return;
    setupState.clicks = []; setupState.geom = null; S('apply').disabled = true;
    drawFacePreview(); setStatus(msg || PICK[0]); renderSnippet();
  }
  faceCv.addEventListener('click', e => {
    if (!setupState.clicks) return;
    const r = faceCv.getBoundingClientRect(), scale = faceCv.width / r.width;
    setupState.clicks.push([(e.clientX - r.left) * scale / faceFit, (e.clientY - r.top) * scale / faceFit]);
    if (setupState.clicks.length < 3) { drawFacePreview(); setStatus(PICK[setupState.clicks.length]); return; }
    const [a, b, m] = setupState.clicks; setupState.clicks = null;
    setupState.geom = geomFromClicks(a, b, m);
    drawFacePreview(); renderSnippet(); S('apply').disabled = false;
    setStatus('Face marked. Click Use this portrait.', 'ok');
  });
  S('manual').addEventListener('click', () => startManual());

  async function runSingleDetection() {
    const token = ++setupState.token;
    setupState.geom = null; setupState.clicks = null; S('apply').disabled = true; S('manual').disabled = false;
    drawFacePreview(); renderSnippet();
    setStatus('Loading the face detector (about 1.5 MB, first time only)…');
    try {
      const geom = await detectFace(setupState.img);
      if (token !== setupState.token) return;
      setupState.geom = geom;
      drawFacePreview(); renderSnippet(); S('apply').disabled = false;
      setStatus('Face found. Check the markers, then click Use this portrait.', 'ok');
    } catch (err) {
      if (token !== setupState.token) return;
      startManual((err.message === 'noface' ? 'No face found automatically. ' : 'The face detector couldn\'t load. ') + PICK[0]);
    }
  }

  async function takeFile(file) {
    if (!file || !file.type.startsWith('image/')) { setStatus('That isn\'t an image. Choose the PNG or JPG ChatGPT gave you.', 'err'); return; }
    const url = URL.createObjectURL(file);
    try { setupState.img = await loadImage(url); processUpload(); }
    catch { setStatus('This browser couldn\'t open that image. Try saving it as PNG or JPG.', 'err'); }
  }
  S('file').addEventListener('change', () => { takeFile(S('file').files[0]); S('file').value = ''; });
  const drop = S('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => takeFile(e.dataTransfer.files[0]));

  function encode(canvas, max) {
    const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas'); c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    const webp = c.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
  }
  function remember(data) {
    try { localStorage.setItem(STORE, JSON.stringify(data)); return true; } catch { return false; }
  }
  S('apply').addEventListener('click', () => {
    const img = setupState.img; if (!img) return;
    let ok;
    if (modeOf() === 'sheet') {
      const o = sheetOpts();
      useSheet(sliceSheet(img, o), o, 'saved');
      ok = remember({ kind: 'sheet', img: encode(imgToCanvas(img), 2400), opts: o });
    } else {
      if (!setupState.geom) return;
      const { canvas, geom } = cropPortrait(img, setupState.geom), match = S('match').checked;
      if (!usePortrait(canvas, geom, 'saved', match)) { setStatus('This browser has WebGL turned off, so the portrait can\'t be animated here.', 'err'); return; }
      ok = remember({ kind: 'portrait', img: encode(canvas, 1300), geom, match });
    }
    setStatus(ok ? 'Done. Your portrait is live on the page and saved in this browser. Close this panel to see it.'
                 : 'Your portrait is live, but it was too large to remember in this browser. Follow step 3 to publish it.', 'ok');
  });
  S('reset').addEventListener('click', async () => {
    try { localStorage.removeItem(STORE); } catch { /* ignore */ }
    setStatus('Reset. Showing the default portrait.', 'ok');
    (await bootFromFiles()) || show('svg', null);
  });

  /* ---------------- startup ---------------- */
  async function bootFromFiles() {
    const ds = stage.dataset;
    if (ds.portrait) {
      try {
        const img = await loadImage(ds.portrait);
        const geom = ds.face ? JSON.parse(ds.face) : await detectFace(img);
        const { canvas, geom: q } = cropPortrait(img, geom);
        if (usePortrait(canvas, q, 'file', ds.match !== 'false')) return true;
      } catch { /* no portrait file, or no face in it */ }
    }
    if (ds.sprite) {
      try {
        const img = await loadImage(ds.sprite);
        const o = { cols: +ds.cols || 5, rows: +ds.rows || 5, inset: +ds.inset || 0, flipX: ds.flipX === 'true', flipY: ds.flipY === 'true', match: true };
        useSheet(sliceSheet(img, o), o, 'file');
        return true;
      } catch { /* no sheet file */ }
    }
    return false;
  }
  (async () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE)); } catch { /* ignore */ }
    let done = false;
    if (saved?.img) {
      try {
        const img = await loadImage(saved.img);
        if (saved.kind === 'portrait') done = usePortrait(imgToCanvas(img), saved.geom, 'saved', saved.match !== false);
        else { useSheet(sliceSheet(img, saved.opts), saved.opts, 'saved'); done = true; }
      } catch { /* fall through */ }
    }
    if (!done && !(await bootFromFiles())) show('svg', null);
    if (location.hash === '#setup') openSetup();
  })();
  applyModeUI();
  requestAnimationFrame(frame);

  /* ---------------- page bits ---------------- */
  const links = [...document.querySelectorAll('.nav a')];
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  ['work', 'about', 'contact'].forEach(id => io.observe(el(id)));

  const copyBtn = el('copy');
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el('email').textContent); copyBtn.textContent = 'Copied'; }
    catch { const r = document.createRange(); r.selectNodeContents(el('email')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copyBtn.textContent = 'Press Ctrl+C'; }
    setTimeout(() => (copyBtn.textContent = 'Copy email'), 2000);
  });
})();
