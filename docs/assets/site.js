/* OpenSpread + Bullroom: o único script do site. Sem biblioteca, sem rede, sem armazenamento.
   Placar de LED do topo, palco do vídeo, prédio 3D da sala, inclinação dos cartões e botão de copiar.
   A página funciona inteira sem ele: cada parte só acrescenta movimento ou atalho. */
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  document.documentElement.classList.add('js');

  /* Roda `fn` só enquanto o elemento está na tela (economiza bateria e CPU). */
  function whileVisible(el, onShow, onHide, margin = '0px') {
    if (!('IntersectionObserver' in window)) { onShow(); return; }
    new IntersectionObserver(([e]) => (e.isIntersecting ? onShow() : onHide()), { rootMargin: margin }).observe(el);
  }

  /* ------------------------------------------------------------ placar de LED
     Cada mensagem (li da lista .board-msgs) é desenhada fora da tela e amostrada numa grade de pontos.
     O cursor (ou o dedo) é uma lente que acende e afasta os pontos ao redor. */
  function board() {
    const root = document.querySelector('.board');
    if (!root) return;
    const cv = root.querySelector('canvas'), ctx = cv.getContext('2d');
    const items = [...root.querySelectorAll('.board-msgs li')];
    const cap = root.querySelector('.board-cap'), legend = root.querySelector('.board-legend');
    const COLORS = { red: '#f87171', green: '#4ade80', amber: '#fac665' };
    const OFF = '#16202b';
    let idx = 0, cols = 0, rows = 0, gap = 10, dots = [], dpr = 1, raf = 0, timer = 0, running = false;
    const mouse = { x: -1e4, y: -1e4 };

    const buttons = items.map((li, j) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = li.dataset.key;
      b.addEventListener('click', () => { show(j); stopCycle(); });
      legend.append(b);
      return b;
    });

    function layout() {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      dpr = Math.min(devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      gap = Math.max(7, Math.round(w / (w < 700 ? 64 : 150)));
      cols = Math.floor(w / gap); rows = Math.floor(h / gap);
      dots = Array.from({ length: cols * rows }, () => ({ on: 0, t: 0, delay: 0 }));
      sample(true);
    }

    function sample(instant) {
      const li = items[idx];
      const off = document.createElement('canvas'); off.width = cols; off.height = rows;
      const o = off.getContext('2d');
      o.fillStyle = '#fff'; o.textAlign = 'center'; o.textBaseline = 'middle';
      let size = Math.floor(rows * .78);
      const font = s => `700 ${s}px Poppins, system-ui, sans-serif`;
      o.font = font(size);
      while (size > 4 && o.measureText(li.textContent).width > cols * .92) o.font = font(--size);
      o.fillText(li.textContent, cols / 2, rows * .54);
      const px = o.getImageData(0, 0, cols, rows).data;
      dots.forEach((d, i) => {
        d.t = px[i * 4 + 3] > 110 ? 1 : 0;
        d.delay = instant || reduce ? 0 : Math.random() * 14 + (i % cols) * (40 / cols);
        if (instant || reduce) d.on = d.t;
      });
      cap.innerHTML = li.dataset.cap;
      buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === idx)));
      if (!running) draw();
    }

    function show(j) { idx = j; sample(false); }

    function draw() {
      const color = COLORS[items[idx].dataset.color] || COLORS.amber;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      const lensR = gap * 14;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const d = dots[r * cols + c];
          if (d.delay > 0) d.delay -= 1; else d.on += (d.t - d.on) * .2;
          let x = c * gap + gap / 2, y = r * gap + gap / 2;
          const dx = x - mouse.x, dy = y - mouse.y, dist = Math.hypot(dx, dy) || 1;
          const lens = reduce ? 0 : Math.max(0, 1 - dist / lensR);
          x += (dx / dist) * lens * gap * 1.4; y += (dy / dist) * lens * gap * 1.4;
          const lit = Math.min(1, d.on + lens * .3);
          if (lit > .05) { ctx.fillStyle = color; ctx.globalAlpha = .22 + lit * .78; }
          else { ctx.fillStyle = OFF; ctx.globalAlpha = 1; }
          const s = gap * (.34 + lit * .16 + lens * .1);
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      }
      ctx.globalAlpha = 1;
      if (running) raf = requestAnimationFrame(draw);
    }

    function start() {
      if (running || reduce) return;
      running = true; raf = requestAnimationFrame(draw);
      if (!timer && root.dataset.cycle !== 'off') timer = setInterval(() => show((idx + 1) % items.length), 3800);
    }
    function stop() { running = false; cancelAnimationFrame(raf); clearInterval(timer); timer = 0; }
    function stopCycle() { clearInterval(timer); timer = 0; root.dataset.cycle = 'off'; }

    root.addEventListener('pointermove', e => {
      const r = cv.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    });
    root.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4; });
    let resizeT = 0;
    addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(layout, 150); });

    const ready = document.fonts && document.fonts.load ? document.fonts.load('700 40px Poppins') : Promise.resolve();
    ready.catch(() => {}).then(() => { layout(); root.classList.add('on'); whileVisible(root, start, stop); });
  }

  /* ------------------------------------------------------------ palco do vídeo
     Toca mudo quando aparece na tela, pausa quando sai. Os cartões acendem no tempo da fala;
     clicar num cartão pula o vídeo para aquele trecho. */
  function stage() {
    const root = document.querySelector('.reel');
    if (!root) return;
    const v = root.querySelector('video'), phone = root.querySelector('.phone');
    const beats = [...root.querySelectorAll('.beat')], bar = root.querySelector('.reel-bar i');
    const snd = root.querySelector('.sound');
    let userPaused = false;
    // sem script o vídeo tem os controles do navegador; com script, o palco cuida disso
    // (com "menos movimento" os controles ficam e nada toca sozinho)
    if (!reduce) v.removeAttribute('controls');

    v.addEventListener('timeupdate', () => {
      let on = 0;
      beats.forEach((b, i) => { if (v.currentTime >= +b.dataset.t) on = i; });
      beats.forEach((b, i) => b.classList.toggle('on', i === on));
      if (v.duration) bar.style.transform = `scaleX(${v.currentTime / v.duration})`;
    });
    beats.forEach(b => b.addEventListener('click', () => { v.currentTime = +b.dataset.t; userPaused = false; v.play().catch(() => {}); }));
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
      root.addEventListener('pointermove', e => {
        const r = root.getBoundingClientRect();
        phone.style.setProperty('--ry', ((e.clientX - r.left) / r.width - .5) * 26 + 'deg');
        phone.style.setProperty('--rx', (.5 - (e.clientY - r.top) / r.height) * 12 + 'deg');
      });
      root.addEventListener('pointerleave', () => { phone.style.removeProperty('--ry'); phone.style.removeProperty('--rx'); });
    }
  }

  /* ------------------------------------------------------------ prédio 3D
     O prédio (recorte da captura real) começa deitado em isométrico e, conforme a seção sobe na tela,
     vai pousando até a vista de cima, igual ao app. O mouse inclina um pouco por cima disso. */
  function building() {
    const root = document.querySelector('.building');
    if (!root) return;
    const scene = root.querySelector('.scene');
    const fit = () => root.style.setProperty('--fit', String(Math.min(1, root.clientWidth / 820)));
    fit(); addEventListener('resize', fit);
    if (reduce) { root.classList.add('flat'); return; }
    let mx = 0, my = 0, queued = false;
    const ease = t => 1 - Math.pow(1 - t, 3);
    function update() {
      queued = false;
      const r = root.getBoundingClientRect(), vh = innerHeight;
      // 0 quando o topo do prédio entra pela base da tela; 1 quando ele chega a 20% da altura
      const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * .8)));
      const k = ease(p);
      const rx = 58 * (1 - k) + my * -10, rz = -38 * (1 - k) + mx * 14;
      scene.style.setProperty('--rx', rx.toFixed(2) + 'deg');
      scene.style.setProperty('--rz', rz.toFixed(2) + 'deg');
      scene.style.setProperty('--lift', (1 - k).toFixed(3));
      root.classList.toggle('landed', k > .97);
    }
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    whileVisible(root, () => { addEventListener('scroll', queue, { passive: true }); queue(); },
      () => removeEventListener('scroll', queue), '200px');
    if (finePointer) {
      root.addEventListener('pointermove', e => {
        const r = root.getBoundingClientRect();
        mx = (e.clientX - r.left) / r.width - .5; my = (e.clientY - r.top) / r.height - .5; queue();
      });
      root.addEventListener('pointerleave', () => { mx = my = 0; queue(); });
    }
  }

  /* ------------------------------------------------------------ cartões que inclinam (só com mouse) */
  function tilt() {
    if (!finePointer || reduce) return;
    document.querySelectorAll('[data-tilt]').forEach(el => {
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        el.style.setProperty('--tx', ((y - .5) * -6).toFixed(2) + 'deg');
        el.style.setProperty('--ty', ((x - .5) * 6).toFixed(2) + 'deg');
        el.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
        el.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      });
      el.addEventListener('pointerleave', () => ['--tx', '--ty'].forEach(p => el.style.removeProperty(p)));
    });
  }

  /* ------------------------------------------------------------ copiar comandos e endereços */
  function copy() {
    if (!navigator.clipboard) return;
    document.querySelectorAll('[data-copy]').forEach(el => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'copy'; b.textContent = el.dataset.copyLabel || 'Copy';
      b.addEventListener('click', () => {
        const text = el.dataset.copy || [...el.querySelectorAll('.cmd')].map(l => l.textContent).join('\n') || el.textContent;
        navigator.clipboard.writeText(text.trim()).then(() => {
          b.textContent = el.dataset.copiedLabel || 'Copied'; b.classList.add('done');
          setTimeout(() => { b.textContent = el.dataset.copyLabel || 'Copy'; b.classList.remove('done'); }, 1600);
        }, () => {});
      });
      el.append(b);
    });
  }

  /* ------------------------------------------------------------ barra do topo ganha fundo ao rolar */
  function nav() {
    const n = document.querySelector('.nav');
    if (!n) return;
    const on = () => n.classList.toggle('scrolled', scrollY > 24);
    on(); addEventListener('scroll', on, { passive: true });
  }

  board(); stage(); building(); tilt(); copy(); nav();
})();
