// ─────────────────────────────────────────────────────────────────────────────
// HandSource — 카메라 → 어트랙터
//
// 설계 의도: 물리/렌더는 "어트랙터 목록"만 안다. 센서가 무엇인지 전혀 모른다.
//   지금은 웹캠 + MediaPipe지만, 전시장이 암전이면 이 파일만 IR 블롭 트래킹으로
//   갈아끼우면 된다 (sample()이 같은 모양을 뱉기만 하면 됨). index.html은 손도 안 댄다.
//   → 지금(모니터 앞) / 나중(전시장) 이전 비용을 0으로 만들기 위한 경계선.
//
// 좌표계: 이 파일은 "정규화된 화면 좌표" [0,1] 까지만 책임진다.
//   월드 변환(ox/oy/scale)과 반경(P.radius)은 작품 쪽 관심사라 index.html이 한다.
// ─────────────────────────────────────────────────────────────────────────────

import { OneEuro } from './one-euro.js';

// MediaPipe 손 랜드마크 인덱스 (21개 중 우리가 쓰는 것만)
const PALM = 9;                      // 중지 MCP — 손바닥 중심의 가장 안정적인 대용물.
                                     // 손목(0)은 손을 꺾으면 크게 흔들리고, 손바닥 중심은 랜드마크에 없다.
const TIPS = [4, 8, 12, 16, 20];     // 엄지·검지·중지·약지·새끼 끝

