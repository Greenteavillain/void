// ─────────────────────────────────────────────────────────────────────────────
// 장면 1 — 입자 분사 (원본 void)
//
// 껍데기(index.html)가 카메라·rAF·시간(k)을 쥐고, 이 파일은 그림만 그린다.
// frame(now, k, hands) 의 hands 는 껍데기가 **프레임당 한 번** 뽑아서 넘겨주는 손 목록.
//   마우스 이동 = 손 이동 / 마우스 클릭 = 움켜쥐기 / 클릭 유지 = 움켜쥔 채 유지
//   마우스와 달리 손은 두 개다 — 양손으로 각각 분사할 수 있다.
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = [
  { hex: '#FFFFFF', w: 0.8 },
  { hex: '#E85160', w: 0.1 },
  { hex: '#5DC4E6', w: 0.1 },
];

const MAX_PARTICLES = 40000;
const RING_RADIUS = 300;   // 반경
const GAP_HALF = 1.5;      // ±1.5° → 총 3도

function isForbiddenDeg(deg) {
  let m = ((deg % 360) + 360) % 360;
  let mod = m % 30;
  return (mod <= GAP_HALF) || (mod >= 30 - GAP_HALF);
}

function pickColor() {
  const r = Math.random();
  let acc = 0;
  for (const c of COLORS) { acc += c.w; if (r <= acc) return c.hex; }
  return COLORS[0].hex;
}

