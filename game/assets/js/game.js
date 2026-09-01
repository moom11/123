/*
 * نيزك — لعبة تفادي النيازك. JavaScript خالص، بدون أي مكتبات.
 */
(function () {
  'use strict';

  /* ================= التخزين المحلي ================= */
  const LS = {
    best: 'nayzak.best',
    wallet: 'nayzak.wallet',
    skin: 'nayzak.skin',
    owned: 'nayzak.owned',
    name: 'nayzak.name'
  };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let best = +get(LS.best, 0) || 0;
  let wallet = +get(LS.wallet, 0) || 0;
  let owned = get(LS.owned, ['classic']);
  let skinId = get(LS.skin, 'classic');
  if (!Array.isArray(owned) || !owned.length) owned = ['classic'];

  /* ================= المركبات ================= */
  const SKINS = [
    { id: 'classic', name: 'المستكشف', price: 0,    body: '#4cc2ff', trim: '#eaf6ff', flame: '#7be3ff' },
    { id: 'ember',   name: 'الجمرة',   price: 150,  body: '#ff7a45', trim: '#ffd9bd', flame: '#ffb347' },
    { id: 'venom',   name: 'الأفعى',   price: 400,  body: '#3ddc97', trim: '#d9ffe9', flame: '#8affc9' },
    { id: 'royal',   name: 'الملكية',  price: 800,  body: '#b98cff', trim: '#eee0ff', flame: '#d7b3ff' },
    { id: 'gold',    name: 'الذهبية',  price: 1500, body: '#ffcc4d', trim: '#fff6d0', flame: '#ffe58a' }
  ];
  const skinById = (id) => SKINS.find((s) => s.id === id) || SKINS[0];

  /* ================= أدوات ================= */
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const fmt = (n) => Math.floor(n).toLocaleString('en-US');
  const $ = (id) => document.getElementById(id);

  function toast(msg, ms) {
    let box = $('toast');
    if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
    box.innerHTML = '<div class="t"></div>';
    box.firstChild.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { box.innerHTML = ''; }, ms || 1800);
  }

  /* ================= اللوحة ================= */
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;

  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    makeStars();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));

  /* ================= النجوم في الخلفية ================= */
  let stars = [];
  function makeStars() {
    const n = Math.round((W * H) / 5200);
    stars = [];
    for (let i = 0; i < n; i++) {
      const layer = i % 3;
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 0.5 + layer * 0.55 + Math.random() * 0.5,
        sp: 12 + layer * 26,
        a: 0.25 + layer * 0.22
      });
    }
  }

  /* ================= حالة اللعبة ================= */
  const MODE = { MENU: 'menu', PLAY: 'play', DYING: 'dying', OVER: 'over', PAUSE: 'pause' };
  let mode = MODE.MENU;

  const S = {
    t: 0, score: 0, coins: 0,
    shipX: 0, shipY: 0, targetX: 0, shipVX: 0,
    rocks: [], pickups: [], parts: [],
    spawnRock: 0, spawnCoin: 0, spawnPower: 0,
    shield: 0, magnet: 0, slow: 0,
    invuln: 0, shake: 0, dieTimer: 0,
    revived: false
  };

  const shipR = () => clamp(W * 0.042, 13, 24);

  function resetRound() {
    S.t = 0; S.score = 0; S.coins = 0;
    S.rocks.length = 0; S.pickups.length = 0; S.parts.length = 0;
    S.shipX = W / 2; S.targetX = W / 2; S.shipVX = 0;
    S.shipY = H - Math.max(70, H * 0.16);
    S.spawnRock = 0.9; S.spawnCoin = 1.4; S.spawnPower = 12;
    S.shield = 0; S.magnet = 0; S.slow = 0;
    S.invuln = 1.2; S.shake = 0; S.dieTimer = 0;
    S.revived = false;
  }

  const progress = () => clamp(S.t / 100, 0, 1);
  const speedMul = () => 1 + 1.9 * progress();

  /* ================= التوليد ================= */
  function spawnRock() {
    const r = rnd(W * 0.045, W * 0.095);
    const pts = [];
    const n = 8 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) pts.push({ a: (i / n) * Math.PI * 2, d: rnd(0.72, 1.12) });
    S.rocks.push({
      x: rnd(r, W - r), y: -r - 8, r: r, pts: pts,
      vy: H * rnd(0.30, 0.52) * speedMul(),
      vx: rnd(-W * 0.06, W * 0.06),
      rot: Math.random() * Math.PI, spin: rnd(-1.4, 1.4),
      hue: rnd(-14, 14)
    });
  }

  function spawnCoinRun() {
    const n = 3 + Math.floor(Math.random() * 4);
    const r = clamp(W * 0.026, 7, 14);
    const x0 = rnd(r * 3, W - r * 3);
    const wave = Math.random() < 0.5;
    const vy = H * 0.34 * speedMul();
    for (let i = 0; i < n; i++) {
      S.pickups.push({
        kind: 'coin', r: r, vy: vy,
        x: clamp(x0 + (wave ? Math.sin(i * 0.9) * W * 0.16 : 0), r, W - r),
        y: -r - i * (r * 3.2), sp: Math.random() * 6
      });
    }
  }

  function spawnPower() {
    const types = ['shield', 'magnet', 'slow'];
    const r = clamp(W * 0.036, 11, 20);
    S.pickups.push({
      kind: types[Math.floor(Math.random() * types.length)],
      r: r, x: rnd(r * 2, W - r * 2), y: -r - 10,
      vy: H * 0.28 * speedMul(), sp: 0
    });
  }

  function burst(x, y, color, n, power) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(0.2, 1) * power;
      S.parts.push({
        x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rnd(0.35, 0.9), max: 0.9, r: rnd(1.5, 4), c: color
      });
    }
  }

  /* ================= التحديث ================= */
  function update(dt) {
    // النجوم تتحرك دائماً (حتى في القوائم)
    const bgMul = mode === MODE.PLAY ? speedMul() : 1;
    for (const st of stars) {
      st.y += st.sp * bgMul * dt;
      if (st.y > H) { st.y = -2; st.x = Math.random() * W; }
    }

    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i];
      p.life -= dt;
      if (p.life <= 0) { S.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 220 * dt; p.vx *= 0.985;
    }

    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 2.6);

    if (mode === MODE.DYING) {
      S.dieTimer -= dt;
      if (S.dieTimer <= 0) showGameOver();
      return;
    }
    if (mode !== MODE.PLAY) return;

    S.t += dt;
    S.score += dt * (10 + 20 * progress());

    if (S.shield > 0) S.shield = Math.max(0, S.shield - dt);
    if (S.magnet > 0) S.magnet = Math.max(0, S.magnet - dt);
    if (S.slow > 0) S.slow = Math.max(0, S.slow - dt);
    if (S.invuln > 0) S.invuln = Math.max(0, S.invuln - dt);
    renderBuffs();

    // حركة المركبة
    const px = S.shipX;
    S.shipX = lerp(S.shipX, clamp(S.targetX, shipR(), W - shipR()), clamp(dt * 13, 0, 1));
    S.shipVX = (S.shipX - px) / Math.max(dt, 0.001);

    // التوليد
    const slowF = S.slow > 0 ? 0.45 : 1;
    S.spawnRock -= dt;
    if (S.spawnRock <= 0) {
      spawnRock();
      S.spawnRock = lerp(0.85, 0.30, progress()) * rnd(0.75, 1.25);
    }
    S.spawnCoin -= dt;
    if (S.spawnCoin <= 0) { spawnCoinRun(); S.spawnCoin = rnd(2.2, 4.2); }
    S.spawnPower -= dt;
    if (S.spawnPower <= 0) { spawnPower(); S.spawnPower = rnd(13, 20); }

    const sr = shipR();

    // النيازك
    for (let i = S.rocks.length - 1; i >= 0; i--) {
      const o = S.rocks[i];
      o.y += o.vy * slowF * dt;
      o.x += o.vx * slowF * dt;
      o.rot += o.spin * dt;
      if (o.x < o.r || o.x > W - o.r) o.vx *= -1;
      if (o.y - o.r > H + 20) { S.rocks.splice(i, 1); continue; }

      const dx = o.x - S.shipX, dy = o.y - S.shipY;
      if (dx * dx + dy * dy < (o.r + sr * 0.72) ** 2) {
        if (S.invuln > 0) continue;
        if (S.shield > 0) {
          S.shield = 0;
          burst(o.x, o.y, '#7be3ff', 22, 240);
          S.rocks.splice(i, 1);
          S.invuln = 0.9; S.shake = 0.5;
          renderBuffs();
          continue;
        }
        return die();
      }
    }

    // العملات والقوى
    for (let i = S.pickups.length - 1; i >= 0; i--) {
      const p = S.pickups[i];
      p.sp += dt * 4;
      p.y += p.vy * slowF * dt;

      if (p.kind === 'coin' && S.magnet > 0) {
        const dx = S.shipX - p.x, dy = S.shipY - p.y;
        const d = Math.hypot(dx, dy);
        if (d < W * 0.7 && d > 1) {
          const pull = 520 * dt;
          p.x += (dx / d) * pull; p.y += (dy / d) * pull;
        }
      }
      if (p.y - p.r > H + 20) { S.pickups.splice(i, 1); continue; }

      const dx = p.x - S.shipX, dy = p.y - S.shipY;
      if (dx * dx + dy * dy < (p.r + sr * 0.9) ** 2) {
        S.pickups.splice(i, 1);
        if (p.kind === 'coin') {
          S.coins++; S.score += 25;
          burst(p.x, p.y, '#ffcc4d', 8, 130);
        } else {
          if (p.kind === 'shield') { S.shield = 14; burst(p.x, p.y, '#7be3ff', 16, 160); }
          if (p.kind === 'magnet') { S.magnet = 9;  burst(p.x, p.y, '#b98cff', 16, 160); }
          if (p.kind === 'slow')   { S.slow = 7;    burst(p.x, p.y, '#3ddc97', 16, 160); }
          renderBuffs();
        }
      }
    }

    $('hud-score').textContent = fmt(S.score);
    $('hud-coins').textContent = fmt(S.coins);
  }

  function die() {
    mode = MODE.DYING;
    S.dieTimer = 0.85;
    S.shake = 1;
    const sk = skinById(skinId);
    burst(S.shipX, S.shipY, sk.body, 34, 300);
    burst(S.shipX, S.shipY, '#ffd166', 22, 200);
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
  }

  /* ================= الرسم ================= */
  function drawShip(c, x, y, r, sk, tilt, thrust) {
    c.save();
    c.translate(x, y);
    c.rotate(tilt);

    if (thrust) {
      const f = r * (1.0 + Math.random() * 0.55);
      const g = c.createLinearGradient(0, r * 0.5, 0, r * 0.5 + f);
      g.addColorStop(0, sk.flame);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(-r * 0.32, r * 0.45);
      c.lineTo(0, r * 0.5 + f);
      c.lineTo(r * 0.32, r * 0.45);
      c.closePath();
      c.fill();
    }

    c.fillStyle = sk.body;
    c.beginPath();
    c.moveTo(0, -r * 1.2);
    c.quadraticCurveTo(r * 0.62, -r * 0.1, r * 0.55, r * 0.55);
    c.lineTo(0, r * 0.28);
    c.lineTo(-r * 0.55, r * 0.55);
    c.quadraticCurveTo(-r * 0.62, -r * 0.1, 0, -r * 1.2);
    c.closePath();
    c.fill();

    c.fillStyle = 'rgba(0,0,0,.28)';
    c.beginPath();
    c.moveTo(r * 0.5, r * 0.15);
    c.lineTo(r * 0.92, r * 0.72);
    c.lineTo(r * 0.4, r * 0.55);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(-r * 0.5, r * 0.15);
    c.lineTo(-r * 0.92, r * 0.72);
    c.lineTo(-r * 0.4, r * 0.55);
    c.closePath();
    c.fill();

    c.fillStyle = sk.trim;
    c.beginPath();
    c.moveTo(0, -r * 0.95);
    c.lineTo(r * 0.2, -r * 0.15);
    c.lineTo(-r * 0.2, -r * 0.15);
    c.closePath();
    c.fill();

    c.fillStyle = 'rgba(255,255,255,.85)';
    c.beginPath();
    c.arc(0, -r * 0.3, r * 0.17, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function drawRock(c, o) {
    c.save();
    c.translate(o.x, o.y);
    c.rotate(o.rot);
    const g = c.createRadialGradient(-o.r * 0.3, -o.r * 0.35, o.r * 0.15, 0, 0, o.r);
    g.addColorStop(0, `hsl(${222 + o.hue},22%,44%)`);
    g.addColorStop(1, `hsl(${222 + o.hue},28%,20%)`);
    c.fillStyle = g;
    c.beginPath();
    for (let i = 0; i < o.pts.length; i++) {
      const p = o.pts[i];
      const px = Math.cos(p.a) * o.r * p.d, py = Math.sin(p.a) * o.r * p.d;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,.35)';
    c.lineWidth = 1.5;
    c.stroke();
    c.fillStyle = 'rgba(0,0,0,.22)';
    c.beginPath(); c.arc(o.r * 0.25, o.r * 0.1, o.r * 0.2, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(-o.r * 0.3, o.r * 0.35, o.r * 0.12, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function drawPickup(c, p) {
    const bob = Math.sin(p.sp) * 1.5;
    c.save();
    c.translate(p.x, p.y + bob);
    if (p.kind === 'coin') {
      c.fillStyle = '#ffcc4d';
      c.beginPath(); c.arc(0, 0, p.r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = Math.max(1, p.r * 0.18);
      c.beginPath(); c.arc(0, 0, p.r * 0.58, 0, Math.PI * 2); c.stroke();
    } else {
      const col = p.kind === 'shield' ? '#7be3ff' : p.kind === 'magnet' ? '#b98cff' : '#3ddc97';
      c.shadowColor = col; c.shadowBlur = 14;
      c.fillStyle = 'rgba(10,16,40,.9)';
      c.strokeStyle = col; c.lineWidth = 2;
      const s = p.r;
      c.beginPath();
      if (c.roundRect) c.roundRect(-s, -s, s * 2, s * 2, s * 0.45);
      else c.rect(-s, -s, s * 2, s * 2);
      c.fill(); c.stroke();
      c.shadowBlur = 0;
      c.font = `${Math.round(p.r * 1.25)}px system-ui,"Segoe UI Emoji",sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(p.kind === 'shield' ? '🛡' : p.kind === 'magnet' ? '🧲' : '⏳', 0, 1);
    }
    c.restore();
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (S.shake > 0) {
      const m = S.shake * 9;
      ctx.translate(rnd(-m, m), rnd(-m, m));
    }

    for (const st of stars) {
      ctx.fillStyle = `rgba(200,220,255,${st.a})`;
      ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
    }

    if (S.slow > 0) { ctx.fillStyle = 'rgba(61,220,151,.06)'; ctx.fillRect(0, 0, W, H); }

    for (const p of S.pickups) drawPickup(ctx, p);
    for (const o of S.rocks) drawRock(ctx, o);

    for (const p of S.parts) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (mode === MODE.PLAY || mode === MODE.PAUSE) {
      const sr = shipR();
      const blink = S.invuln > 0 && Math.floor(S.invuln * 12) % 2 === 0;
      if (!blink) {
        const tilt = clamp(S.shipVX / (W * 3), -0.42, 0.42);
        drawShip(ctx, S.shipX, S.shipY, sr, skinById(skinId), tilt, mode === MODE.PLAY);
      }
      if (S.shield > 0) {
        ctx.strokeStyle = `rgba(123,227,255,${0.45 + 0.25 * Math.sin(S.t * 6)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(S.shipX, S.shipY, sr * 1.75, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ================= الحلقة ================= */
  let last = 0;
  function frame(ts) {
    if (!last) last = ts;
    const dt = Math.min(0.034, (ts - last) / 1000);
    last = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  /* ================= شارات القوى ================= */
  function renderBuffs() {
    const box = $('buffs');
    const items = [];
    if (S.shield > 0) items.push(['🛡', S.shield / 14, '#7be3ff']);
    if (S.magnet > 0) items.push(['🧲', S.magnet / 9, '#b98cff']);
    if (S.slow > 0)   items.push(['⏳', S.slow / 7, '#3ddc97']);
    if (!items.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = items.map(([ic, p, c]) =>
      `<div class="buff"><i>${ic}</i><span class="bar"><b style="width:${Math.round(clamp(p,0,1)*100)}%;background:${c}"></b></span></div>`
    ).join('');
  }

  /* ================= التنقل بين الشاشات ================= */
  const SCREENS = ['scr-menu', 'scr-over', 'scr-shop', 'scr-board', 'scr-how', 'scr-pause'];
  function show(id) {
    SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
    $('hud').classList.add('hidden');
  }
  function showGameplayUI() {
    SCREENS.forEach((s) => $(s).classList.add('hidden'));
    $('hud').classList.remove('hidden');
  }

  function refreshMenu() {
    $('stat-best').textContent = fmt(best);
    $('stat-wallet').textContent = fmt(wallet);
  }

  /* ================= بدء / نهاية الجولة ================= */
  function startGame() {
    resetRound();
    renderBuffs();
    mode = MODE.PLAY;
    showGameplayUI();
    $('hud-score').textContent = '0';
    $('hud-coins').textContent = '0';
    API.startRound();
  }

  function showGameOver() {
    mode = MODE.OVER;
    const sc = Math.floor(S.score);
    wallet += S.coins;
    set(LS.wallet, wallet);

    const isBest = sc > best;
    if (isBest) { best = sc; set(LS.best, best); }

    $('over-title').textContent = isBest ? '🎉 رقم قياسي جديد!' : 'انتهت الجولة!';
    $('over-score').textContent = fmt(sc);
    $('over-sub').innerHTML = `أفضل نتيجة: <b>${fmt(best)}</b> · جمعت <b>${fmt(S.coins)}</b> 🪙`;
    $('btn-save').disabled = false;
    $('btn-save').textContent = '💾 سجّل نتيجتك';

    const canRevive = !S.revived && sc > 50 && Ads.canReward();
    $('revive-row').classList.toggle('hidden', !canRevive);

    show('scr-over');
    refreshMenu();
    Ads.onGameOver();
  }

  function revive() {
    $('btn-revive').disabled = true;
    Ads.showRewarded().then((ok) => {
      $('btn-revive').disabled = false;
      if (!ok) { toast('تعذّر عرض الإعلان، حاول لاحقاً'); return; }
      S.revived = true;
      S.rocks.length = 0;
      S.invuln = 2.5;
      S.shield = 6;
      mode = MODE.PLAY;
      showGameplayUI();
      renderBuffs();
      burst(S.shipX, S.shipY, '#7be3ff', 26, 220);
    });
  }

  /* ================= إدخال الاسم ================= */
  function askName() {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'screen';
      wrap.innerHTML =
        '<div class="panel"><h2>اسمك في القائمة</h2>' +
        '<input id="nm-in" maxlength="20" placeholder="اكتب اسمك" ' +
        'style="width:100%;padding:13px;border-radius:14px;border:1px solid var(--line);' +
        'background:rgba(255,255,255,.06);color:var(--ink);font-family:inherit;font-size:16px;text-align:center">' +
        '<button class="btn primary big" id="nm-ok">حفظ</button>' +
        '<button class="btn ghost" id="nm-no">إلغاء</button></div>';
      $('stage').appendChild(wrap);
      const input = wrap.querySelector('#nm-in');
      input.value = get(LS.name, '') || '';
      setTimeout(() => input.focus(), 60);

      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('#nm-ok').onclick = () => {
        const v = input.value.trim().slice(0, 20);
        if (!v) { input.focus(); return; }
        set(LS.name, v);
        done(v);
      };
      wrap.querySelector('#nm-no').onclick = () => done(null);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') wrap.querySelector('#nm-ok').click(); });
    });
  }

  /* ================= لوحة الأبطال ================= */
  function openBoard() {
    show('scr-board');
    const list = $('board-list');
    list.innerHTML = '<li class="muted">جاري التحميل…</li>';
    API.top().then((d) => {
      const rows = (d && d.rows) || [];
      if (!rows.length) { list.innerHTML = '<li class="muted">لا توجد نتائج بعد — كن الأول!</li>'; return; }
      const me = get(LS.name, '');
      list.innerHTML = rows.map((r, i) => {
        const mine = me && r.name === me ? ' me' : '';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
        return `<li class="${mine}"><span class="rk">${medal}</span>` +
               `<span class="nm"></span><span class="sc">${fmt(r.score)}</span></li>`;
      }).join('');
      // إدراج الأسماء كنص لتفادي أي HTML من المستخدمين
      list.querySelectorAll('.nm').forEach((el, i) => { el.textContent = rows[i].name; });
      if (d.offline) list.insertAdjacentHTML('beforeend', '<li class="muted">(نتائج محفوظة على جهازك — الخادم غير متاح)</li>');
    });
  }

  /* ================= المتجر ================= */
  function drawSkinPreview(cv, sk) {
    const c = cv.getContext('2d');
    const d = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = 56 * d; cv.height = 56 * d;
    cv.style.width = '56px'; cv.style.height = '56px';
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, 56, 56);
    drawShip(c, 28, 32, 17, sk, 0, false);
  }

  function openShop() {
    show('scr-shop');
    $('shop-wallet').textContent = fmt(wallet);
    const grid = $('shop-grid');
    grid.innerHTML = '';
    SKINS.forEach((sk) => {
      const has = owned.indexOf(sk.id) !== -1;
      const active = skinId === sk.id;
      const el = document.createElement('div');
      el.className = 'skin' + (has ? ' owned' : '') + (active ? ' active' : '');
      el.innerHTML = `<canvas></canvas><div class="nm"></div>` +
        `<div class="pr">${active ? 'مستخدمة الآن' : has ? 'اضغط للاستخدام' : fmt(sk.price) + ' 🪙'}</div>`;
      el.querySelector('.nm').textContent = sk.name;
      drawSkinPreview(el.querySelector('canvas'), sk);
      el.onclick = () => {
        if (has) { skinId = sk.id; set(LS.skin, skinId); openShop(); return; }
        if (wallet < sk.price) { toast('عملاتك غير كافية — العب أكثر!'); return; }
        wallet -= sk.price; set(LS.wallet, wallet);
        owned.push(sk.id); set(LS.owned, owned);
        skinId = sk.id; set(LS.skin, skinId);
        toast('تم شراء ' + sk.name + ' 🎉');
        openShop(); refreshMenu();
      };
      grid.appendChild(el);
    });
  }

  /* ================= المشاركة ================= */
  function share() {
    const sc = fmt(Math.floor(S.score));
    const text = `سجّلت ${sc} نقطة في لعبة نيزك 🚀 هل تتفوّق عليّ؟`;
    const url = location.href.split('#')[0];
    if (navigator.share) {
      navigator.share({ title: 'نيزك', text: text, url: url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text + ' ' + url)
        .then(() => toast('تم نسخ الرابط ✅'))
        .catch(() => toast('انسخ الرابط من شريط المتصفح'));
    } else {
      toast('انسخ الرابط من شريط المتصفح');
    }
  }

  /* ================= الإدخال ================= */
  function pointerX(e) {
    const r = canvas.getBoundingClientRect();
    return clamp(e.clientX - r.left, 0, W);
  }
  canvas.addEventListener('pointerdown', (e) => { S.targetX = pointerX(e); canvas.setPointerCapture?.(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { S.targetX = pointerX(e); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const keys = {};
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { keys[e.key] = true; e.preventDefault(); }
    if (e.key === 'Escape' && mode === MODE.PLAY) pause();
    if (e.key === ' ' && (mode === MODE.MENU || mode === MODE.OVER)) { e.preventDefault(); startGame(); }
  });
  window.addEventListener('keyup', (e) => { keys[e.key] = false; });
  setInterval(() => {
    if (mode !== MODE.PLAY) return;
    const step = W * 0.045;
    if (keys.ArrowLeft) S.targetX = clamp(S.targetX - step, 0, W);
    if (keys.ArrowRight) S.targetX = clamp(S.targetX + step, 0, W);
  }, 16);

  /* ================= الإيقاف المؤقت ================= */
  function pause() {
    if (mode !== MODE.PLAY) return;
    mode = MODE.PAUSE;
    show('scr-pause');
  }
  function resume() {
    if (mode !== MODE.PAUSE) return;
    mode = MODE.PLAY;
    last = 0;
    showGameplayUI();
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  /* ================= ربط الأزرار ================= */
  $('btn-play').onclick = startGame;
  $('btn-again').onclick = startGame;
  $('btn-shop').onclick = openShop;
  $('btn-board').onclick = openBoard;
  $('btn-how').onclick = () => show('scr-how');
  $('btn-home').onclick = () => { show('scr-menu'); mode = MODE.MENU; refreshMenu(); };
  $('btn-pause').onclick = pause;
  $('btn-resume').onclick = resume;
  $('btn-quit').onclick = () => { mode = MODE.DYING; S.dieTimer = 0; showGameOver(); };
  $('btn-revive').onclick = revive;
  $('btn-share').onclick = share;
  $('btn-save').onclick = function () {
    const btn = this;
    askName().then((name) => {
      if (!name) return;
      btn.disabled = true;
      btn.textContent = 'جارٍ الإرسال…';
      API.submit(name, Math.floor(S.score), S.coins).then((d) => {
        btn.textContent = d && d.offline ? '💾 حُفظت على جهازك' : '✅ تم التسجيل';
        if (d && d.rank) toast('ترتيبك: #' + d.rank);
        else if (d && d.offline) toast('الخادم غير متاح — حُفظت محلياً');
      });
    });
  };
  document.querySelectorAll('[data-back]').forEach((b) => {
    b.onclick = () => { show(mode === MODE.OVER ? 'scr-over' : 'scr-menu'); };
  });

  /* ================= التشغيل ================= */
  $('year').textContent = new Date().getFullYear();
  resize();
  refreshMenu();
  show('scr-menu');
  Ads.init();
  requestAnimationFrame(frame);
})();