export const TUNE = {
  // ── 활성 영역 ──────────────────────────────────────────────────────────────
  // 카메라 화면에서 이 사각형만 잘라 캔버스 전체로 편다.
  // 가장자리를 버리는 이유: 랜드마크 정확도가 무너지는 곳이자 손이 프레임을 벗어나는 곳.
  // 화면 전체([0,1])를 그대로 쓰면 가장자리에서 손이 튄다.
  ax0: 0.15, ax1: 0.85,
  ay0: 0.10, ay1: 0.70,
  mirror: true,          // 셀피 뷰. 관객이 오른쪽으로 휘두르면 실도 오른쪽으로 가야 한다.

  // ── 1€ 필터 ────────────────────────────────────────────────────────────────
  minCutoff: 1.0,        // 낮출수록: 느릴 때 떨림 ↓ / 지연 ↑
  // ★ beta 는 신호의 **단위**에 종속이다. 논문 예제값(0.007)은 픽셀 단위 신호 기준인데
  //   여기 신호는 정규화 화면좌표(0~1)라 빠른 휘두름의 속도가 초당 2 정도다.
  //   그럼 컷오프 = 1.0 + 0.007×2 = 1.014Hz → 속도 적응이 사실상 0 = 그냥 1Hz 고정 저역통과.
  //   "지연은 다 받고 이득은 하나도 못 받는" 설정이었다.
  //
  //   전 구간 실측 (검출 30회/초 → 렌더 120fps, 외삽 포함, 빠른 휘두름 초당 2.0):
  //     beta      최대 뒤처짐   평균     정지 떨림
  //     0.007       540px      308px     1.10px   ← 화면 너비의 1/3을 뒤처진다
  //     3           151         111      1.22
  //     10          109          50      1.24     ← 채택
  //     20           90          31      1.22
  //     40           72          20      1.29
  //   ★ 정지 떨림이 beta와 무관하다는 게 핵심 — 가만히 있으면 속도가 0이라 beta가 아예 안 곱해진다.
  //     그래서 올리는 데 대가가 없다. 20 이상은 수익이 줄고, 원본에 가까워져 순간적인
  //     랜드마크 오류에 취약해지므로 10에서 끊었다.
  beta: 10,
  dCutoff: 1.0,
  velEma: 0.35,          // 속도에 추가로 거는 가벼운 EMA

  // ── 30fps 검출 → 60fps 렌더 잇기 ───────────────────────────────────────────
  maxExtrapMs: 40,       // 외삽 상한. 이거 없으면 손을 놓쳤을 때 실이 무한히 날아간다.

  // ★ 톱니 제거. 검출은 초당 30번뿐인데 화면은 60~144번 그린다. 그 사이를 "필터값 + 속도×경과"로
  //   채우면, 검출이 올 때마다 위치가 **필터값으로 리셋**된다. 필터는 조금이라도 뒤처져 있으므로
  //   그 리셋이 곧 뒤로 튕김이다 → 앞서감/튕김이 초당 30번 반복 = 톱니.
  //   실측(등속 손, 프레임당 7px 이동해야 정상): 표준편차 14.1px, 실제로는 -5.9px ~ +43.9px.
  //   **앞으로만 가는 손이 뒤로 가는 프레임이 있었다.** 랜드마크 떨림을 0으로 놔도 동일 = 구조적.
  //
  //   대신 렌더용 위치를 따로 두고, **속도로 계속 굴리면서 검출과의 오차만 시상수로 흡수**한다.
  //   검출이 와도 튀지 않고 스며든다. 속도가 움직임을 만들므로 지연도 안 생긴다
  //   (오차가 있을 때만 그 오차만큼 늦게 반영될 뿐).
  trackTau: 70,          // 오차 흡수 시상수(ms). 작을수록 톱니↑ / 클수록 검출을 늦게 따라감

  // ── 존재 히스테리시스 ──────────────────────────────────────────────────────
  // 손을 놓쳤을 때 active=false로 딱 끊으면 실이 휘두르던 중에 얼어붙는다 = 버그로 보인다.
  // 대신 유지 → 서서히 놓아주면 필드가 "이완"한다. 덤으로 모션 블러 대책이기도 하다:
  // 빠른 휘두름은 탄도라서, 놓치는 그 순간이 오히려 직선 예측이 가장 잘 맞는 구간이다.
  enterFrames: 3,        // 진입: 연속 3회 검출돼야 인정 (오검출 1프레임에 실이 튀지 않게)
  enterMs: 120,          // 0 → 1 램프
  holdMs: 250,           // 놓쳐도 이만큼은 영향력 유지
  releaseMs: 400,        // 1 → 0 램프
  velDecayTau: 120,      // 유지 중 속도 감쇠 시상수(ms)

  // ── 움켜쥐기 판정 ──
  // openness = 평균( |손끝 - 손목| / |중지MCP - 손목| ), worldLandmarks(3D 미터) 기준.
  //
  // 왜 3D인가: 2D로 재면 손을 카메라 쪽으로 향했을 때 편 손도 주먹으로 보인다(원근 단축).
  // 왜 비율인가: 손 크기·카메라 거리에 무관해야 한다. 분모(손목→중지MCP)는 주먹을 쥐어도
  //   안 변하는 강체 구간이라 기준자로 적합하다.
  // 왜 엄지(4)를 빼는가: 주먹에서 엄지는 접히는 방향이 제각각이라 가장 노이즈가 크다.
  //
  // ★ MediaPipe 공식 제스처 이미지로 실측한 값 (추정 아님):
  //     fist.jpg        0.812   ← 주먹
  //     pointing_up.jpg 1.024   ← ☝️ (검지만 폄 — 사실상 주먹에 가깝다)
  //     victory.jpg     1.407   ← ✌️
  //     hands.jpg       1.747   ← 편 손
  //   같은 이미지의 손 두 개가 1.747 / 1.790 으로 2.5% 안에 들어왔고,
  //   palm 크기가 0.058~0.105m(1.8배)로 달라도 openness는 일관됐다 = 비율이 실제로 크기 불변.
  //
  // 임계값은 주먹(0.81)과 편 손(1.75) 양쪽에서 0.34씩 등거리. ☝️는 움켜쥔 것으로 친다.
  grabOn: 1.15,          // 이보다 작아지면 움켜쥠
  grabOff: 1.40,         // 이보다 커지면 폄 (히스테리시스 — 경계에서 깜빡이면 입자가 점멸한다)
  grabEma: 0.4,          // openness 평활 (낮을수록 둔하지만 안정적)

  // ── 거리 = 크기 ──
  // 화면에 손이 얼마나 크게 찍혔는가 = 카메라에서 얼마나 가까운가. (멀면 작게 찍힌다)
  // MediaPipe의 z는 손목 상대값이라 신뢰도가 낮은데, 애초에 쓸 필요가 없다 —
  // 원근이란 게 곧 "멀면 작게 보인다"이므로, 보이는 크기가 이미 거리다.
  //
  // 재는 구간: 손목(0) → 중지MCP(9), **정규화 이미지 좌표**에서.
  //   ★ 왜 이 구간인가: 손바닥 뼈라 주먹을 쥐어도 안 변한다. 손가락 끝이나 바운딩박스를 쓰면
  //     움켜쥐는 순간 크기가 쪼그라든다 — 움켜쥠이 곧 분사 트리거라 즉시 티가 난다.
  //   ★ 왜 world가 아니라 image인가: world는 실측 미터에 가까워서 거리와 무관하다(그래서
  //     openness엔 world를 쓴다). 거리를 알려면 반대로 "찍힌 크기"가 필요하다.
  //   ★ 왜 활성영역 매핑 전 좌표인가: 매핑은 x와 y를 다른 비율로 늘리므로 거리가 뒤틀린다.
  // 단위는 "영상 높이" 기준 (aspect 보정을 x에 걸었으므로 둘 다 높이 단위가 된다).
  // ★ 기준값은 카메라 화각에 따라 달라서 코드가 정할 수 없다 —
  //   화각 46°(세로) 웹캠 앞 60cm에서 손바닥뼈 9cm ≈ 0.18 로 추정한 값을 기본값으로 두되,
  //   실제로는 UI의 "현재 손 크기를 기준으로" 버튼으로 그 자리에서 맞추는 게 정답이다.
  //   (참고: 공식 테스트 사진처럼 손이 화면을 꽉 채우면 0.41 까지 나온다)
  sizeRef: 0.18,         // 이 크기일 때 배율 1.0
  sizeMin: 0.35,         // 너무 멀어도 이것보다 작아지진 않음 (0으로 사라지지 않게)
  sizeMax: 2.2,          // 너무 가까워도 이것보다 커지진 않음
  sizeEma: 0.25,         // 크기 평활. 위치보다 느려도 되고, 안정적인 게 훨씬 중요하다
                         // (배율이 떨리면 분사 전체가 맥박치듯 요동친다)

  // ── 어트랙터 배치 ──────────────────────────────────────────────────────────
  // 왜 랜드마크 21개를 다 쓰지 않는가:
  //   (1) 성능 — 실측 27,816점 기준 42개=4.3ms vs 12개=1.2ms.
  //   (2) 더 중요한 이유: 예술적으로 틀리다. 팔 길이에서 손은 ~200px, 손끝 간격은 ~40px.
  //       손끝마다 반경 150을 주면 열 개가 겹쳐 하나의 뭉개진 덩어리가 된다 = 지금보다 나쁨.
  // 그래서 역할을 나눈다: 손바닥이 "휘두름"을, 손끝이 "갈라짐"을 담당.
  palmW: 1.0,
  tipW: 0.35,
  tipRatio: 0.33,        // 손끝 반경 = P.radius * 이 값
};

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