export function create(canvas) {
  const ctx = canvas.getContext('2d');
  const particles = [];
  const prevSpawn = new Map();   // 분사점 id → 직전 프레임 위치 (경로 분사용)
  let spawnAcc = 0;

  function fit() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width  = Math.floor(canvas.clientWidth  * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── 마우스/터치 ── 폴백 겸 디버그 경로. 손이 없어도 작품이 돈다.
  let spawning = false, spawnX = 0, spawnY = 0;
  const setSpawnPoint = (px, py) => { spawnX = px; spawnY = py; };
  const local = (cx, cy) => { const r = canvas.getBoundingClientRect(); setSpawnPoint(cx - r.left, cy - r.top); };

  canvas.addEventListener('mousedown', e => { spawning = true; local(e.clientX, e.clientY); });
  addEventListener('mouseup', () => spawning = false);
  canvas.addEventListener('mousemove', e => { if (spawning) local(e.clientX, e.clientY); });
  canvas.addEventListener('touchstart', e => {
    e.preventDefault(); spawning = true;
    const t = e.changedTouches[0]; local(t.clientX, t.clientY);
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    if (!spawning) return;
    const t = e.changedTouches[0]; local(t.clientX, t.clientY);
  }, { passive: true });
  addEventListener('touchend', () => spawning = false, { passive: true });
  addEventListener('mouseleave', () => spawning = false);

  // ── 입자 생성 ──
  //
  // s = 배율. 손이 카메라에서 멀면 작아진다 — "멀어서 작게 보이는 것"이므로
  // 길이 성질을 **전부 같은 수로** 곱한다: 링 반경, 속도, 입자 크기.
  //   · 개수는 안 건드린다 — 멀리 있는 같은 분사도 입자 수는 그대로다.
  //   · maxLife도 안 건드린다 — 속도가 s배면 이동거리가 저절로 s배가 되므로 궤적이 통째로 축소된다.
  // 하나라도 빠뜨리면 "멀어진 것"이 아니라 "다른 분사"가 된다.
  //
  // ★ (x0,y0)→(x,y) = 분사점이 이 프레임 동안 지나간 경로. 입자를 그 **선분 위에 시간순으로**
  //   흩뿌린다. 예전엔 120개를 전부 "지금 위치"에 몰아넣었다 — 분사점이 가만히 있으면 링이 같은
  //   자리에 겹쳐 쌓여 연속처럼 보이지만, 움직이면 프레임마다 링이 딴 자리에 찍혀 **뚝뚝 끊긴
  //   웨이브**로 보였다. 뿜는 건 초당 60번으로 끊겨 있는데 움직임은 연속이라 생기는 어긋남.
  //
  //   선분의 30% 지점 = 이 프레임 시간의 30% 시점이다. 그래서 이건 연속 분사의 근사가 아니라
  //   **정확한 계산**이다(프레임 안에서 등속이라는 가정만 있고, 16.7ms라 무의미하다).
  //   시뮬레이션을 잘게 쪼개는 방법도 있지만 그건 비용 4배에 여전히 근사다.
  function spawnParticles(x, y, count = 120, s = 1, x0 = x, y0 = y, k = 1) { // 수 절반 ↓
    if (particles.length > MAX_PARTICLES) return;

    for (let i = 0; i < count; i++) {
      let deg;
      for (let tries = 0; tries < 12; tries++) {
        deg = Math.random() * 360;
        if (!isForbiddenDeg(deg)) break;
      }
      const rad = deg * Math.PI / 180;

      // u = 이 입자가 프레임 안에서 태어난 시점 (0=시작, 1=지금).
      // (i + 무작위)/count 로 층화추출 — 순수 난수면 우연히 뭉치는 자리가 생긴다.
      const u = (i + Math.random()) / count;
      const cx = x0 + (x - x0) * u;          // 그 순간 분사점이 있던 자리
      const cy = y0 + (y - y0) * u;

      const speed = (12 + Math.random() * 6) * s;
      const vx = Math.cos(rad) * speed;
      const vy = Math.sin(rad) * speed;
      const r  = (3 + Math.random() * 6) * s; // 크기 두 배 ↑ (6~12px)

      // 프레임 시작에 태어난 입자는 지금 그릴 시점엔 이미 그만큼 날아가 있어야 한다.
      // (위치를 뿌리는 게 본체, 이 나이 보정은 마무리 — 프레임당 15px 정도의 효과)
      const age = (1 - u) * k;

      particles.push({
        x: cx + Math.cos(rad) * RING_RADIUS * s + vx * age,
        y: cy + Math.sin(rad) * RING_RADIUS * s + vy * age,
        vx, vy,
        r,
        color: pickColor(),
        alpha: 0.8 + Math.random() * 0.2,
        life: age,
        maxLife: 30 + Math.random() * 10
      });
    }
  }

  return {
    name: '입자 분사',
    canvas,
    resize: fit,
    /** 장면을 떠날 때 — 입자를 비워서 돌아왔을 때 옛 잔해가 안 남게 */
    deactivate() { particles.length = 0; prevSpawn.clear(); spawnAcc = 0; spawning = false; },
    stats: () => `입자 ${particles.length.toLocaleString()}개`,

    /**
     * @param now  rAF 타임스탬프
     * @param k    이번 프레임이 60Hz 한 프레임의 몇 배인가 (껍데기가 계산해서 넘김)
     * @param hands 껍데기가 프레임당 한 번 뽑은 손 목록 (없으면 null)
     */
    frame(now, k, hands) {
      // 숨어 있는 동안엔 그리지 않는다. display:none 이면 clientWidth 가 0이 되는데,
      // 그러면 입자가 (0,0) 기준 반경 300에 생겨 화면밖 판정에 즉시 걸려 전부 삭제된다 —
      // 예외 없이 조용히 사라지므로 눈치채기 어렵다.
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;

      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      // ── 분사 지점 모으기 ──
      // id 를 달아둔다 — 경로 분사는 "이 분사점이 직전 프레임엔 어디 있었나"를 알아야 한다.
      const spawners = [];
      if (spawning) spawners.push({ id: 'mouse', x: spawnX, y: spawnY, s: 1 });
      if (hands) for (const h of hands) {
        if (h.grab) spawners.push({ id: h.id, x: h.nx * W, y: h.ny * H, s: h.scale });
      }

      // 초당 생성량을 고정한다(60Hz × 120개 = 초당 7,200개). 개수는 정수여야 하므로
      // 소수점은 누적해뒀다가 넘칠 때 쓴다 — 안 그러면 고주사율에서 반올림으로 계속 손해본다.
      let count = 0;
      if (spawners.length) {
        spawnAcc += 120 * k;
        count = Math.floor(spawnAcc);
        spawnAcc -= count;
      } else {
        spawnAcc = 0;                       // 쉬는 동안 쌓아뒀다 한꺼번에 터뜨리지 않게
      }
      if (count) for (const sp of spawners) {
        const p = prevSpawn.get(sp.id);     // 직전 프레임의 자리 (없으면 = 방금 생긴 분사점)
        spawnParticles(sp.x, sp.y, count, sp.s, p ? p.x : sp.x, p ? p.y : sp.y, k);
      }
      // 다음 프레임이 경로를 그릴 수 있게 현재 위치를 남긴다. 사라진 분사점은 지운다 —
      // 안 지우면 손을 뗐다 다시 잡을 때 그 사이 이동한 거리 전체에 입자가 그어진다.
      prevSpawn.clear();
      for (const sp of spawners) prevSpawn.set(sp.id, { x: sp.x, y: sp.y });

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.life += k;                        // 수명 단위도 "60Hz 프레임" — maxLife 30~40 = 0.5~0.67초

        const scale = 1 - (p.life / p.maxLife);
        const currentR = p.r * Math.max(scale, 0);

        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, currentR * 1.5, currentR * 0.7, Math.atan2(p.vy, p.vx), 0, Math.PI * 2);
        ctx.fill();

        if (p.life > p.maxLife ||
            p.x < -20 || p.y < -20 ||
            p.x > canvas.clientWidth + 20 ||
            p.y > canvas.clientHeight + 20) {
          particles.splice(i, 1);
        }
      }
    },

    // 검증용
    _debug: { particles, get spawning() { return spawning; }, RING_RADIUS },
  };
}
