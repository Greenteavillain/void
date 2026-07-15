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
    get ready() { return ready; },
    stats: () => ready ? `실 ${N.toLocaleString()}점` : '실을 엮는 중…',
    /** 장면을 떠날 때 — 실을 제자리로 돌려놔서 돌아왔을 때 휘저은 자국이 안 남게 */
    deactivate() {
      if (!ready) return;
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
      if (!cssW || !cssH) return;   // 숨어 있는 동안엔 그리지 않는다 (입자 장면과 같은 이유)

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

      const t = now;
      const K = P.restK, D = P.damp;
      const PUSH = P.push, BR = P.brush, FA = P.floatAmp;
      const F1 = P.floatF1, F2 = P.floatF2;
      const _s = scale, _ox = ox, _oy = oy, _AN = AN;

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