/** 손 하나의 추적 상태. 필터는 랜드마크마다 독립. */
class Track {
  constructor() {
    const o = () => new OneEuro({ minCutoff: TUNE.minCutoff, beta: TUNE.beta, dCutoff: TUNE.dCutoff });
    this.px = o(); this.py = o();                    // 손바닥
    this.tx = TIPS.map(o); this.ty = TIPS.map(o);    // 손끝 5개
    this.reset();
  }
  reset() {
    this.x = 0; this.y = 0;            // 필터된 손바닥 (정규화 화면)
    this.vx = 0; this.vy = 0;          // 속도 (정규화 화면 / 초)
    this.tips = TIPS.map(() => ({ x: 0, y: 0 }));
    this.tMedia = null;                // 마지막 검출의 캡처 시각 (영상 클럭) — 필터 dt용
    this.tPerf = -1e9;                 // 마지막 검출의 캡처 시각 (perf 클럭) — 외삽/히스테리시스용
    this.seen = 0;
    this.influence = 0;
    this.openness = 1.75;              // 편 손에서 시작 (실측 기본값)
    this.grab = false;
    this.size = null;                  // 찍힌 손바닥 크기 (화면비 보정된 정규화 단위) = 거리의 역수
    this.scale = 1;                    // 그 크기에서 나온 배율
    this.rx = null; this.ry = null;    // 렌더용 연속 위치 (검출이 와도 안 튀는 값)
    this.rt = 0;                       // 그 위치를 마지막으로 굴린 시각
    this.px.reset(); this.py.reset();
    this.tx.forEach(f => f.reset()); this.ty.forEach(f => f.reset());
  }
}

/**
 * 어트랙터 목록(sample()의 결과)에서 손 단위 정보만 뽑는다.
 * ★ 존재 이유: sample() 은 호출할 때마다 렌더용 위치를 시간에 따라 굴린다. 한 프레임에
 *   여러 번 부르면(작품 + HUD + 미리보기) 같은 일을 세 번 하는 셈이라, 껍데기가 프레임당
 *   한 번만 sample() 하고 그 결과를 이걸로 나눠 쓴다.
 */
