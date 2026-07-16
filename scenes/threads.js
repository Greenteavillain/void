// ─────────────────────────────────────────────────────────────────────────────
// 장면 2 — 실뭉치 (홖 thread field)
//
// 껍데기(index.html)가 카메라·rAF·시간(K60)을 쥐고, 이 파일은 그림만 그린다.
// frame(now, K60, attractors) 의 attractors 는 껍데기가 **프레임당 한 번** 뽑은 손 어트랙터 목록
// (손바닥 + 손끝). 이 작품은 손끝까지 쓰므로 손 목록이 아니라 어트랙터 목록을 받는다.
//
// 점은 art/points.bin 에 구워져 있다. 원래는 SVG path 1,314개에 getPointAtLength 를 40,127번
// 불러 매번 유도했는데 그게 2,250ms — 로딩의 98%였다. 그림은 고정이니 구워두면 ~20ms.
// (굽기: tools/bake.sh · 검증: test/bake-test.html)
// ─────────────────────────────────────────────────────────────────────────────

import { TUNE as HTUNE } from '../hand/hand-source.js';

// ── 사인 룩업테이블 ──
// 점마다 매 프레임 삼각함수를 부르면 저사양에서 병목 → 4096칸 LUT로 대체
const LUT_N = 4096, TWO_PI = 6.28318530718, HALF_PI = 1.57079632679;
const SIN = new Float32Array(LUT_N);
for (let i = 0; i < LUT_N; i++) SIN[i] = Math.sin(i / LUT_N * TWO_PI);
const LUT_S = LUT_N / TWO_PI;
const lsin = (x) => SIN[((x * LUT_S) | 0) & (LUT_N - 1)];
const lcos = (x) => SIN[(((x + HALF_PI) * LUT_S) | 0) & (LUT_N - 1)];

const VB_W = 944.53, VB_H = 925.38;

