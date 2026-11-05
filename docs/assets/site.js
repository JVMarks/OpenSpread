/* OpenSpread + Bullroom: o único script do site. Sem biblioteca, sem rede, sem armazenamento.
   Abertura em uma trilha só: placar de LED (WebGL) que deita e vira o chão do prédio (CSS 3D), com a mesma câmera.
   A página funciona inteira sem ele: sem script, sem WebGL ou com "menos movimento", tudo vira página empilhada. */
(() => {
  'use strict';
  const html = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  html.classList.add('js');

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smooth = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
  const lerp = (a, b, k) => a + (b - a) * k;

  /* Roda só enquanto o elemento está na tela (economiza bateria e CPU). */
  function whileVisible(el, onShow, onHide, margin = '0px') {
    if (!('IntersectionObserver' in window)) { onShow(); return; }
    new IntersectionObserver(([e]) => (e.isIntersecting ? onShow() : onHide()), { rootMargin: margin }).observe(el);
  }

  /* ------------------------------------------------------------ matrizes 4x4 (colunas), mesma conta da pilha de transform do CSS */
  const mul = (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[r + 4] * b[c * 4 + 1] + a[r + 8] * b[c * 4 + 2] + a[r + 12] * b[c * 4 + 3];
    }
    return o;
  };
  const translate = (x, y) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]);
  const scale = (s) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
  const rotX = (d) => { const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); };
  const rotY = (d) => { const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
  const rotZ = (d) => { const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); };
  const perspective = (p) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / p, 0, 0, 0, 1]);

  /* ------------------------------------------------------------ abertura */
  const PERSPECTIVE = 1500; // igual ao .stage do CSS: o chão de pontos e as salas precisam coincidir
  const VS = `
attribute vec3 aFrom, aTo, aColFrom, aColTo; attribute float aSeed;
uniform float uT, uSize, uScale, uW, uH, uArc; uniform mat4 uM;
varying vec3 vCol;
void main() {
  float s = clamp(uT * 1.5 - aSeed * .5, 0., 1.);
  s = s * s * (3. - 2. * s);
  vec3 p = mix(aFrom, aTo, s);
  p.z += sin(s * 3.14159) * (aSeed - .5) * uArc;
  vec4 q = uM * vec4(p, 1.);
  gl_Position = vec4(q.x / uW * 2. - q.w, q.w - q.y / uH * 2., 0., q.w);
  gl_PointSize = max(1., uSize * uScale / q.w);
  vCol = mix(aColFrom, aColTo, s);
}`;
  const FS = 'precision mediump float; varying vec3 vCol; void main() { gl_FragColor = vec4(vCol, 1.); }';
  const COLORS = { red: [.96, .22, .25], green: [.29, .87, .5], amber: [.95, .71, .11], violet: [.71, .6, .96] };
  const ROOMS = [
    { id: 'rec', c: 0, r: 0, x: 453, y: 156 }, { id: 'copa', c: 1, r: 0, x: 709, y: 156 },
    { id: 'usdc', c: 2, r: 0, x: 965, y: 156, accent: '#f87171' }, { id: 'maq', c: 3, r: 0, x: 1221, y: 156, accent: '#4ade80' },
    { id: 'ban', c: 0, r: 1, x: 453, y: 428 }, { id: 'lou', c: 1, r: 1, x: 709, y: 428 },
    { id: 'usde', c: 2, r: 1, x: 965, y: 428, accent: '#f2b51b' },
    { id: 'sim', c: 3, r: 1, paper: true, accent: '#a78bea', wall: '#5a3fa8', wall2: '#46318a' },
  ];
  const RH = 186, GX = 256, GY = 272, FLOOR_H = 26, UP_H = 118;
  const SEQ = ['usdc', 'usde', 'maq', 'sim'], ANGLES = [-24, -46, -14, -30];
  // trechos da trilha: o topo vai até .08; o número deita de .05 a .22 e vira chão em .17; prédio inteiro até .28; depois quatro salas
  const P_LOCK = .05, P_HERO_END = .08, P_FLOOR = .17, P_LAY_END = .22, P_LAID = .28, P_STEP = .1725;

  function cine() {
    const root = document.querySelector('.cine');
    if (!root || reduce) return;
    const stageEl = root.querySelector('.stage'), canvas = root.querySelector('.led'), world = root.querySelector('.world');
    let gl = null;
    try { gl = canvas.getContext('webgl', { antialias: false, alpha: true }); } catch { /* sem WebGL: página empilhada */ }
    if (!gl) return;
    const shader = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null; };
    const vs = shader(gl.VERTEX_SHADER, VS), fs = shader(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return;
    const pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
    gl.useProgram(pr);
    html.classList.add('cine-on');

    /* o id da seção sai dela e vai para uma marca na trilha: o palco é fixo, a âncora precisa cair no trecho certo */
    const section = root.querySelector('.floors'), anchor = document.createElement('span');
    anchor.className = 'cine-anchor'; anchor.id = section.id; section.removeAttribute('id');
    root.prepend(anchor);

    const hero = root.querySelector('.hero'), cap = root.querySelector('.cap');
    const items = [...root.querySelectorAll('.board-msgs li')];
    const floors = [...root.querySelectorAll('.floor')], rail = [...root.querySelectorAll('.rail i')];
    const U = Object.fromEntries(['uT', 'uSize', 'uScale', 'uW', 'uH', 'uArc', 'uM'].map((n) => [n, gl.getUniformLocation(pr, n)]));

    let W = 0, H = 0, mobile = false, dpr = 1, N = 0, sceneW = 0;
    let tier = 1, drawCount = 0;
    let perm = null, scenes = [], FLOOR = null;

    const buffers = {};
    const buffer = (name, size) => {
      const b = gl.createBuffer(), l = gl.getAttribLocation(pr, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
      buffers[name] = b;
    };
    const setBuffer = (name, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, buffers[name]); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); };
    ['aFrom', 'aTo', 'aColFrom', 'aColTo'].forEach((n) => buffer(n, 3));
    buffer('aSeed', 1);

    /* cada ponto tem um lugar fixo na grade: apagada, ela é o painel; deitada, é o chão do prédio */
    const homeOf = (i) => {
      const cols = Math.ceil(Math.sqrt(N)), G = mobile ? 20 : 18, h = perm[i];
      const x = ((h % cols) - cols / 2) * G, y = (Math.floor(h / cols) - cols / 2) * G;
      const fade = Math.max(0, 1 - Math.hypot(x, y) / (cols * G * .5));
      const accent = h % 19 === 0;
      return { x, y, r: (accent ? .5 : .13) * fade + .02, g: (accent ? .38 : .21) * fade + .04, b: (accent ? .1 : .42) * fade + .09 };
    };
    function toScene(points) {
      for (let j = points.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [points[j], points[k]] = [points[k], points[j]]; }
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const p = points[i];
        if (p) {
          pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = 0;
          col[i * 3] = p[2]; col[i * 3 + 1] = p[3]; col[i * 3 + 2] = p[4];
        } else {
          const h = homeOf(i);
          pos[i * 3] = h.x; pos[i * 3 + 1] = h.y;
          col[i * 3] = h.r; col[i * 3 + 1] = h.g; col[i * 3 + 2] = h.b;
        }
      }
      return { pos, col };
    }
    function sample(draw, sw, sh, widthPx, rgb) {
      const c = document.createElement('canvas'); c.width = sw; c.height = sh;
      const x = c.getContext('2d', { willReadFrequently: true });
      draw(x, sw, sh);
      const d = x.getImageData(0, 0, sw, sh).data, out = [], k = widthPx / sw;
      for (let py = 0; py < sh; py++) for (let px = 0; px < sw; px++) {
        const i = (py * sw + px) * 4;
        if (d[i + 3] > 110) {
          const col = rgb || [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
          out.push([(px - sw / 2) * k, (py - sh / 2) * k, col[0], col[1], col[2]]);
        }
      }
      return out;
    }
    let spacing = 3.6;
    function buildScenes(bust) {
      const wanted = mobile ? Math.min(W * .94, H * .8) : Math.min(W * .84, H * 1.3);
      const sw = mobile ? 170 : 240, sh = mobile ? 54 : 70; // poucos pontos e grade limpa: lê como LED, não como grão
      // passo inteiro em pixels do aparelho: a grade fica regular, sem ondulação
      spacing = Math.max(2, Math.round(wanted / sw * dpr)) / dpr;
      const bw = spacing * sw;
      const text = (str, rgb) => toScene(sample((x, w, h) => {
        x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
        let size = h * .9;
        x.font = `${size}px Anton`;
        while (x.measureText(str).width > w * .95 && size > 8) { size -= 2; x.font = `${size}px Anton`; }
        x.fillText(str, w / 2, h / 2 + h * .02);
      }, sw, sh, bw, rgb));
      const list = items.map((li) => ({ li, scene: text(li.textContent, COLORS[li.dataset.color] || COLORS.amber) }));
      if (bust) {
        const bh = bw * (sh / sw) * (mobile ? 1.7 : 1.3), bwid = bh * bust.naturalWidth / bust.naturalHeight;
        const k = Math.round(bwid / spacing);
        const scene = toScene(sample((x, w, h) => x.drawImage(bust, 0, 0, w, h), k, Math.round(k * bust.naturalHeight / bust.naturalWidth), bwid));
        list.splice(2, 0, { li: null, scene });
      }
      scenes = list;
      FLOOR = { li: null, scene: toScene([]) };
    }

    /* salas: caixas com a captura real no topo */
    const slab = document.createElement('div'); slab.className = 'slab'; world.append(slab);
    const ox = -2 * GX + 6, oy = -(GY + RH) / 2;
    const rooms = ROOMS.map((r, i) => {
      const el = document.createElement('div'); el.className = 'room';
      el.style.left = (ox + r.c * GX) + 'px'; el.style.top = (oy + r.r * GY) + 'px';
      if (r.accent) el.style.setProperty('--accent', r.accent);
      if (r.wall) { el.style.setProperty('--wall', r.wall); el.style.setProperty('--wall2', r.wall2); }
      const top = document.createElement('div'); top.className = 'face top' + (r.paper ? ' smooth' : '');
      if (r.paper) { top.style.backgroundImage = `url(${world.dataset.paper})`; top.style.backgroundSize = '100% 100%'; }
      else { top.style.backgroundImage = `url(${world.dataset.live})`; top.style.backgroundPosition = `${-r.x}px ${-r.y}px`; }
      const s = document.createElement('div'); s.className = 'face s';
      const e = document.createElement('div'); e.className = 'face e';
      el.append(s, e, top);
      slab.append(el);
      return { ...r, i, el, top, s, e, h: 0, lastH: -1, lastRise: -1 };
    });
    const bull = document.createElement('img');
    bull.className = 'bull'; bull.src = world.dataset.bull; bull.alt = ''; bull.width = 150;
    rooms[0].el.append(bull);

    /* câmeras */
    let cams = null;
    function buildCams() {
      const f = mobile ? Math.min(W / 390, H / 700) : Math.min(W / 1440, H / 900);
      const step = (i) => {
        const r = ROOMS.find((o) => o.id === SEQ[i]);
        return { ox: W * (mobile ? .5 : .66), oy: H * (mobile ? .33 : .52), s: (mobile ? .86 : 1.5) * f, rx: 52, rz: ANGLES[i], tx: -((r.c - 1.5) * GX + .5), ty: -((r.r - .5) * GY) };
      };
      cams = {
        hero: { ox: W * .5, oy: H * (mobile ? .3 : .36), s: 1, rx: 0, rz: 0, tx: 0, ty: 0 },
        over: { ox: W * (mobile ? .5 : .62), oy: H * (mobile ? .4 : .52), s: (mobile ? .46 : .95) * f, rx: 58, rz: -38, tx: 0, ty: 0 },
        steps: SEQ.map((_, i) => step(i)),
      };
    }
    const cur = { ox: 0, oy: 0, s: 1, rx: 0, rz: 0, tx: 0, ty: 0 };
    let camReady = false;

    function layout() {
      const w = stageEl.clientWidth, h = stageEl.clientHeight;
      if (!w || !h) return;
      W = w; H = h; mobile = W < 900;
      dpr = Math.min(devicePixelRatio || 1, tier < .5 ? 1 : (mobile ? 1.5 : 1.75));
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(U.uW, W); gl.uniform1f(U.uH, H);
      buildCams();
      const span = root.offsetHeight - H;
      anchor.style.top = (P_LAID * span + 90) + 'px';
    }

    /* cena e troca: nunca interrompe uma troca no meio (o ponto saltaria) */
    let current = 0, target = 0, t = 1, hold = 0;
    const show = (scene) => { setBuffer('aFrom', current === -1 ? FLOOR.scene.pos : scenes[current].scene.pos); setBuffer('aColFrom', current === -1 ? FLOOR.scene.col : scenes[current].scene.col); setBuffer('aTo', scene.pos); setBuffer('aColTo', scene.col); t = 0; };
    function caption(i) {
      const li = i >= 0 && scenes[i] ? scenes[i].li : null;
      if (li) cap.innerHTML = li.dataset.cap;
      cap.classList.toggle('quiet', !li);
    }
    function goTo(i) {
      target = i;
      show(i === -1 ? FLOOR.scene : scenes[i].scene);
      caption(i);
    }

    let tiltX = 0, tiltY = 0, tx = 0, ty = 0;
    if (finePointer) addEventListener('pointermove', (e) => { tx = e.clientX / innerWidth - .5; ty = e.clientY / innerHeight - .5; }, { passive: true });

    let state = -2, last = performance.now();
    let probe = 0, probeSum = 0;
    const setQuality = (q) => { tier = q; drawCount = Math.round(N * q); html.dataset.cine = String(q); if (q < .5) layout(); };

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const raw = now - last; last = now;
      const dt = Math.min(.05, raw / 1000);
      const rect = root.getBoundingClientRect(), span = rect.height - H;
      const p = span > 0 ? clamp01(-rect.top / span) : 0;

      /* mede de verdade: acima de 30 ms por quadro, menos pontos e menos resolução */
      if (raw < 400 && tier > .3) {
        probe++; probeSum += raw;
        if (probe >= 50) {
          if (probeSum / probe > 30) setQuality(tier === 1 ? .55 : .3);
          probe = 0; probeSum = 0;
        }
      }

      /* troca do placar */
      if (t < 1) { t = Math.min(1, t + dt / 1.3); if (t === 1) current = target; }
      else if (p > P_FLOOR) { hold = 0; if (current !== -1) goTo(-1); }
      else if (current === -1) { hold = 0; goTo(0); }
      else if (p > P_LOCK) { hold = 0; if (current !== 0) goTo(0); } // o que deita é sempre o −0,20%
      else if ((hold += dt) > 2.8) { hold = 0; goTo((current + 1) % scenes.length); }

      /* câmera */
      const step = p < P_LAID ? -1 : Math.min(SEQ.length - 1, Math.floor((p - P_LAID) / P_STEP));
      const lay = smooth((p - P_LOCK) / (P_LAY_END - P_LOCK));
      let goal;
      if (step < 0) {
        goal = {};
        for (const k in cur) goal[k] = lerp(cams.hero[k], cams.over[k], lay);
      } else goal = cams.steps[step];
      const k = camReady ? 1 - Math.exp(-dt * 6) : 1;
      camReady = true;
      for (const key in cur) cur[key] += (goal[key] - cur[key]) * k;
      tiltX += (tx - tiltX) * .05; tiltY += (ty - tiltY) * .05;
      const rx = cur.rx - tiltY * lerp(6, 4, lay), ry = tiltX * 8 * (1 - lay), rz = cur.rz + tiltX * 6 * lay;

      /* mesma pilha de transform no CSS e no WebGL */
      world.style.transform = `translate(${cur.ox}px, ${cur.oy}px) scale3d(${cur.s}, ${cur.s}, ${cur.s}) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) translate(${cur.tx}px, ${cur.ty}px)`;
      const model = mul(mul(mul(mul(mul(translate(cur.ox, cur.oy), scale(cur.s)), rotX(rx)), rotY(ry)), rotZ(rz)), translate(cur.tx, cur.ty));
      const m = mul(mul(mul(translate(W / 2, H / 2), perspective(PERSPECTIVE)), translate(-W / 2, -H / 2)), model);

      /* salas sobem do chão, uma depois da outra; a da vez sobe mais */
      for (const r of rooms) {
        const rise = smooth((p - .15 - r.i * .008) / .07);
        const on = step >= 0 && SEQ[step] === r.id;
        r.h += ((on ? UP_H : FLOOR_H) - r.h) * (1 - Math.exp(-dt * 6));
        const h = r.h * rise, z = -80 * (1 - rise);
        if (Math.abs(h - r.lastH) > .05 || Math.abs(rise - r.lastRise) > .002) {
          r.lastH = h;
          r.top.style.transform = `translateZ(${z + h}px)`;
          r.s.style.transform = `translateZ(${z}px) rotateX(-90deg) scaleY(${h / 100})`;
          r.e.style.transform = `translateZ(${z}px) rotateY(90deg) scaleX(${h / 100})`;
          if (rise !== r.lastRise) { r.top.style.opacity = rise; r.s.style.opacity = rise; r.e.style.opacity = rise; r.lastRise = rise; }
          if (r.i === 0) bull.style.transform = `translateZ(${z + h + 1}px) rotateX(-90deg) rotateY(${-cur.rz * .5}deg)`;
        }
        r.el.classList.toggle('on', on);
      }

      /* o touro é da vista geral; depois sairia atrás do texto */
      bull.style.opacity = step < 0 ? rooms[0].lastRise : 0;

      /* textos */
      const st = p <= P_HERO_END ? -2 : step;
      if (st !== state) {
        state = st;
        hero.classList.toggle('off', st !== -2);
        stageEl.classList.toggle('steps', st >= 0);
        floors.forEach((el, i) => el.classList.toggle('on', i === st));
        rail.forEach((el, i) => el.classList.toggle('on', i <= st));
      }

      gl.uniform1f(U.uT, t);
      gl.uniform1f(U.uArc, mobile ? 120 : 220);
      gl.uniform1f(U.uSize, Math.max(1, Math.round(spacing * dpr * .8)));
      gl.uniform1f(U.uScale, cur.s);
      gl.uniformMatrix4fv(U.uM, false, m);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, drawCount);
    }

    let raf = 0, running = false, ready = false;
    const start = () => { if (running || !ready) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    function init(bust) {
      layout();
      N = mobile ? 11000 : 26000;
      sceneW = W;
      perm = Array.from({ length: N }, (_, i) => i);
      for (let j = N - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [perm[j], perm[k]] = [perm[k], perm[j]]; }
      const seeds = new Float32Array(N); for (let i = 0; i < N; i++) seeds[i] = Math.random();
      setBuffer('aSeed', seeds);
      drawCount = N;
      buildScenes(bust);
      const rebuild = () => { buildScenes(bust); current = 0; target = 0; t = 1; setBuffer('aFrom', scenes[0].scene.pos); setBuffer('aColFrom', scenes[0].scene.col); setBuffer('aTo', scenes[0].scene.pos); setBuffer('aColTo', scenes[0].scene.col); caption(0); };
      rebuild();
      let resizeT = 0;
      addEventListener('resize', () => {
        clearTimeout(resizeT);
        resizeT = setTimeout(() => { layout(); if (W !== sceneW && mobile === (N === 11000)) { sceneW = W; rebuild(); } }, 150);
      });
      ready = true;
      whileVisible(root, start, stop);
      if (location.hash) { const el = document.getElementById(location.hash.slice(1)); if (el) el.scrollIntoView(); }
    }

    /* foco de teclado no botão do topo traz a tela de volta para o começo */
    hero.addEventListener('focusin', () => { if (scrollY > 40) scrollTo(0, 0); });

    const bust = new Image();
    bust.src = world.dataset.bust;
    const fonts = document.fonts && document.fonts.load ? document.fonts.load('80px Anton').catch(() => {}) : Promise.resolve();
    Promise.all([fonts, bust.decode().then(() => bust, () => null)]).then(([, img]) => init(img));
  }

  /* ------------------------------------------------------------ palco do vídeo
     Toca mudo quando aparece na tela, pausa quando sai. Os trechos acendem no tempo da fala;
     clicar num trecho pula o vídeo para ele. */
  function stage() {
    const root = document.querySelector('.reel');
    if (!root) return;
    const v = root.querySelector('video'), phone = root.querySelector('.phone');
    const beats = [...root.querySelectorAll('.beat')], bar = root.querySelector('.reel-bar i');
    const snd = root.querySelector('.sound');
    let userPaused = false;
    // sem script o vídeo tem os controles do navegador; com "menos movimento" os controles ficam e nada toca sozinho
    if (!reduce) v.removeAttribute('controls');

    v.addEventListener('timeupdate', () => {
      let on = 0;
      beats.forEach((b, i) => { if (v.currentTime >= +b.dataset.t) on = i; });
      beats.forEach((b, i) => b.classList.toggle('on', i === on));
      if (v.duration) bar.style.transform = `scaleX(${v.currentTime / v.duration})`;
    });
    beats.forEach((b) => b.addEventListener('click', () => { v.currentTime = +b.dataset.t; userPaused = false; v.play().catch(() => {}); }));
    const label = () => { snd.textContent = v.muted ? snd.dataset.off : snd.dataset.on; snd.setAttribute('aria-pressed', String(!v.muted)); };
    snd.addEventListener('click', () => { v.muted = !v.muted; if (!v.muted) { userPaused = false; v.play().catch(() => {}); } label(); });
    v.addEventListener('pause', () => { if (!document.hidden && root.dataset.visible === '1' && !v.ended) userPaused = true; });
    v.addEventListener('play', () => { userPaused = false; });
    label();

    whileVisible(v, () => {
      root.dataset.visible = '1';
      if (!reduce && !userPaused) v.play().catch(() => {});
    }, () => { root.dataset.visible = '0'; v.pause(); userPaused = false; });

    if (finePointer && !reduce) {
      root.addEventListener('pointermove', (e) => {
        const r = root.getBoundingClientRect();
        phone.style.setProperty('--ry', ((e.clientX - r.left) / r.width - .5) * 26 + 'deg');
        phone.style.setProperty('--rx', (.5 - (e.clientY - r.top) / r.height) * 12 + 'deg');
      });
      root.addEventListener('pointerleave', () => { phone.style.removeProperty('--ry'); phone.style.removeProperty('--rx'); });
    }
  }

  /* ------------------------------------------------------------ imagens que inclinam (só com mouse) */
  function tilt() {
    if (!finePointer || reduce) return;
    document.querySelectorAll('[data-tilt]').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        el.style.setProperty('--tx', ((y - .5) * -6).toFixed(2) + 'deg');
        el.style.setProperty('--ty', ((x - .5) * 6).toFixed(2) + 'deg');
        el.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
        el.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      });
      el.addEventListener('pointerleave', () => ['--tx', '--ty'].forEach((p) => el.style.removeProperty(p)));
    });
  }

  /* ------------------------------------------------------------ copiar comandos e endereços */
  function copy() {
    if (!navigator.clipboard) return;
    document.querySelectorAll('[data-copy]').forEach((el) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'copy'; b.textContent = el.dataset.copyLabel || 'Copy';
      b.addEventListener('click', () => {
        const text = el.dataset.copy || [...el.querySelectorAll('.cmd')].map((l) => l.textContent).join('\n') || el.textContent;
        navigator.clipboard.writeText(text.trim()).then(() => {
          b.textContent = el.dataset.copiedLabel || 'Copied'; b.classList.add('done');
          setTimeout(() => { b.textContent = el.dataset.copyLabel || 'Copy'; b.classList.remove('done'); }, 1600);
        }, () => {});
      });
      el.append(b);
    });
  }

  /* ------------------------------------------------------------ barra do topo ganha fundo depois do começo da página */
  function nav() {
    const n = document.querySelector('.nav');
    if (!n || !('IntersectionObserver' in window)) { if (n) n.classList.add('scrolled'); return; }
    const mark = document.createElement('span');
    mark.className = 'nav-mark';
    document.body.prepend(mark);
    new IntersectionObserver(([e]) => n.classList.toggle('scrolled', !e.isIntersecting)).observe(mark);
  }

  cine(); stage(); tilt(); copy(); nav();
})();
