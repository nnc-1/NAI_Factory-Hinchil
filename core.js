'use strict';
// Made by 크랙 크리에이터 넉넉한 취향 (https://share.crack.wrtn.ai/4dihl6) 의 클로드 어시스턴트 서한결 제작
// 서버(Node)와 GUI(브라우저)가 같이 쓰는 계산 코드: 감지 결과 해석, 박스 정리, 가릴 모양 계산
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HinchilCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // NudeNet v3 라벨 순서 (모델 출력 클래스 순서와 같음)
  const NUDENET_LABELS = [
    'FEMALE_GENITALIA_COVERED',
    'FACE_FEMALE',
    'BUTTOCKS_EXPOSED',
    'FEMALE_BREAST_EXPOSED',
    'FEMALE_GENITALIA_EXPOSED',
    'MALE_BREAST_EXPOSED',
    'ANUS_EXPOSED',
    'FEET_EXPOSED',
    'BELLY_COVERED',
    'FEET_COVERED',
    'ARMPITS_COVERED',
    'ARMPITS_EXPOSED',
    'FACE_MALE',
    'BELLY_EXPOSED',
    'MALE_GENITALIA_EXPOSED',
    'ANUS_COVERED',
    'FEMALE_BREAST_COVERED',
    'BUTTOCKS_COVERED',
  ];
  // 애니 전용 모델(deepghs anime_censor_detection)의 라벨. 실제 순서는 모델 파일 안에서 읽어 오고, 못 읽을 때만 이 순서를 씀
  const ANIME_LABELS = ['nipple_f', 'penis', 'pussy'];
  const LABELS = NUDENET_LABELS.concat(ANIME_LABELS);

  // YOLOv8 출력(1 x C x N, 채널 우선)을 박스 목록으로. C = 4(박스) + 클래스 수
  // sx, sy: 모델 입력 좌표 -> 원본 좌표 배율
  function decode(data, dims, sx, sy, W, H, threshold, labels) {
    const C = dims[1];
    const N = dims[2];
    const nc = C - 4;
    const res = [];
    for (let i = 0; i < N; i++) {
      let best = -1;
      let bs = 0;
      for (let c = 0; c < nc; c++) {
        const s = data[(4 + c) * N + i];
        if (s > bs) {
          bs = s;
          best = c;
        }
      }
      if (bs < threshold) continue;
      const cx = data[i];
      const cy = data[N + i];
      const w = data[2 * N + i];
      const h = data[3 * N + i];
      const x1 = Math.max(0, (cx - w / 2) * sx);
      const y1 = Math.max(0, (cy - h / 2) * sy);
      const x2 = Math.min(W, (cx + w / 2) * sx);
      const y2 = Math.min(H, (cy + h / 2) * sy);
      if (x2 - x1 < 2 || y2 - y1 < 2) continue;
      res.push({ label: (labels && labels[best]) || 'class' + best, score: bs, x1, y1, x2, y2 });
    }
    return res;
  }

  function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const inter = ix * iy;
    const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return ua > 0 ? inter / ua : 0;
  }

  function nms(dets, iouThr) {
    const sorted = dets.slice().sort((a, b) => b.score - a.score);
    const keep = [];
    for (const d of sorted) {
      if (keep.every((k) => iou(k, d) <= iouThr)) keep.push(d);
    }
    return keep;
  }

  // 임계값 이상 + 선택한 부위만 남기고 겹치는 박스 정리
  function selectParts(dets, cfg) {
    const want = new Set(cfg.parts);
    const thr = cfg.threshold || 0;
    return nms(
      dets.filter((d) => want.has(d.label) && d.score >= thr),
      cfg.nmsIou == null ? 0.45 : cfg.nmsIou
    );
  }

  // 박스를 사방으로 넓힌 정수 영역(사각형). exact:true인 박스(직접 그린 것)는 넓히지 않음
  function padBox(b, cfg, W, H) {
    const k = b.exact ? 0 : cfg.padding;
    const px = (b.x2 - b.x1) * k;
    const py = (b.y2 - b.y1) * k;
    const left = Math.max(0, Math.floor(b.x1 - px));
    const top = Math.max(0, Math.floor(b.y1 - py));
    const right = Math.min(W, Math.ceil(b.x2 + px));
    const bottom = Math.min(H, Math.ceil(b.y2 + py));
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  // 가릴 모양 계산. 타원이면 박스를 감싸는 타원(모서리까지 덮음)에 여유 비율을 더함.
  // 직접 그린(exact) 박스는 그린 사각형에 딱 맞는 타원. 반환값의 left/top/width/height는 모양이 들어가는 정수 사각형
  function shapeOf(b, cfg, W, H) {
    if (cfg.shape === 'ellipse') {
      const w = b.x2 - b.x1;
      const h = b.y2 - b.y1;
      const cx = (b.x1 + b.x2) / 2;
      const cy = (b.y1 + b.y2) / 2;
      const k = b.exact ? 1 : Math.SQRT2 * (1 + cfg.padding);
      // 번짐(feather): 꽉 찬 중심부(crx, cry)는 그대로 두고, 그 바깥으로 흐려지는 띠를 더 붙임
      const f = Math.max(0, Number(cfg.feather) || 0);
      const crx = Math.max(1, (w / 2) * k);
      const cry = Math.max(1, (h / 2) * k);
      const rx = crx * (1 + f);
      const ry = cry * (1 + f);
      const left = Math.max(0, Math.floor(cx - rx));
      const top = Math.max(0, Math.floor(cy - ry));
      const right = Math.min(W, Math.ceil(cx + rx));
      const bottom = Math.min(H, Math.ceil(cy + ry));
      return { type: 'ellipse', cx, cy, rx, ry, crx, cry, feather: f, left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    }
    const r = padBox(b, cfg, W, H);
    return { type: 'rect', left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // 번짐 구간의 투명도 곡선: [중심에서의 위치(0~1), 불투명도]. 부드러운 S자 곡선
  function fadeStops(feather) {
    const t0 = 1 / (1 + Math.max(0, feather));
    const out = [[0, 1], [t0, 1]];
    for (let i = 1; i <= 8; i++) {
      const u = i / 8;
      out.push([t0 + (1 - t0) * u, 1 - u * u * (3 - 2 * u)]);
    }
    return out;
  }

  // 브러시 획 정리: [{w: 굵기(px), p: [x1,y1,x2,y2,...]}]. 서버 저장/적용과 화면이 같은 규칙을 씀
  // 숫자가 아닌 값, 너무 긴 획은 걸러내고 좌표는 소수 첫째 자리까지만 둠
  const STROKE_MAX = 2000, STROKE_PTS_MAX = 3000; // 화면에서도 이 한도를 넘기지 않게 막아요 (넘는 획이 조용히 빠지면 안 가려진 채 저장될 수 있어서)
  function cleanStrokes(list, W, H) {
    const out = [];
    if (!Array.isArray(list)) return out;
    const r1 = (v) => Math.round(v * 10) / 10;
    for (const s of list.slice(0, STROKE_MAX)) {
      if (!s || !Array.isArray(s.p)) continue;
      const w = Number(s.w);
      if (!(w >= 1)) continue;
      const p = [];
      for (let i = 0; i + 1 < s.p.length && p.length < STROKE_PTS_MAX * 2; i += 2) {
        const x = Number(s.p[i]), y = Number(s.p[i + 1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (W && H) p.push(r1(Math.max(-w, Math.min(W + w, x))), r1(Math.max(-w, Math.min(H + w, y))));
        else p.push(r1(x), r1(y));
      }
      if (p.length >= 2) {
        const o = { w: r1(Math.min(w, W && H ? Math.max(W, H) : 100000)), p };
        if (s.e) o.e = 1; // 브러시로 칠한 것을 문질러 지우는 획 (순서대로 적용)
        out.push(o);
      }
    }
    return out;
  }
  // 획 번짐 크기(px): 그림 짧은 변의 1% x brushSoft(0~1). 화면(canvas blur)과 서버(sharp blur)가 같은 값을 씀
  function strokeBlur(soft, W, H) {
    const v = Number(soft) * Math.min(W, H) * 0.01;
    return v >= 0.3 ? v : 0;
  }

  return { NUDENET_LABELS, ANIME_LABELS, LABELS, decode, iou, nms, selectParts, padBox, shapeOf, fadeStops, cleanStrokes, strokeBlur, STROKE_MAX, STROKE_PTS_MAX };
});
