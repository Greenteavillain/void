// ─────────────────────────────────────────────────────────────────────────────
// 손 검출 워커
//
// ★ 이 파일이 워커인 것은 최적화가 아니라 필수다.
//   HandLandmarker.detectForVideo() 는 Promise가 아니라 HandLandmarkerResult 를
//   그대로 반환한다 = 완전 동기 = 호출한 스레드를 그대로 잡아먹는다.
//   (vendor/tasks-vision/vision.d.ts:987 에서 직접 확인)
//   측정된 소요: 640x480/한손 ~12ms, 두손 ~15ms. 60fps 예산이 16.67ms이므로
//   메인스레드에서 부르면 렌더 예산이 통째로 사라지고 작품이 조용히 30fps로 반토막난다.
//   그래서 검출은 여기서, 그림은 저기서.
// ─────────────────────────────────────────────────────────────────────────────

import { FilesetResolver, HandLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';

let landmarker = null;
let lastTs = -1;
let busy = false;

async function init(opt = {}) {
  try {
    // wasm/모델 모두 로컬 vendor/ 에서 로드한다. CDN(@latest)을 쓰면 전시 중에
    // 인터넷이 끊기거나 구글이 버전을 올리면 작품이 죽는다. 버전은 0.10.35로 고정.
    //
    // ★ 두 번째 인자 true = "모듈 빌드 글루를 써라". 이거 빼면 "ModuleFactory not set."로 죽는다.
    //   이유: 기본(false)은 vision_wasm_internal.js(classic script)를 로드하는데,
    //   MediaPipe 로더는 워커에서 importScripts()로 그걸 넣으려 한다. 그런데 모듈 워커에선
    //   importScripts가 TypeError를 던지고 → 로더가 import()로 폴백 → classic script가
    //   모듈 스코프에서 실행되면서 `var ModuleFactory`가 전역에 안 잡힌다 → 위 에러.
    //   true면 vision_wasm_module_internal.js를 쓰는데, 그건 끝에서 명시적으로
    //   `globalThis.ModuleFactory = ModuleFactory`를 세팅하므로 모듈 워커에서 정상 동작한다.
    const fileset = await FilesetResolver.forVisionTasks(
      new URL('../vendor/tasks-vision/wasm', import.meta.url).href,
      true
    );

    landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: new URL('../vendor/hand_landmarker.task', import.meta.url).href,
        delegate: 'GPU',            // CPU 델리게이트는 대안이 아니다 (p95 ~170ms)
      },
      runningMode: 'VIDEO',         // ★ 대문자. 공식 문서 샘플의 'video'는 타입 정의와 다르다.
      numHands: 2,
      // 신뢰도 임계값 — 빠르게 휘두를 때 손을 놓치는 것에 가장 크게 작용하는 값.
      // 낮추면 흐릿한(모션 블러 먹은) 손도 받아들인다. 기본 0.5는 정지 사진 기준이라 보수적.
      minHandDetectionConfidence: opt.detConf ?? 0.5,
      minHandPresenceConfidence:  opt.presConf ?? 0.5,
      minTrackingConfidence:      opt.trackConf ?? 0.5,
    });

    postMessage({ type: 'ready' });
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.message || e) });
  }
}

onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'init') { await init(msg.opt); return; }

  if (msg.type === 'frame') {
    // 아직 준비 안 됐거나 이전 프레임 처리 중이면 그냥 버린다.
    // 큐를 쌓으면 지연이 누적돼서 손이 실보다 점점 뒤처진다 — 최신 프레임이 항상 옳다.
    if (!landmarker || busy) { msg.bitmap.close(); return; }
    busy = true;
    try {
      // detectForVideo 는 타임스탬프가 단조 증가하지 않으면 던진다.
      let ts = msg.t;
      if (!(ts > lastTs)) ts = lastTs + 1;
      lastTs = ts;

      const res = landmarker.detectForVideo(msg.bitmap, ts);

      // 화면 위치는 정규화 랜드마크(2D)로. z는 손목 상대값이라 신뢰도가 낮아 버린다.
      const hands = (res.landmarks || []).map(lm => lm.map(p => ({ x: p.x, y: p.y })));
      const handedness = (res.handedness || []).map(h => (h[0] && h[0].categoryName) || '?');

      // worldLandmarks(미터, 손목 원점)는 위치용으론 쓸모없지만 **주먹 판정엔 이게 정답**이다.
      // 2D로 손가락이 접혔는지 재면 손을 카메라 쪽으로 향했을 때 편 손도 주먹처럼 보인다(원근 단축).
      // 3D면 그 착시가 없다. 주먹 판정에 필요한 6점만 보낸다(손목·중지MCP·손끝4개) — 21점 다 보내면
      // 프레임마다 쓸데없이 큰 메시지가 오간다.
      const world = (res.worldLandmarks || []).map(lm =>
        [0, 9, 8, 12, 16, 20].map(i => ({ x: lm[i].x, y: lm[i].y, z: lm[i].z })));

      // ★ 두 시계를 모두 그대로 돌려보낸다 — 이름/개수를 바꾸면 조용히 죽는다:
      //   tMedia(영상 클럭)가 없으면 필터 dt가 NaN → 속도가 영원히 0 → brush(휘두름)가 사라진다.
      //   tPerf(perf 클럭)가 없으면 age가 NaN → 히스테리시스가 영원히 0 → 어트랙터가 아예 안 생긴다.
      //   둘 다 예외 없이 조용히 실패하므로 콘솔엔 아무것도 안 뜬다.
      // aspect: 화면비. 정규화 좌표는 x가 폭으로, y가 높이로 각각 나뉜 값이라
      // 640×480에서 x의 0.1(=64px)과 y의 0.1(=48px)이 다른 길이다. 손 크기(=거리)를 재려면
      // 이걸 보정해야 한다. 안 그러면 손을 기울일 때마다 크기가 요동친다.
      postMessage({ type: 'hands', hands, handedness, world,
                    aspect: msg.bitmap.width / msg.bitmap.height,
                    tMedia: msg.tMedia, tPerf: msg.tPerf });
    } catch (e) {
      postMessage({ type: 'error', message: String(e && e.message || e) });
    } finally {
      msg.bitmap.close();   // 안 닫으면 GPU 메모리가 샌다
      busy = false;
    }
  }
};