export function palmsOf(attractors) {
  return attractors
    .filter(a => a.kind === 'palm')
    .map(a => ({
      id: a._id,                      // 프레임 간 안정적인 손 식별자
      nx: a.nx, ny: a.ny, nvx: a.nvx, nvy: a.nvy,
      // 손을 순간적으로 놓쳐도(hold 250ms 동안) 움켜쥔 상태를 유지한다.
      // 안 그러면 검출이 한 프레임 깜빡일 때마다 분사가 끊긴다.
      grab: a._grab && a._influence > 0.5,
      openness: a._openness,
      scale: a._scale,
      size: a._size,
      influence: a._influence,
    }));
}

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * 화면에 찍힌 손바닥 크기 = 거리의 역수. 정규화 이미지 좌표(매핑 전) 기준.
 * @param lm  21개 정규화 랜드마크
 * @param aspect  영상 폭/높이. x는 폭으로, y는 높이로 나뉜 값이라 보정하지 않으면
 *                손을 기울일 때 크기가 요동친다.
 */
export function apparentSizeOf(lm, aspect = 1) {
  if (!lm || lm.length < 10) return null;
  const dx = (lm[0].x - lm[9].x) * aspect;      // 손목 → 중지MCP (주먹 쥐어도 안 변하는 손바닥 뼈)
  const dy = (lm[0].y - lm[9].y);
  const d = Math.hypot(dx, dy);
  return d > 1e-6 ? d : null;
}

/**
 * 손이 얼마나 펴져 있는가. 워커가 보내는 world 배열은 [손목, 중지MCP, 손끝 8·12·16·20].
 * @returns {number|null} openness (주먹 ~0.8, 편 손 ~1.75) — 못 재면 null
 */
export function opennessOf(W) {
  if (!W || W.length < 6) return null;
  const wrist = W[0];
  const palm = dist3(wrist, W[1]);
  if (!(palm > 1e-6)) return null;              // 0으로 나누기 방어
  let s = 0;
  for (let i = 2; i < 6; i++) s += dist3(W[i], wrist) / palm;
  return s / 4;
}

export class HandSource {
  constructor() {
    this.tracks = new Map();       // handedness label → Track
    this.worker = null;
    this.video = null;
    this.stream = null;
    this.state = 'off';            // off | starting | ready | error
    this.error = '';
    this.lastResultAt = 0;
    this.detectMs = 0;             // 검출 1회 소요(추정) — HUD용
    // ── 계측 ──
    // "빨리 움직이면 순간이동한다"의 원인을 좁히려면 두 천장을 구분해야 한다:
    //   captureFps — 카메라가 실제로 주는 초당 장수. 이게 30이면 그게 천장이고 워커를 늘려도 소용없다.
    //   detectFps  — 그중 실제로 검출한 횟수. capture 보다 한참 낮으면 워커 처리량이 천장.
    // 둘 중 뭐가 낮은지에 따라 고칠 곳이 완전히 다르다.
    this.captureFps = 0;
    this.detectFps = 0;
    this.droppedPct = 0;
    this._capT = 0; this._detT = 0;
    this._capN = 0; this._detN = 0; this._dropN = 0;
    this._lastSample = 0;
    this._rvfcHandle = null;
    this.onstate = () => {};
  }

  _setState(s, err) {
    this.state = s; this.error = err || '';
    this.onstate(s, this.error);
  }

  /** 1초 창으로 초당 횟수를 센다 (EMA보다 읽기 쉬운 정수가 나온다) */
  _rate(kind, now) {
    this[kind + 'N']++;
    const t0 = this[kind + 'T'];
    if (!t0) { this[kind + 'T'] = now; return; }
    if (now - t0 >= 1000) {
      const per = this[kind + 'N'] * 1000 / (now - t0);
      if (kind === '_cap') {
        this.captureFps = Math.round(per);
        this.droppedPct = this._capN ? Math.round(this._dropN / this._capN * 100) : 0;
        this._dropN = 0;
      } else {
        this.detectFps = Math.round(per);
      }
      this[kind + 'N'] = 0; this[kind + 'T'] = now;
    }
  }