export function create(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });

  // ── 튜닝 파라미터 ──
  const P = {
    sampleEvery: 64,   // 구울 때 쓴 값 — 작은 화면에서 점을 솎을 때 기준으로 쓴다
    minPts: 12, maxPts: 58,

    restK:   0.045,    // 제자리로 당기는 스프링 강도 (작을수록 출렁임 큼)
    damp:    0.86,     // 감쇠 (낮을수록 빨리 멈춤 / 높을수록 오래 출렁)
    radius:  150,      // 커서 영향 반경 (월드 단위)
    push:    1.25,     // 커서에서 바깥으로 밀어내는 힘 (실이 갈라짐)
    brush:   0.24,     // 마우스 이동방향으로 끌리는 힘 ("샤라락"의 핵심)
    maxMV:   46,       // 마우스 속도 클램프

    floatAmp: 1.25,    // 가만히 있을 때 부유 진폭
    floatF1: 0.00055, floatF2: 0.00102,

    line: 0.35,        // 실 두께 (css px, 스케일 무관 고정)
    aWhite: 1.0, aCyan: 1.0, aRed: 1.0,
    margin: 0.94       // 화면 대비 그림 크기 (여백)
  };

  let cssW = 0, cssH = 0, dpr = 1;
  let scale = 1, ox = 0, oy = 0; // 월드→스크린 변환

  function resize() {
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 이후 그리기는 css px 기준

    scale = Math.min(cssW / VB_W, cssH / VB_H) * P.margin;
    ox = (cssW - VB_W * scale) / 2;
    oy = (cssH - VB_H * scale) / 2;
  }
  resize();
  const isSmall = Math.min(cssW, cssH) < 700;   // 모바일이면 반경 조정
  if (isSmall) P.radius = 120;

  const COLOR_BY_IDX = [
    'rgba(255,255,255,' + P.aWhite + ')',
    'rgba(88,194,229,' + P.aCyan + ')',
    'rgba(231,72,101,' + P.aRed + ')'
  ];

  let px, py, rx, ry, vx, vy, seed, sx, sy;   // Float32Array
  let strokes = [];                            // {start, count, color}
  let N = 0, ready = false;

  // ── 움켜쥐기 (치대기) ──
  // 주먹을 쥐면 반경 안의 실이 주먹에 잡힌다: 잡힌 점의 스프링 목표가 제자리 대신
  // "주먹 + 잡던 순간의 오프셋 × 오므림"이 된다. 끌면 실이 제자리 스프링과 주먹 사이에서
  // 늘어나고, 펴는 순간 목표가 제자리로 돌아가 전부 샤라락 튕겨 돌아간다 — 이게 보상.
  //
  // ★ 오프셋을 "잡던 순간의 현재 위치" 기준으로 저장하므로 잡는 순간엔 목표 = 현위치,
  //   즉 아무것도 튀지 않는다. 힘은 끌기 시작할 때만 생긴다.
  // ★ 오므림(squeeze)은 openness 를 그대로 쓴다 — 실측 주먹 0.81 ~ 잡힘 문턱 1.15 를
  //   [0.35, 1.0] 으로 사상. 살짝 쥐면 느슨하게 들리고 꽉 쥐면 뭉치가 조여든다. 스위치가 아니라 악력.
  const GRAB_R = 150;          // 잡는 반경 (월드) — 손바닥 영향 반경과 같게
  const SLOTS = 2;             // 손 최대 2개

  // ── 당김 느낌 토글 ── ⚙ 패널에서 각각 켜고 꺼서 효과를 비교할 수 있다.
  // "실을 잡아당기는 느낌이 안 든다"의 원인 분석에서 나온 다섯 레버:
  // 물리에 '실'이 없다(점들이 이웃과 연결 안 됨)는 구조적 결핍이 몸통, 나머지는 양념.
  const G = {
    tension: true,      // ① 장력 전파 — 잡힌 점의 같은 실 이웃(±M점)이 감쇠 가중치로 딸려옴.
                        //    없으면 실마다 V자로 꺾여, 수천 개의 V가 매끈한 막(혜성꼬리)으로 읽힌다.
    strokeWhole: false, // ② 실 통째로 잡기 — 원판에 걸린 실의 전 구간을 잡음(실이 뭉치에서 뽑혀 나옴).
                        //    켜면 ①은 의미 없어진다(전체가 이미 잡히므로). 가장 과격한 레버.
    resistance: true,   // ③ 저항 — 잡는 스프링을 약하게(×4→×1.3). 빨리 끌수록 뭉치가 뒤처지며 늘어난다.
                        //    당김의 감각은 추적 정확도가 아니라 저항에서 온다 — ×4로 올렸던 게 촉감을 죽였다.
    fistWidth: true,    // ④ 주먹 폭 — 오므림 바닥 0.35→0.7. 핀셋(한 점 수렴)이 아니라 주먹 한 줌.
    life: true,         // ⑤ 생기 — 잡힌 실에도 부유를 절반 남김. 유리처럼 얼지 않게.
    neighborM: 6,       // ① 의 이웃 범위(점 개수). 점 간격 ~64월드 → 6점 ≈ 실 400 정도가 딸려옴
  };

  let held, heldW, hox, hoy;   // held[i]: 0=자유, s+1=슬롯 / heldW: 잡힌 세기 0..1 / 오프셋(월드)
  const slotX = new Float32Array(SLOTS), slotY = new Float32Array(SLOTS), slotSq = new Float32Array(SLOTS);
  const slotUsed = [false, false];
  const grabbers = new Map();  // 손 id → 슬롯
  const squeezeOf = (open) => {
    const floor = G.fistWidth ? 0.7 : 0.35;                        // ④
    return Math.min(1, Math.max(floor, floor + (open - 0.81) * ((1 - floor) / 0.34)));
  };

  function releaseAll() {
    if (held) { held.fill(0); heldW.fill(0); }
    grabbers.clear();
    slotUsed[0] = slotUsed[1] = false;
  }

  // ── 잡기 ── 실(스트로크) 구조를 따라 잡는다.
  //   기본: 원판에 걸린 점만 (heldW=1) — 예전 동작
  //   ① tension: 같은 실을 따라 ±M 이웃도 선형 감쇠 가중치로 — V자가 둥근 고리가 되고 이웃이 딸려옴
  //   ② strokeWhole: 걸린 실 전체 — 실이 통째로 뽑혀 나옴 (①을 덮어씀)
  function capture(slot, wx, wy) {
    const R2 = GRAB_R * GRAB_R, mark = slot + 1, M = G.neighborM;
    const hit = new Uint8Array(64), dist = new Float32Array(64);   // 획당 최대 58점
    for (const st of strokes) {
      const b = st.start, n = st.count;
      let any = false;
      for (let j = 0; j < n; j++) {
        const i = b + j, dx = px[i] - wx, dy = py[i] - wy;
        hit[j] = (dx * dx + dy * dy < R2) ? 1 : 0;
        if (hit[j]) any = true;
      }
      if (!any) continue;
      if (G.strokeWhole) {
        for (let j = 0; j < n; j++) mark1(b + j, mark, wx, wy, 1);
      } else if (G.tension) {
        // 닫힌 실을 따라 "가장 가까운 잡힌 점까지의 점 개수" — 원형이라 양방향 완화 2회면 수렴
        for (let j = 0; j < n; j++) dist[j] = hit[j] ? 0 : 1e3;
        for (let r = 0; r < 2; r++) {
          for (let j = 0; j < n; j++) { const p = (j - 1 + n) % n; if (dist[p] + 1 < dist[j]) dist[j] = dist[p] + 1; }
          for (let j = n - 1; j >= 0; j--) { const q = (j + 1) % n; if (dist[q] + 1 < dist[j]) dist[j] = dist[q] + 1; }
        }
        for (let j = 0; j < n; j++) if (dist[j] <= M) mark1(b + j, mark, wx, wy, 1 - dist[j] / (M + 1));
      } else {
        for (let j = 0; j < n; j++) if (hit[j]) mark1(b + j, mark, wx, wy, 1);
      }
    }
  }
  function mark1(i, mark, wx, wy, w) {
    if (held[i] && held[i] !== mark) return;       // 다른 손이 이미 잡은 점은 뺏지 않는다
    if (held[i] === mark && heldW[i] >= w) return;
    held[i] = mark; heldW[i] = w; hox[i] = px[i] - wx; hoy[i] = py[i] - wy;
  }

  function build(buf) {
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'TFLD')
      throw new Error('art/points.bin 형식이 아님');
    const bakedN = dv.getUint32(8, true);
    const nStrokes = dv.getUint32(12, true);
    const HEAD = 28, SB = nStrokes * 8;
    const baked = new Float32Array(buf, HEAD + SB, bakedN * 2);

    // 작은 화면에선 점을 솎아 부하를 낮춘다. 굽기는 조밀한 쪽(64)으로만 해두고 여기서 줄인다.
    // 주의: 원본은 클램프(maxPts=58) 후 개수가 정해지므로, 가장 긴 획에서는 원본의 92 설정보다
    //       점이 조금 더 적어진다. 폰에서만 해당되고 육안 차이는 없다.
    const decim = isSmall ? P.sampleEvery / 92 : 1;   // 64/92 ≈ 0.696

    const counts = new Int32Array(nStrokes);
    let total = 0;
    for (let k = 0; k < nStrokes; k++) {
      const n0 = dv.getUint32(HEAD + k * 8, true);
      const n = decim === 1 ? n0 : Math.max(P.minPts, Math.round(n0 * decim));
      counts[k] = n; total += n;
    }

    N = total;
    px = new Float32Array(N); py = new Float32Array(N);
    rx = new Float32Array(N); ry = new Float32Array(N);
    vx = new Float32Array(N); vy = new Float32Array(N);
    seed = new Float32Array(N);
    sx = new Float32Array(N); sy = new Float32Array(N); // 화면좌표 캐시(곡선용)
    held = new Uint8Array(N); heldW = new Float32Array(N);                            // 움켜쥐기
    hox = new Float32Array(N); hoy = new Float32Array(N);

    let idx = 0, src = 0;
    for (let k = 0; k < nStrokes; k++) {
      const n0 = dv.getUint32(HEAD + k * 8, true);
      const cls = dv.getUint32(HEAD + k * 8 + 4, true);
      const n = counts[k], start = idx;
      for (let j = 0; j < n; j++) {
        const s = src + (n === n0 ? j : Math.round(j * n0 / n) % n0);   // 솎을 때만 재색인
        rx[idx] = px[idx] = baked[s * 2];
        ry[idx] = py[idx] = baked[s * 2 + 1];
        seed[idx] = Math.random() * 6.2831853;   // 부유 위상 — 매번 달라도 되는 값이라 굽지 않음
        idx++;
      }
      strokes.push({ start: start, count: n, color: COLOR_BY_IDX[cls] || COLOR_BY_IDX[0] });
      src += n0;
    }
    // 원본 문서 순서 그대로 그림(색이 자연스럽게 교차) — 정렬하지 않음
    ready = true;
  }

  // 점을 미리 받아둔다 (장면을 안 열어도 백그라운드에서 받아지게)
  const loaded = fetch(new URL('../art/points.bin', import.meta.url))
    .then(r => { if (!r.ok) throw new Error(`art/points.bin 로드 실패 (${r.status})`); return r.arrayBuffer(); })
    .then(build);

  // ── 포인터 ──
  // 마우스는 지우지 않고 "어트랙터 1개짜리 입력원"으로 남긴다 (손 폴백 겸 디버그 기준점).
  let mWX = -1e9, mWY = -1e9, pWX = -1e9, pWY = -1e9;
  let mvx = 0, mvy = 0, active = false;

  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    mWX = (clientX - r.left - ox) / scale;
    mWY = (clientY - r.top - oy) / scale;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (!active) { active = true; pWX = mWX; pWY = mWY; }
    toWorld(e.clientX, e.clientY);
  }, { passive: true });
  canvas.addEventListener('pointerdown', (e) => {
    active = true; toWorld(e.clientX, e.clientY); pWX = mWX; pWY = mWY;
  }, { passive: true });
  const leave = () => { active = false; mWX = mWY = -1e9; mvx = mvy = 0; };
  canvas.addEventListener('pointerleave', leave, { passive: true });
  canvas.addEventListener('pointercancel', leave, { passive: true });
  canvas.addEventListener('pointerup', leave, { passive: true });

  // ── 어트랙터 ──
  // 물리 루프는 "밀어내는 것들의 목록"만 안다 — 마우스인지 손인지 모른다.
  // SoA(배열 분리)로 두는 이유: 안쪽 루프가 4만 점 × 어트랙터 수만큼 돌기 때문에
  // 객체 프로퍼티 접근을 넣으면 그대로 프레임을 잡아먹는다.
  const AMAX = 16;   // 손 2개 × (손바닥1 + 손끝5) = 12, + 마우스 1
  const AX = new Float32Array(AMAX), AY = new Float32Array(AMAX);
  const AVX = new Float32Array(AMAX), AVY = new Float32Array(AMAX);
  const AR = new Float32Array(AMAX), AW = new Float32Array(AMAX);
  let AN = 0;

  let smooth = true;                 // 적응형 LOD: 느려지면 곡선→직선으로 폴백
  let slowFrames = 0, fastFrames = 0, dtAvg = 16;
  let SKIP_RENDER = false;

  return {
    name: '실뭉치',
    canvas,
    loaded,
    resize,
    P,          // 조절 패널이 직접 만진다 (값을 바꾸면 다음 프레임부터 적용)
    G,          // 움켜쥐기 토글 — 잡기 방식(tension/strokeWhole)은 다음 잡기부터, 나머지는 즉시
    get ready() { return ready; },
    stats: () => ready ? `실 ${N.toLocaleString()}점` : '실을 엮는 중…',
    /** 장면을 떠날 때 — 실을 제자리로 돌려놔서 돌아왔을 때 휘저은 자국이 안 남게 */
    deactivate() {
      if (!ready) return;
      releaseAll();
      for (let i = 0; i < N; i++) { px[i] = rx[i]; py[i] = ry[i]; vx[i] = 0; vy[i] = 0; }
      leave();
    },

    /**
     * @param now  rAF 타임스탬프
     * @param K60  이번 프레임이 60Hz 한 프레임의 몇 배인가 (껍데기가 계산해서 넘김)
     * @param attractors 껍데기가 프레임당 한 번 뽑은 손 어트랙터(손바닥+손끝), 없으면 null
     */
    frame(now, K60, attractors) {
      if (!ready) return;
      // 크기가 0이면 다시 재본다 — 페이지가 화면에 그려지기 전에 로드되면(미리보기 탭,
      // 디스플레이가 늦게 붙는 전시장) resize()가 0을 캐시한 채 영원히 멈춰 있게 된다.
      if (!cssW || !cssH) {
        resize();
        if (!cssW || !cssH) return;
      }

      // 마우스 속도 갱신
      // ★ 단위는 "60Hz 프레임당 월드 거리". 프레임 간 이동량을 K60 으로 나눠야 주사율이 달라도
      //   같은 손놀림이 같은 brush 힘을 낸다. (손 경로는 초당 속도를 /60 해서 넣으므로 이미 이 단위)
      if (active) {
        const inst = K60 > 1e-4 ? 1 / K60 : 0;
        const a = 1 - Math.pow(0.72, K60);          // 프레임률 무관 평활 (60Hz에서 0.28)
        mvx += ((mWX - pWX) * inst - mvx) * a;
        mvy += ((mWY - pWY) * inst - mvy) * a;
        const sp = Math.hypot(mvx, mvy);
        if (sp > P.maxMV) { const c = P.maxMV / sp; mvx *= c; mvy *= c; }
        pWX = mWX; pWY = mWY;
      } else { const d = Math.pow(0.85, K60); mvx *= d; mvy *= d; }

      // ── 어트랙터 수집 ──
      AN = 0;
      if (active && AN < AMAX) {                     // 마우스
        AX[AN] = mWX; AY[AN] = mWY;
        AVX[AN] = mvx; AVY[AN] = mvy;
        AR[AN] = P.radius; AW[AN] = 1; AN++;
      }
      if (attractors) {
        for (let k = 0; k < attractors.length && AN < AMAX; k++) {
          const h = attractors[k];
          // 정규화 화면좌표 → 월드. 속도도 같은 변환을 타되 "월드/프레임"으로 맞춘다
          // (물리 루프가 프레임당 가속도를 더하므로).
          AX[AN] = (h.nx * cssW - ox) / scale;
          AY[AN] = (h.ny * cssH - oy) / scale;
          let vX = (h.nvx * cssW / scale) / 60;
          let vY = (h.nvy * cssH / scale) / 60;
          const sp = Math.hypot(vX, vY);
          if (sp > P.maxMV) { const c = P.maxMV / sp; vX *= c; vY *= c; }   // 마우스와 같은 상한
          AVX[AN] = vX; AVY[AN] = vY;
          AR[AN] = h.kind === 'tip' ? P.radius * HTUNE.tipRatio : P.radius;
          AW[AN] = h.w; AN++;
        }
      }

      // ── 움켜쥐기 갱신 ──
      // grab 은 어트랙터의 원시 상태(_grab)와 존재감(_influence)을 함께 본다 —
      // 손을 놓친 직후의 유지(hold) 구간에서는 잡은 채 두고, 존재감이 꺼지면 놓는다.
      const seenGrab = new Set();
      if (attractors) for (const a of attractors) {
        if (a.kind !== 'palm' || !(a._grab && a._influence > 0.5)) continue;
        const wx = (a.nx * cssW - ox) / scale;
        const wy = (a.ny * cssH - oy) / scale;
        let slot = grabbers.get(a._id);
        if (slot === undefined) {                          // 잡는 순간
          slot = !slotUsed[0] ? 0 : !slotUsed[1] ? 1 : -1;
          if (slot < 0) continue;
          slotUsed[slot] = true; grabbers.set(a._id, slot);
          capture(slot, wx, wy);
        }
        slotX[slot] = wx; slotY[slot] = wy; slotSq[slot] = squeezeOf(a._openness);
        seenGrab.add(a._id);
      }
      for (const [id, slot] of grabbers) {
        if (seenGrab.has(id)) continue;                    // 폈거나 손이 사라짐 → 놓기
        const mark = slot + 1;
        for (let i = 0; i < N; i++) if (held[i] === mark) { held[i] = 0; heldW[i] = 0; }
        slotUsed[slot] = false; grabbers.delete(id);       // 스프링이 알아서 샤라락 복귀시킨다
      }

      const t = now;
      const K = P.restK, D = P.damp;
      const PUSH = P.push, BR = P.brush, FA = P.floatAmp;
      const F1 = P.floatF1, F2 = P.floatF2;
      const _s = scale, _ox = ox, _oy = oy, _AN = AN;
      // ③ 저항: 잡는 스프링을 약하게 하면 빨리 끌수록 뭉치가 뒤처지며 늘어난다.
      //   실측: ×4 는 지연 ~6월드(강체처럼 붙음), ×1.3 은 ~20+ (당기는 맛)
      const KH = K * (G.resistance ? 1.3 : 4);
      const LIFE = G.life ? 0.5 : 0;                       // ⑤ 잡힌 실에 남길 부유의 비율

      // 감쇠는 프레임마다 곱해지는 값이라 시간에 대해 **지수**다. K60배 긴 프레임이면 D를 K60제곱해야
      // 같은 시간에 같은 만큼 줄어든다. (D * K60 처럼 곱하면 틀린다 — 그건 선형 취급이라
      // 고주사율에서 감쇠가 거의 사라져 실이 발산한다.)
      // 가속도와 위치 적분은 시간에 선형이므로 K60을 곱한다. K60=1이면 세 줄 모두 원본과 완전히 동일.
      const DK = Math.pow(D, K60);

      // ── 광역 조기탈출 ──
      // 어트랙터 전체를 감싸는 AABB. 실측 근거: 손 2개(어트랙터 12개)일 때 물리가
      // 2.6ms → 9.4ms 로 뛰고 렌더까지 15.0ms(예산 16.67ms)라 여유가 1.67ms밖에 없었다.
      // 원인은 40,127개 점이 전부 어트랙터 12개를 각각 검사한 것(약 48만 회).
      // 대부분의 점은 손 근처에 있지도 않으므로, 비교 4번으로 통째로 걷어낸다. → 1.8ms
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      for (let k = 0; k < _AN; k++) {
        const R = AR[k];
        if (AX[k] - R < bx0) bx0 = AX[k] - R;
        if (AY[k] - R < by0) by0 = AY[k] - R;
        if (AX[k] + R > bx1) bx1 = AX[k] + R;
        if (AY[k] + R > by1) by1 = AY[k] + R;
      }

      // ── 물리 업데이트 ──
      for (let i = 0; i < N; i++) {
        // 잡힌 점: 주먹 목표(오프셋×오므림)를 heldW 만큼, 제자리 스프링을 (1-heldW) 만큼.
        //   heldW=1(원판에 직접 걸림)이면 순수하게 잡히고, 딸려온 이웃(w<1)은 집과 주먹
        //   사이에서 당겨진다 — 이게 둥근 고리(bight) 모양을 만든다.
        // 밀어내기는 받지 않는다 — 쥐고 있는 손이 동시에 밀쳐내면 힘이 서로 싸운다.
        const hs = held[i];
        if (hs) {
          const g = hs - 1, w = heldW[i];
          const s = seed[i];
          const fx = lsin(t * F1 + s) * FA + lsin(t * F2 + s * 1.7) * FA * 0.5;
          const fy = lcos(t * F1 * 1.13 + s * 1.3) * FA + lcos(t * F2 * 0.91 + s) * FA * 0.5;
          const htx = slotX[g] + hox[i] * slotSq[g] + fx * LIFE;   // ⑤ 잡혀도 절반쯤 숨쉰다
          const hty = slotY[g] + hoy[i] * slotSq[g] + fy * LIFE;
          let ax = (htx - px[i]) * KH * w;
          let ay = (hty - py[i]) * KH * w;
          if (w < 1) {                                             // ① 딸려온 이웃의 집 스프링
            ax += (rx[i] + fx - px[i]) * K * (1 - w);
            ay += (ry[i] + fy - py[i]) * K * (1 - w);
          }
          const nvx = (vx[i] + ax * K60) * DK;
          const nvy = (vy[i] + ay * K60) * DK;
          vx[i] = nvx; vy[i] = nvy;
          const nx = px[i] + nvx * K60, ny = py[i] + nvy * K60;
          px[i] = nx; py[i] = ny;
          sx[i] = nx * _s + _ox; sy[i] = ny * _s + _oy;
          continue;
        }

        const s = seed[i];
        const fx = lsin(t * F1 + s) * FA + lsin(t * F2 + s * 1.7) * FA * 0.5;
        const fy = lcos(t * F1 * 1.13 + s * 1.3) * FA + lcos(t * F2 * 0.91 + s) * FA * 0.5;
        const tx = rx[i] + fx, ty = ry[i] + fy;

        let ax = (tx - px[i]) * K;
        let ay = (ty - py[i]) * K;

        const cx = px[i], cy = py[i];
        if (cx > bx0 && cx < bx1 && cy > by0 && cy < by1)   // 광역: 손 근처가 아니면 통째로 건너뜀
        for (let k = 0; k < _AN; k++) {
          const R = AR[k];
          const dx = cx - AX[k], dy = cy - AY[k];
          if (dx > -R && dx < R && dy > -R && dy < R) {   // 개별 AABB — sqrt 전에 거른다
            const d2 = dx * dx + dy * dy, R2 = R * R;
            if (d2 < R2 && d2 > 0.0001) {
              const d = Math.sqrt(d2);
              let f = 1 - d / R; f *= f;        // 부드러운 falloff
              f *= AW[k];                       // 가중치 = 손끝 세기 × 존재 히스테리시스
              const inv = 1 / d;
              ax += dx * inv * PUSH * f;        // 바깥으로 밀기
              ay += dy * inv * PUSH * f;
              ax += AVX[k] * BR * f;            // 이동방향으로 쓸기
              ay += AVY[k] * BR * f;
            }
          }
        }

        const nvx = (vx[i] + ax * K60) * DK;
        const nvy = (vy[i] + ay * K60) * DK;
        vx[i] = nvx; vy[i] = nvy;
        const nx = px[i] + nvx * K60, ny = py[i] + nvy * K60;
        px[i] = nx; py[i] = ny;
        sx[i] = nx * _s + _ox;                  // 화면좌표 미리 계산
        sy[i] = ny * _s + _oy;
      }

      // ── 렌더 ──
      if (!SKIP_RENDER) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.lineWidth = P.line;
        ctx.lineJoin = 'round';

        const SIXTH = 0.1666667;
        let curColor = '';
        ctx.beginPath();
        for (let k = 0; k < strokes.length; k++) {
          const sObj = strokes[k];
          if (sObj.color !== curColor) {
            if (curColor !== '') { ctx.strokeStyle = curColor; ctx.stroke(); ctx.beginPath(); }
            curColor = sObj.color;
          }
          const b = sObj.start, n = sObj.count;
          ctx.moveTo(sx[b], sy[b]);
          if (smooth) {
            // 닫힌 Catmull-Rom 스플라인 → 3차 베지어 (점이 적어도 매끈)
            for (let j = 0; j < n; j++) {
              const i0 = b + (j === 0 ? n - 1 : j - 1);
              const i1 = b + j;
              const i2 = b + (j + 1 >= n ? j + 1 - n : j + 1);
              const i3 = b + (j + 2 >= n ? j + 2 - n : j + 2);
              const x1 = sx[i1], y1 = sy[i1], x2 = sx[i2], y2 = sy[i2];
              const c1x = x1 + (x2 - sx[i0]) * SIXTH, c1y = y1 + (y2 - sy[i0]) * SIXTH;
              const c2x = x2 - (sx[i3] - x1) * SIXTH, c2y = y2 - (sy[i3] - y1) * SIXTH;
              ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x2, y2);
            }
          } else {
            // 저사양 폴백: 직선
            const end = b + n;
            for (let i = b + 1; i < end; i++) ctx.lineTo(sx[i], sy[i]);
            ctx.lineTo(sx[b], sy[b]);
          }
        }
        if (curColor !== '') { ctx.strokeStyle = curColor; ctx.stroke(); }
      }

      // ── 적응형 LOD: 지속적으로 느리면 곡선→직선 폴백, 빨라지면 복귀 ──
      const dt = K60 * 16.6667;
      dtAvg = dtAvg * 0.95 + dt * 0.05;
      if (dtAvg > 30) { slowFrames++; fastFrames = 0; if (slowFrames > 90 && smooth) { smooth = false; slowFrames = 0; } }
      else if (dtAvg < 18) { fastFrames++; slowFrames = 0; if (fastFrames > 180 && !smooth) { smooth = true; fastFrames = 0; } }
    },

    // 검증용
    _debug: {
      P,
      get N() { return N; },
      get AN() { return AN; },
      get view() { return { cssW, cssH, dpr, scale, ox, oy }; },
      heldCount() { let c = 0; for (let i = 0; i < N; i++) if (held[i]) c++; return c; },
      heldStats() {
        let c = 0, soft = 0, wSum = 0, wMin = 1;
        for (let i = 0; i < N; i++) if (held[i]) { c++; wSum += heldW[i]; if (heldW[i] < 1) soft++; if (heldW[i] < wMin) wMin = heldW[i]; }
        return { count: c, soft, avgW: c ? +(wSum / c).toFixed(3) : 0, minW: c ? +wMin.toFixed(3) : 0 };
      },
      firstHeld() { for (let i = 0; i < N; i++) if (held[i] && heldW[i] === 1) return i; return -1; },
      pointPos(i) { return [px[i], py[i]]; },
      /** 잡힌 점들의 무게중심 (월드) — 주먹을 따라오는지 검증용 */
      heldCentroid(slot = 0) {
        let cx = 0, cy = 0, n = 0;
        for (let i = 0; i < N; i++) if (held[i] === slot + 1) { cx += px[i]; cy += py[i]; n++; }
        return n ? { x: cx / n, y: cy / n, n } : null;
      },
      /** 잡힌 점들의 퍼짐(평균 반경, 월드) — 오므림이 조이는지 검증용 */
      heldSpread(slot = 0) {
        const c = this.heldCentroid(slot);
        if (!c) return null;
        let s = 0;
        for (let i = 0; i < N; i++) if (held[i] === slot + 1) s += Math.hypot(px[i] - c.x, py[i] - c.y);
        return s / c.n;
      },
      get grabbers() { return grabbers; },
      setSkipRender: (v) => { SKIP_RENDER = v; },
      maxDisp() {
        let m = 0;
        for (let i = 0; i < N; i++) {
          const dx = px[i] - rx[i], dy = py[i] - ry[i];
          const d = dx * dx + dy * dy;
          if (d > m) m = d;
        }
        return Math.sqrt(m);
      },
    },
  };
}
