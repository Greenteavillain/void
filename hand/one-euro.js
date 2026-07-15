// ─────────────────────────────────────────────────────────────────────────────
// 1€ 필터 — Casiez, Roussel & Vogel, CHI '12
// 원본/구현 모음: https://gery.casiez.net/1euro/
//
// 왜 이게 필요한가 (이 작품 한정 설명):
//   손 랜드마크는 매 프레임 흔들린다. 그런데 이 작품의 영혼은 brush — "손이 움직인
//   방향으로 실이 쓸리는 힘"이고, 속도는 위치의 미분이라 노이즈를 증폭한다.
//   고정 저역통과(EMA)를 걸면 트레이드오프에 갇힌다:
//     - 강하게 걸면 → 가만히 있을 때 안 떨리지만, 빠르게 휘두를 때 손이 실을 못 따라옴
//     - 약하게 걸면 → 빠른 휘두름은 살지만, 가만히 있어도 실이 부들부들 떨림
//   이 작품은 "천천히 / 빠르게" 둘 다 요구하므로(원본 힌트 문구가 그렇다) 고정 필터로는
//   원리적으로 불가능하다. 1€는 컷오프를 추정 속도에 비례해 올린다 —
//   느릴 땐 강하게 깎고, 빠를 땐 통과시킨다. 그래서 둘 다 잡힌다.
//
// 튜닝 순서 (저자들이 권장하는 순서 그대로):
//   1. beta = 0 으로 두고, 느릴 때 떨림이 사라질 때까지 minCutoff 를 낮춘다.
//   2. 빠르게 휘둘렀을 때 지연이 사라질 때까지 beta 를 올린다. 10배씩 움직일 것.
// ─────────────────────────────────────────────────────────────────────────────

/** 컷오프 주파수와 실제 dt로부터 EMA 계수를 구한다. dt가 들쭉날쭉해도 필터 특성이 일정하게 유지되는 이유가 이 식이다. */
function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class LowPass {
  constructor() { this.s = null; }
  filter(x, a) {
    this.s = (this.s === null) ? x : a * x + (1 - a) * this.s;
    return this.s;
  }
  reset() { this.s = null; }
}

export class OneEuro {
  /** @param {{minCutoff?:number, beta?:number, dCutoff?:number}} opt */
  constructor(opt = {}) {
    this.minCutoff = opt.minCutoff ?? 1.0;
    this.beta      = opt.beta      ?? 0.007;
    this.dCutoff   = opt.dCutoff   ?? 1.0;
    this.reset();
  }

  reset() {
    this._x = new LowPass();
    this._dx = new LowPass();
    this._tPrev = null;
    this._xPrev = null;
    this.speed = 0;          // 필터가 추정한 속도(단위/초). 참고용 — 호출부는 자체 미분을 쓴다.
  }

  /**
   * @param {number} x  원신호
   * @param {number} t  타임스탬프(ms) — ★ 반드시 실제 캡처 시각. 등간격이라 가정하면 안 된다.
   *                    검출 dt는 16~33ms로 흔들리는데, 그 흔들림이 그대로 속도 노이즈가 된다.
   */
  filter(x, t) {
    if (this._tPrev === null) {
      this._tPrev = t;
      this._xPrev = x;
      this._x.filter(x, 1);
      this._dx.filter(0, 1);
      return x;
    }

    let dt = (t - this._tPrev) / 1000;
    if (!(dt > 0)) dt = 1 / 60;            // 같은/역행 타임스탬프 방어 (0으로 나누면 alpha가 NaN)
    this._tPrev = t;

    const dxRaw = (x - this._xPrev) / dt;
    this._xPrev = x;

    const dxHat = this._dx.filter(dxRaw, alpha(this.dCutoff, dt));
    this.speed = dxHat;

    // 핵심 한 줄: 빠를수록 컷오프를 올려 필터를 열어준다.
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    return this._x.filter(x, alpha(cutoff, dt));
  }
}