  async start() {
    if (this.state === 'starting' || this.state === 'ready') return;
    this._setState('starting');
    try {
      // ★ file:// 로는 절대 안 된다 — getUserMedia는 보안 컨텍스트를 요구하고
      //   Chrome은 file:// 을 opaque origin으로 본다. http://localhost 로 띄울 것.
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // 해상도는 검출 속도와 무관하다 — MediaPipe가 내부에서 어차피 고정 크기로 줄인다.
          // 실측: 640×480 17.5ms vs 256×192 17.3ms (차이 없음). 그래서 굳이 낮추지 않는다.
          width:  { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60 },   // 카메라가 실제로 몇을 주는지는 info().captureFps 로 확인
        },
        audio: false,
      });
      // 카메라가 실제로 무엇을 줬는지 (요청과 다를 수 있다)
      const st = this.stream.getVideoTracks()[0].getSettings();
      this.camera = { w: st.width, h: st.height, fps: st.frameRate };

      const v = document.createElement('video');
      v.srcObject = this.stream;
      v.playsInline = true; v.muted = true;
      await v.play();
      this.video = v;

      this._spawnWorker();
      this._pump();
    } catch (e) {
      this._setState('error', String(e && e.message || e));
    }
  }

  stop() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video = null;
    this.tracks.clear();
    this._setState('off');
  }

  _spawnWorker() {
    if (this.worker) this.worker.terminate();
    const w = new Worker(new URL('./hand-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready')  { this._setState('ready'); this.lastResultAt = performance.now(); this._busy = false; }
      if (m.type === 'error')  { this._setState('error', m.message); this._busy = false; }
      if (m.type === 'hands')  {
        this._busy = false;
        this.lastResultAt = performance.now();
        this.detectMs = this.detectMs * 0.9 + (this.lastResultAt - m.tPerf) * 0.1;
        this._rate('_det', this.lastResultAt);
        this._push(m.hands, m.handedness, m.tMedia, m.tPerf, m.world, m.aspect);
      }
    };
    w.onerror = (e) => this._setState('error', e.message || 'worker error');
    w.postMessage({ type: 'init' });
    this.worker = w;
  }

  /** 프레임 펌프: 카메라가 새 프레임을 낼 때마다(rAF가 아니라) 워커로 넘긴다. */
  _pump() {
    const v = this.video;
    if (!v || !v.requestVideoFrameCallback) {
      this._setState('error', 'requestVideoFrameCallback 미지원 브라우저 (Chrome 권장)');
      return;
    }
    const onFrame = (nowPerf, meta) => {
      if (!this.video) return;
      this._rate('_cap', nowPerf);
      // 워커가 바쁘면 이 프레임은 버린다. 얼마나 버리는지가 곧 "워커를 늘려서 얻을 수 있는 양".
      // ★ 여기서 걸러야 한다 — 예전엔 버릴 프레임까지 createImageBitmap 을 해서 워커로 보냈다.
      //   어차피 워커가 버릴 것을 메인스레드가 매번 복사하고 있었던 셈.
      if (this._busy) {
        this._dropN++;
        this._rvfcHandle = v.requestVideoFrameCallback(onFrame);
        return;
      }
      // 워치독: 워커가 5초 넘게 조용하면 WebGL 컨텍스트가 날아간 것으로 보고 통째로 재생성한다.
      // MediaPipe는 컨텍스트 유실에서 스스로 못 돌아온다(공식 이슈 #4720, 2023년부터 열린 채).
      // GPU 프로세스 크래시 / 탭 discard / VRAM 고갈로 실제로 일어나며, 전시 중이면 치명적.
      if (this.state === 'ready' && nowPerf - this.lastResultAt > 5000) {
        this.lastResultAt = nowPerf;
        this._setState('starting', '');
        this._spawnWorker();
      }
      this._busy = true;
      createImageBitmap(v).then(bitmap => {
        if (!this.worker) { bitmap.close(); this._busy = false; return; }
        this.worker.postMessage({
          type: 'frame',
          bitmap,
          t: meta.mediaTime * 1000,   // 영상 클럭(ms) — MediaPipe 타임스탬프 & 필터 dt
          tMedia: meta.mediaTime * 1000,
          tPerf: nowPerf,             // perf 클럭 — 외삽은 이걸 쓴다 (검출 지연까지 보상됨)
        }, [bitmap]);
      }).catch(() => { this._busy = false; });
      this._rvfcHandle = v.requestVideoFrameCallback(onFrame);
    };
    this._rvfcHandle = v.requestVideoFrameCallback(onFrame);
  }

  /** 워커 결과 수신 → 필터 → 속도 → 움켜쥐기 → 거리(배율) */
  _push(hands, handedness, tMedia, tPerf, world, aspect = 1) {
    // 워커↔메인 계약 가드. 이 값이 빠지면 dt/age가 NaN이 되고, 예외 없이 조용히
    // "손은 인식되는데 실이 안 움직인다"가 된다. 디버깅에 몇 시간 날리는 종류라 시끄럽게 죽인다.
    if (!Number.isFinite(tMedia) || !Number.isFinite(tPerf)) {
      this._setState('error', `타임스탬프 누락 (tMedia=${tMedia}, tPerf=${tPerf}) — 워커 메시지 계약 불일치`);
      return;
    }
    // 정규화 영상좌표 → 활성영역 크롭 → 정규화 화면좌표
    const map = (p) => ({
      x: clamp01((((TUNE.mirror ? 1 - p.x : p.x)) - TUNE.ax0) / (TUNE.ax1 - TUNE.ax0)),
      y: clamp01((p.y - TUNE.ay0) / (TUNE.ay1 - TUNE.ay0)),
    });

    // ── 손 정체성 ──
    // handedness 라벨을 키로 쓰면 안 된다. MediaPipe 공식 테스트 이미지(left_hands.jpg)만 해도
    // 두 손 모두 "Left"로 나온다 — 실전에서도 관객 둘이 나란히 서거나 좌우 오검출이면 키가 충돌하고,
    // 프레임마다 순서가 바뀌면 두 손의 필터 상태가 서로 뒤바뀌어 실이 튄다.
    // 대신 손바닥 위치 최근접 매칭으로 붙인다.
    //
    // ★ 단, "마지막으로 본 자리"가 아니라 "속도로 예측한 자리"에 대고 재야 한다.
    //   카메라가 30fps라 검출 간격이 33ms인데, 세게 휘두르면 그 사이 손이 화면의 20% 넘게 건너뛴다.
    //   마지막 자리로 재면 "이건 다른 손이네" 하고 새 트랙을 만들고 →
    //   옛 트랙은 (깜빡임 대비로 일부러 넣은) hold 250ms + release 400ms 동안 **옛 자리에 얼어붙은
    //   유령**으로 남는다. 그게 "주먹이 두 개로 보이고 하나는 안 움직인다"의 정체다.
    //   예측 위치로 재면 빠른 손도 제자리를 찾아간다.
    const MATCH_BASE = 0.22;    // 기본 허용 반경 (정규화 화면)
    const MATCH_SLACK = 0.6;    // 예측 오차 여유 — 등속 가정이라 가속하면 빗나가므로 이동거리에 비례해 열어준다
    const detected = [];
    for (let i = 0; i < hands.length; i++) {
      const lm = hands[i];
      if (!lm || lm.length < 21) continue;
      detected.push({ lm, palm: map(lm[PALM]), open: opennessOf(world && world[i]),
                      size: apparentSizeOf(lm, aspect) });
    }

    const free = new Map(this.tracks);   // 아직 안 붙은 트랙
    const assign = [];                   // [track, det]

    // 가까운 쌍부터 탐욕적으로 붙인다 (손 최대 2개라 O(n²)로 충분)
    while (detected.length && free.size) {
      let best = null;
      for (const d of detected) {
        if (d._taken) continue;
        for (const [key, t] of free) {
          if (t.tMedia === null) continue;         // 아직 위치가 없는 새 트랙
          // ★ 예측: 마지막으로 본 뒤 흐른 시간만큼 속도로 밀어본다
          const gap = Math.max(0, (tMedia - t.tMedia) / 1000);
          const ex = t.x + t.vx * gap, ey = t.y + t.vy * gap;
          const r = MATCH_BASE + Math.hypot(t.vx, t.vy) * gap * MATCH_SLACK;
          const dx = d.palm.x - ex, dy = d.palm.y - ey;
          const d2 = dx * dx + dy * dy;
          if (d2 < r * r && (!best || d2 < best.d2)) best = { d2, key, t, d };
        }
      }
      if (!best) break;
      best.d._taken = true; free.delete(best.key);
      assign.push([best.t, best.d]);
    }
    for (const d of detected) {           // 못 붙은 검출 → 새 트랙
      if (d._taken) continue;
      // ★ 유령 청소: 새 손이 생기는데 아직 안 붙은 옛 트랙이 남아 있다면, 그건 십중팔구
      //   방금 갈라져 나온 같은 손이다(진짜 두 손이면 옛 트랙도 이번에 붙었을 것이다).
      //   그대로 두면 옛 자리에 얼어붙은 주먹이 최대 650ms 남는다 → 즉시 은퇴시킨다.
      //   예측 매칭이 대부분 막아주지만, 손을 아예 놓쳤다 멀리서 다시 찾은 경우엔 이 그물이 받는다.
      if (free.size) {
        let stale = null;
        for (const [key, t] of free) if (!stale || t.tPerf < stale.t.tPerf) stale = { key, t };
        this.tracks.delete(stale.key); free.delete(stale.key);
      }
      const t = new Track();
      this.tracks.set('h' + (this._nextId = (this._nextId || 0) + 1), t);
      assign.push([t, d]);
    }

    for (const [t, det] of assign) {
      const lm = det.lm;
      const palm = det.palm;
      const nx = t.px.filter(palm.x, tMedia);
      const ny = t.py.filter(palm.y, tMedia);

      // 속도: ★ 반드시 실제 dt로 미분한다. 검출 간격은 16~33ms로 흔들리는데
      //      등간격이라 가정하면 그 흔들림이 곧바로 속도 노이즈가 되고,
      //      속도는 미분값이라 노이즈를 증폭한다 = 실이 부들부들 떤다.
      if (t.tMedia !== null) {
        const dt = (tMedia - t.tMedia) / 1000;
        if (dt > 0) {
          const rvx = (nx - t.x) / dt, rvy = (ny - t.y) / dt;
          const a = TUNE.velEma;
          t.vx = t.vx * (1 - a) + rvx * a;
          t.vy = t.vy * (1 - a) + rvy * a;
        }
      }
      t.x = nx; t.y = ny;

      for (let k = 0; k < TIPS.length; k++) {
        const p = map(lm[TIPS[k]]);
        t.tips[k].x = t.tx[k].filter(p.x, tMedia);
        t.tips[k].y = t.ty[k].filter(p.y, tMedia);
      }

      // ── 움켜쥐기 ──
      // 슈미트 트리거(임계 두 개). 하나였다면 경계에서 프레임마다 켜졌다 꺼졌다 하고,
      // 그건 입자가 점멸한다는 뜻이다. 켜는 조건과 끄는 조건을 떨어뜨려서 붙잡는다.
      if (det.open !== null) {
        const a = TUNE.grabEma;
        t.openness = t.openness * (1 - a) + det.open * a;
        if (!t.grab && t.openness < TUNE.grabOn)       t.grab = true;
        else if (t.grab && t.openness > TUNE.grabOff)  t.grab = false;
      }

      // ── 거리 → 배율 ──
      // 선형이어야 한다. "같은 것을 멀리서 본다"의 물리가 곧 "보이는 크기에 비례"이므로,
      // 지수/커브를 끼우면 멀어지는 느낌이 아니라 그냥 커졌다 작아지는 것이 된다.
      if (det.size !== null) {
        const a = TUNE.sizeEma;
        t.size = (t.size === null) ? det.size : t.size * (1 - a) + det.size * a;
        const raw = t.size / TUNE.sizeRef;
        t.scale = raw < TUNE.sizeMin ? TUNE.sizeMin : raw > TUNE.sizeMax ? TUNE.sizeMax : raw;
      }

      t.tMedia = tMedia;
      t.tPerf = tPerf;
      if (t.seen < 100) t.seen++;
    }

    // 이번 프레임에 안 붙은 트랙: seen만 끊어 재진입 시 enterFrames를 다시 요구한다.
    // 영향력을 여기서 끊지는 않는다 — 그건 sample()의 히스테리시스 몫.
    const assigned = new Set(assign.map(a => a[0]));
    for (const [, t] of this.tracks) {
      if (!assigned.has(t) && performance.now() - t.tPerf > TUNE.holdMs) t.seen = 0;
    }
  }

  /**
   * 손 단위 상태. void 처럼 "손 위치 + 움켜쥠"만 필요한 작품용.
   * (thread field 처럼 어트랙터가 필요하면 sample() 을 쓴다 — 둘 다 같은 내부 상태를 읽는다.)
   * @returns {Array<{nx, ny, nvx, nvy, grab:boolean, openness:number, scale:number, influence:number}>}
   *          scale: 카메라와의 거리에서 나온 배율. 1 = 기준 거리, <1 = 멀다, >1 = 가깝다.
   */
  sampleHands(now) {
    return palmsOf(this.sample(now));
  }

  /**
   * 렌더 루프가 매 프레임 부른다.
   * @returns {Array<{nx:number, ny:number, nvx:number, nvy:number, kind:'palm'|'tip', w:number}>}
   *          정규화 화면좌표 / 정규화 화면단위 per 초
   */
  sample(now) {
    const dt = Math.min(now - (this._lastSample || now), 100);
    this._lastSample = now;

    const out = [];
    for (const [key, t] of this.tracks) {
      const age = now - t.tPerf;

      // ── 히스테리시스 ──
      const want = (age < TUNE.holdMs && t.seen >= TUNE.enterFrames) ? 1 : 0;
      const rate = dt / (want > t.influence ? TUNE.enterMs : TUNE.releaseMs);
      if (want > t.influence)      t.influence = Math.min(1, t.influence + rate);
      else if (want < t.influence) t.influence = Math.max(0, t.influence - rate);

      if (t.influence <= 0 && age > TUNE.holdMs + TUNE.releaseMs + 500) {
        this.tracks.delete(key);     // 완전히 사라진 손은 필터 상태까지 버린다
        continue;
      }
      if (t.influence <= 0) continue;

      // ── 외삽 ── 30fps 입력을 60fps 렌더에 잇는다.
      const ex = Math.min(Math.max(age, 0), TUNE.maxExtrapMs) / 1000;
      const decay = Math.exp(-Math.max(0, age) / TUNE.velDecayTau);
      const vx = t.vx * decay, vy = t.vy * decay;

      // 검출 기반 목표. 이 신호 자체엔 톱니가 있다 — 검출이 올 때마다 t.x 가 필터값으로 튀므로.
      const tx = t.x + t.vx * ex, ty = t.y + t.vy * ex;

      // ── 톱니 제거 ──
      // 렌더용 위치를 속도로 굴리고, 목표와의 오차만 시상수로 흡수한다.
      // 목표도 같은 속도로 나아가므로 오차는 그대로 유지되다가 지수적으로 사라진다 =
      // 움직임은 속도가 만들고(매끈함), 검출은 보정만 한다(안 튐).
      // ※ sample()이 한 프레임에 여러 번 불려도 안전하다 — 실제 dt로 적분하므로 총량이 보존된다.
      if (t.rx === null) { t.rx = tx; t.ry = ty; t.rt = now; }
      const rdt = Math.min(Math.max(now - t.rt, 0), 100) / 1000;
      t.rt = now;
      t.rx += t.vx * rdt; t.ry += t.vy * rdt;                  // 속도로 전진
      const a = 1 - Math.exp(-rdt * 1000 / TUNE.trackTau);     // 프레임률 무관한 흡수율
      t.rx += (tx - t.rx) * a; t.ry += (ty - t.ry) * a;        // 오차를 서서히 흡수

      out.push({
        nx: clamp01(t.rx), ny: clamp01(t.ry),
        nvx: vx, nvy: vy, kind: 'palm', w: TUNE.palmW * t.influence,
        _grab: t.grab, _openness: t.openness, _influence: t.influence,   // sampleHands() 용
        _scale: t.scale, _size: t.size, _id: key,   // 프레임 간 같은 손을 알아보게 (경로 분사용)
      });

      // 손끝에도 손바닥이 받은 것과 **같은 보정**을 물려준다.
      // 따로 계산하면 손바닥만 매끄럽고 손끝은 톱니를 타서 손 모양이 프레임마다 일그러진다.
      const cx = t.rx - tx, cy = t.ry - ty;
      for (let k = 0; k < TIPS.length; k++) {
        const tip = t.tips[k];
        out.push({
          nx: clamp01(tip.x + t.vx * ex + cx), ny: clamp01(tip.y + t.vy * ex + cy),
          // ★ 손끝 속도를 독립적으로 미분하지 않는다 — 가진 신호 중 가장 노이즈가 심하다.
          //   손바닥 속도를 물려받고 위치만 다르게 한다: 휘두름은 하나로 뭉치고,
          //   갈라짐은 손가락별로 생긴다.
          nvx: vx, nvy: vy, kind: 'tip', w: TUNE.tipW * t.influence,
        });
      }
    }
    return out;
  }

  /** HUD용 요약 */
  info() {
    let inf = 0;
    for (const [, t] of this.tracks) inf = Math.max(inf, t.influence);
    return { state: this.state, error: this.error, hands: this.tracks.size,
             influence: inf, detectMs: this.detectMs,
             captureFps: this.captureFps,     // 카메라가 실제로 주는 초당 장수
             detectFps: this.detectFps,       // 그중 실제 검출한 횟수
             droppedPct: this.droppedPct,     // 워커가 바빠서 버린 비율
             camera: this.camera || null };
  }
}
