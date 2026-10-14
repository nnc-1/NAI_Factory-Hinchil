'use strict';
// Made by 크랙 크리에이터 넉넉한 취향 (https://share.crack.wrtn.ai/4dihl6) 의 클로드 어시스턴트 서한결 제작
// 흰칠: 폴더 안 그림에서 노출 부위를 찾아 흰색(또는 모자이크)으로 덮어 별도 폴더에 저장.
// 원본은 건드리지 않음. 감지는 onnx 모델을 내 PC에서 돌림 (API 요금 없음).
// 명령줄로도, GUI(gui-server.js)에서도 이 파일의 함수를 같이 씀.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const { LABELS, selectParts, shapeOf } = core;

// 감지기(모델) 목록
const DETECTORS = {
  anime: {
    name: '애니 전용 (유두·성기)',
    file: 'models/censor_detect_v1.0_s.onnx',
    url: 'https://huggingface.co/deepghs/anime_censor_detection/resolve/main/censor_detect_v1.0_s/model.onnx',
    page: 'https://huggingface.co/deepghs/anime_censor_detection/tree/main/censor_detect_v1.0_s',
    labels: core.ANIME_LABELS, // 모델 파일 안에서 읽어 오고, 못 읽을 때만 이 순서를 씀
    size: 640,
    mode: 'stretch', // 비율 유지 없이 정사각형으로 늘려 넣음
    readMeta: true,
  },
};

const DEFAULT_CONFIG = {
  inputDir: '',                   // 검열할 그림 폴더 (처음엔 비어 있음. GUI에서 고르거나 절대경로를 적어요)
  outputDir: '',                  // 결과 저장 폴더 (처음엔 비어 있음). 원본은 그대로 둠
  recursive: true,                // 하위 폴더까지 처리 (폴더 구조 그대로 복사)
  mode: 'white',                  // 'white' = 흰칠, 'mosaic' = 모자이크
  shape: 'ellipse',               // 'ellipse' = 원형(타원, 가장자리 부드럽게), 'rect' = 사각형
  fillColor: '#ffffff',           // 흰칠 색 (검정으로 바꾸려면 #000000)
  mosaicSize: 20,                 // 모자이크 칸 크기(px). 클수록 뭉개짐
  padding: 0,                     // 가림 크기 조절 (0 = 박스를 감싸는 크기, 음수는 더 작게, 양수는 더 크게)
  outInside: false,               // true면 결과 폴더를 '그림 폴더/output'으로 자동 지정 (GUI에서 쓰는 설정)
  skipReviewed: true,             // true면 GUI에서 '검수 완료'로 체크한 그림은 폴더 전체 실행에서 건너뜀
  keepMetadata: false,            // true면 원본 PNG의 프롬프트 등 텍스트 메타데이터를 결과에 그대로 옮김 (PNG만)
  feather: 0.3,                   // 가장자리 번짐 정도 (0=칼같이, 1=아주 넓게 흐림). 원형일 때만 적용
  threshold: 0.25,                // 감지 임계값. 낮을수록 더 많이 잡음 (놓침 줄고 오탐 늘어남)
  nmsIou: 0.45,                   // 겹치는 박스 정리 기준
  detectors: ['anime'],           // 쓸 감지기
  parts: ['nipple_f', 'pussy', 'penis'], // 가릴 부위
  skipExisting: true,             // 결과 폴더에 이미 있는 파일은 건너뜀
  jpegQuality: 95,
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// ---------- 설정 ----------

function readUserConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  const cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(cfgPath)) {
    const user = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const [k, v] of Object.entries(user)) {
      if (k.startsWith('_')) continue; // 설명용 키 무시
      cfg[k] = v;
    }
  }
  return cfg;
}

function validateConfig(cfg) {
  if (!['white', 'mosaic'].includes(cfg.mode)) throw new Error(`mode는 white 또는 mosaic: ${cfg.mode}`);
  if (!['ellipse', 'rect'].includes(cfg.shape)) throw new Error(`shape는 ellipse 또는 rect: ${cfg.shape}`);
  if (!(cfg.threshold > 0 && cfg.threshold < 1)) throw new Error(`threshold는 0~1 사이: ${cfg.threshold}`);
  if (typeof cfg.outInside !== 'boolean') throw new Error('outInside는 true 또는 false');
  if (typeof cfg.skipReviewed !== 'boolean') throw new Error('skipReviewed는 true 또는 false');
  if (typeof cfg.keepMetadata !== 'boolean') throw new Error('keepMetadata는 true 또는 false');
  if (!(cfg.feather >= 0 && cfg.feather <= 2)) throw new Error(`feather는 0~2 사이: ${cfg.feather}`);
  if (!(cfg.padding >= -0.5 && cfg.padding <= 3)) throw new Error(`padding은 -0.5~3 사이: ${cfg.padding}`);
  if (!(cfg.mosaicSize >= 2 && cfg.mosaicSize <= 500)) throw new Error(`mosaicSize는 2~500: ${cfg.mosaicSize}`);
  if (!HEX_COLOR.test(cfg.fillColor)) throw new Error(`fillColor는 #rrggbb 형식: ${cfg.fillColor}`);
  if (!Array.isArray(cfg.parts)) throw new Error('parts는 목록이어야 해요');
  // 예전 설정에 남아 있는 NudeNet 항목(항문 등)은 조용히 버림
  cfg.parts = cfg.parts.filter((p) => !core.NUDENET_LABELS.includes(p));
  if (Array.isArray(cfg.detectors)) { const had = cfg.detectors.length; cfg.detectors = cfg.detectors.filter((d) => d !== 'nudenet'); if (had && !cfg.detectors.length) cfg.detectors = ['anime']; }
  const bad = cfg.parts.filter((p) => !LABELS.includes(p));
  if (bad.length) throw new Error(`알 수 없는 부위: ${bad.join(', ')}`);
  if (!Array.isArray(cfg.detectors) || !cfg.detectors.length) throw new Error('감지기를 하나 이상 골라 주세요');
  const badDet = cfg.detectors.filter((d) => !DETECTORS[d]);
  if (badDet.length) throw new Error(`알 수 없는 감지기: ${badDet.join(', ')}`);
  return cfg;
}

function loadConfig(argv) {
  const cfg = readUserConfig();
  const flags = { debug: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--debug') flags.debug = true;
    else if (a === '--overwrite') cfg.skipExisting = false;
    else if (a === '--keep-metadata') cfg.keepMetadata = true;
    else if (a === '--mode') cfg.mode = argv[++i];
    else if (a === '--shape') cfg.shape = argv[++i];
    else if (a === '--threshold') cfg.threshold = Number(argv[++i]);
    else if (a === '--padding') cfg.padding = Number(argv[++i]);
    else if (a === '--feather') cfg.feather = Number(argv[++i]);
    else if (a === '--detectors') cfg.detectors = String(argv[++i]).split(',');
    else if (a === '--out') cfg.outputDir = argv[++i];
    else if (a.startsWith('--')) throw new Error(`알 수 없는 옵션: ${a}`);
    else rest.push(a);
  }
  if (rest[0]) cfg.inputDir = rest[0];
  validateConfig(cfg);
  return { cfg, flags };
}

// ---------- 모델 ----------

async function downloadModel(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1e6) throw new Error('받은 파일이 너무 작음');
  if (buf[0] === 0x3c) throw new Error('모델 파일이 아니라 웹페이지를 받았음');
  return buf;
}

async function ensureModel(key) {
  const spec = DETECTORS[key];
  const p = path.resolve(__dirname, spec.file);
  if (fs.existsSync(p) && fs.statSync(p).size > 1e6) return p;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  console.log(`[${spec.name}] 모델 파일이 없어서 내려받는 중... (처음 한 번만)`);
  let buf;
  const errs = [];
  try {
    buf = await downloadModel(spec.url);
  } catch (e) {
    errs.push(`${spec.url} → ${e.message}`);
  }
  if (!buf) {
    throw new Error(
      `[${spec.name}] 모델 다운로드 실패 (${errs.join(' / ')}).\n` +
        `브라우저로 아래 주소를 열어서 파일을 받은 뒤, 이름을 ${path.basename(spec.file)} 로 바꿔서\n` +
        `${path.dirname(p)} 폴더에 넣어 주세요.\n` +
        `다운로드 주소: ${spec.url}\n` +
        `(파일 목록 페이지: ${spec.page})`
    );
  }
  const tmp = p + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
  console.log(`모델 저장 완료: ${p} (${(buf.length / 1e6).toFixed(1)}MB)`);
  return p;
}

// onnx 파일 안에 적힌 라벨 순서(names)와 입력 크기(imgsz)를 읽음. 못 읽으면 빈 객체
function readOnnxMeta(file) {
  const text = fs.readFileSync(file).toString('latin1');
  const out = {};
  let i = text.lastIndexOf('names');
  while (i >= 0 && !out.labels) {
    const m = /\{\s*0\s*:\s*['"][^}]*\}/.exec(text.slice(i, i + 4000));
    if (m) {
      const arr = [];
      for (const [, k, v] of m[0].matchAll(/(\d+)\s*:\s*['"]([^'"]*)['"]/g)) arr[Number(k)] = v;
      if (arr.length && arr.every((x) => typeof x === 'string')) out.labels = arr;
    }
    i = i > 0 ? text.lastIndexOf('names', i - 1) : -1;
  }
  const j = text.lastIndexOf('imgsz');
  if (j >= 0) {
    const m = /\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(text.slice(j, j + 60));
    if (m) out.size = [Number(m[1]), Number(m[2])];
  }
  return out;
}

const _sessions = new Map();
// 같은 모델을 동시에 두 번 내려받거나 만들지 않도록 진행 중인 작업을 공유
function getSession(key) {
  if (_sessions.has(key)) return _sessions.get(key);
  const spec = DETECTORS[key];
  if (!spec) return Promise.reject(new Error(`알 수 없는 감지기: ${key}`));
  const p = (async () => {
    const file = await ensureModel(key);
    const ort = require('onnxruntime-node');
    // 컴퓨터가 버벅이지 않게 CPU 코어의 절반 정도만 씀
    const threads = Math.max(1, Math.floor(require('os').cpus().length / 2));
    const session = await ort.InferenceSession.create(file, { intraOpNumThreads: threads });
    let labels = spec.labels;
    let sizeW = spec.size;
    let sizeH = spec.size;
    let warn = null;
    if (spec.readMeta) {
      const meta = readOnnxMeta(file);
      if (meta.labels) labels = meta.labels;
      else warn = '모델 파일에서 라벨 순서를 못 읽어서 기본 순서(nipple_f, penis, pussy)를 썼어요. 박스 이름이 이상하면 알려 주세요.';
      if (meta.size) {
        sizeW = meta.size[0];
        sizeH = meta.size[1];
      }
    }
    return { session, ort, labels, sizeW, sizeH, spec, warn, file };
  })();
  _sessions.set(key, p);
  p.catch(() => _sessions.delete(key));
  return p;
}

// 감지는 한 번에 하나씩만 (GUI에서 미리보기와 일괄 실행이 겹쳐도 안전하게)
let _lock = Promise.resolve();
function withLock(fn) {
  const run = _lock.then(fn, fn);
  _lock = run.catch(() => {});
  return run;
}

// ---------- 이미지 읽기 / 감지 ----------

async function loadRaw(file) {
  const sharp = require('sharp');
  const { data, info } = await sharp(file)
    .rotate()
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels, src: file };
}

// ----- PNG 메타데이터(프롬프트 등 텍스트 칸) 옮기기 -----
// NovelAI는 프롬프트/시드 등을 PNG의 tEXt 칸에 넣어 둠. 그림을 다시 저장하면 사라지므로 원본에서 읽어 결과 PNG에 끼워 넣음.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);
function pngChunks(buf) {
  const out = [];
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const end = p + 12 + len;
    if (end > buf.length) break;
    out.push({ type, start: p, end });
    p = end;
    if (type === 'IEND') break;
  }
  return out;
}
function readPngTextChunks(file) {
  try {
    const buf = fs.readFileSync(file);
    const ch = pngChunks(buf);
    if (!ch) return [];
    return ch.filter((c) => TEXT_CHUNKS.has(c.type)).map((c) => buf.subarray(c.start, c.end));
  } catch (e) {
    return [];
  }
}
function injectPngChunks(png, chunks) {
  if (!chunks.length) return png;
  const ch = pngChunks(png);
  const idat = ch && ch.find((c) => c.type === 'IDAT');
  if (!idat) return png;
  return Buffer.concat([png.subarray(0, idat.start), ...chunks, png.subarray(idat.start)]);
}

async function detectWith(key, s, raw, threshold) {
  const sharp = require('sharp');
  const { session, ort, labels, sizeW, sizeH, spec } = s;
  const rawOpt = { raw: { width: raw.width, height: raw.height, channels: raw.channels } };
  let small;
  let sx;
  let sy;
  if (spec.mode === 'letterbox') {
    const S = Math.max(raw.width, raw.height);
    small = await sharp(raw.data, rawOpt)
      .extend({ right: S - raw.width, bottom: S - raw.height, background: { r: 0, g: 0, b: 0 } })
      .resize(sizeW, sizeH, { fit: 'fill', kernel: 'linear' })
      .raw()
      .toBuffer();
    sx = S / sizeW;
    sy = S / sizeH;
  } else {
    small = await sharp(raw.data, rawOpt).resize(sizeW, sizeH, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
    sx = raw.width / sizeW;
    sy = raw.height / sizeH;
  }
  const plane = sizeW * sizeH;
  const f = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    f[i] = small[i * 3] / 255;
    f[plane + i] = small[i * 3 + 1] / 255;
    f[2 * plane + i] = small[i * 3 + 2] / 255;
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, sizeH, sizeW]) });
  const o = out[session.outputNames[0]];
  if (o.dims.length !== 3 || o.dims[1] !== 4 + labels.length) {
    throw new Error(`[${spec.name}] 예상과 다른 모델 출력 모양: [${o.dims.join(', ')}] (라벨 ${labels.length}개 기준으로 ${4 + labels.length}칸이어야 해요)`);
  }
  return core.decode(o.data, o.dims, sx, sy, raw.width, raw.height, threshold, labels).map((d) => ({ ...d, det: key }));
}

// 고른 감지기들을 모두 돌려서 한 목록으로 합침 (id는 목록 안에서 순서대로)
async function detectAll(raw, detectors, threshold) {
  const all = [];
  for (const key of detectors) {
    const s = await getSession(key);
    const dets = await withLock(() => detectWith(key, s, raw, threshold));
    all.push(...dets);
  }
  return all.map((d, i) => ({ id: i, ...d }));
}

// ---------- 검열 ----------

function encode(pipeline, outPath, cfg) {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return pipeline.jpeg({ quality: cfg.jpegQuality });
  if (ext === '.webp') return pipeline.webp({ quality: cfg.jpegQuality });
  return pipeline.png();
}

const r2 = (v) => Math.round(v * 100) / 100;

async function censor(raw, boxes, cfg, outPath) {
  const sharp = require('sharp');
  const rawOpt = { raw: { width: raw.width, height: raw.height, channels: raw.channels } };
  const shapes = boxes.map((b) => shapeOf(b, cfg, raw.width, raw.height));
  const overlays = [];
  // 타원 하나를 SVG 조각으로. 번짐이 있으면 가장자리가 투명해지는 방사형 그라데이션으로 채움
  // ox, oy: SVG 좌표 원점 이동량 (모자이크 마스크는 잘라낸 조각 기준 좌표를 씀)
  const ellipseSvg = (s, color, id, ox, oy) => {
    const cx = r2(s.cx - ox), cy = r2(s.cy - oy);
    if (!(s.feather > 0)) return `<ellipse cx="${cx}" cy="${cy}" rx="${r2(s.rx)}" ry="${r2(s.ry)}" fill="${color}"/>`;
    const stops = core
      .fadeStops(s.feather)
      .map(([o, a]) => `<stop offset="${o.toFixed(4)}" stop-color="${color}" stop-opacity="${a.toFixed(4)}"/>`)
      .join('');
    return `<defs><radialGradient id="g${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient></defs><ellipse cx="${cx}" cy="${cy}" rx="${r2(s.rx)}" ry="${r2(s.ry)}" fill="url(#g${id})"/>`;
  };
  if (cfg.mode === 'white') {
    // SVG로 그리면 가장자리가 부드럽게(안티앨리어싱) 칠해짐
    const els = shapes
      .map((s, i) =>
        s.type === 'ellipse'
          ? ellipseSvg(s, cfg.fillColor, i, 0, 0)
          : `<rect x="${s.left}" y="${s.top}" width="${s.width}" height="${s.height}" fill="${cfg.fillColor}"/>`
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${raw.width}" height="${raw.height}">${els}</svg>`;
    overlays.push({ input: Buffer.from(svg), left: 0, top: 0 });
  } else {
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      const r = { left: s.left, top: s.top, width: s.width, height: s.height };
      const tw = Math.max(1, Math.round(r.width / cfg.mosaicSize));
      const th = Math.max(1, Math.round(r.height / cfg.mosaicSize));
      const tile = await sharp(raw.data, rawOpt)
        .extract(r)
        .resize(tw, th, { kernel: 'linear' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      let big = await sharp(tile.data, { raw: { width: tile.info.width, height: tile.info.height, channels: tile.info.channels } })
        .resize(r.width, r.height, { kernel: 'nearest' })
        .png()
        .toBuffer();
      if (s.type === 'ellipse') {
        // 타원 마스크로 잘라내기 (가장자리 안티앨리어싱 + 번짐)
        const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}">${ellipseSvg(s, '#ffffff', i, r.left, r.top)}</svg>`;
        big = await sharp(big).ensureAlpha().composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
      }
      overlays.push({ input: big, left: r.left, top: r.top });
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let p = sharp(raw.data, rawOpt);
  if (overlays.length) p = p.composite(overlays).removeAlpha();
  const isPng = path.extname(outPath).toLowerCase() === '.png';
  if (cfg.keepMetadata && isPng && raw.src && path.extname(raw.src).toLowerCase() === '.png') {
    const buf = await encode(p, outPath, cfg).toBuffer();
    fs.writeFileSync(outPath, injectPngChunks(buf, readPngTextChunks(raw.src)));
  } else {
    await encode(p, outPath, cfg).toFile(outPath);
  }
}

// 확인용: 감지된 박스를 선으로 그린 그림 (빨강=가림 대상, 회색=그 외 감지)
async function writeDebug(raw, all, picked, outPath) {
  const sharp = require('sharp');
  const pickedSet = new Set(picked);
  const shapes = all
    .map((d) => {
      const c = pickedSet.has(d) ? '#ff2020' : '#888888';
      return `<rect x="${d.x1.toFixed(0)}" y="${d.y1.toFixed(0)}" width="${(d.x2 - d.x1).toFixed(0)}" height="${(d.y2 - d.y1).toFixed(0)}" fill="none" stroke="${c}" stroke-width="3"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${raw.width}" height="${raw.height}">${shapes}</svg>`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .removeAlpha()
    .png()
    .toFile(outPath);
}

// ---------- 파일 순회 ----------

function listImages(dir, recursive, skipDir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!recursive) continue;
        if (skipDir && path.resolve(full) === path.resolve(skipDir)) continue;
        walk(full);
      } else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

// ---------- 폴더 전체 처리 (명령줄과 GUI 공용) ----------

async function runBatch(cfg, opts = {}) {
  const { debug = false, onLog = () => {}, onProgress = () => {}, shouldCancel = () => false, skipRel = null } = opts;
  validateConfig(cfg);
  if (!cfg.inputDir) throw new Error('그림 폴더를 먼저 골라 주세요.');
  if (!cfg.outputDir) throw new Error('결과 폴더를 먼저 골라 주세요.');
  const inputDir = path.resolve(__dirname, cfg.inputDir);
  const outputDir = path.resolve(__dirname, cfg.outputDir);
  if (!fs.existsSync(inputDir)) throw new Error(`그림 폴더가 없어요: ${inputDir}`);
  if (inputDir === outputDir) throw new Error('입력 폴더와 결과 폴더가 같아요. 원본을 지키려면 다른 폴더를 골라 주세요.');

  for (const key of cfg.detectors) {
    const s = await getSession(key); // 모델 준비 (없으면 여기서 오류)
    if (s.warn) onLog(`주의: ${s.warn}`);
  }
  const files = listImages(inputDir, cfg.recursive, outputDir);
  onLog(`그림 ${files.length}장 / 방식: ${cfg.mode === 'white' ? '흰칠' : '모자이크'}(${cfg.shape === 'ellipse' ? '원형' : '사각형'}) / 임계값 ${cfg.threshold} / 감지기: ${cfg.detectors.join(', ')}`);
  onLog(`입력: ${inputDir}`);
  onLog(`출력: ${outputDir}`);

  const hit = [];
  const none = [];
  const failed = [];
  let skipped = 0;
  let reviewedSkipped = 0;
  let cancelled = false;
  const progress = (i, current) =>
    onProgress({ done: i, total: files.length, hit: hit.length, none: none.length, failed: failed.length, skipped, current });

  for (let i = 0; i < files.length; i++) {
    if (shouldCancel()) {
      cancelled = true;
      break;
    }
    const file = files[i];
    const rel = path.relative(inputDir, file);
    const outPath = path.join(outputDir, rel);
    const tag = `[${i + 1}/${files.length}] ${rel}`;
    progress(i, rel);
    if (skipRel && skipRel(rel)) {
      skipped++;
      reviewedSkipped++;
      continue;
    }
    if (cfg.skipExisting && fs.existsSync(outPath)) {
      skipped++;
      continue;
    }
    try {
      const raw = await loadRaw(file);
      const all = await detectAll(raw, cfg.detectors, cfg.threshold);
      const picked = selectParts(all, cfg);
      await censor(raw, picked, cfg, outPath);
      if (debug) {
        const dbg = path.join(outputDir, '_debug', rel.replace(/\.[^.]+$/, '') + '.png');
        await writeDebug(raw, all.filter((d) => d.score >= cfg.threshold), picked, dbg);
      }
      if (picked.length) {
        hit.push(rel);
        onLog(`${tag}  -> ${picked.length}곳 가림 (${picked.map((d) => `${d.label} ${d.score.toFixed(2)}`).join(', ')})`);
      } else {
        none.push(rel);
        onLog(`${tag}  -> 감지 없음 (그대로 저장)`);
      }
    } catch (e) {
      failed.push(`${rel}: ${e.message}`);
      onLog(`${tag}  -> 실패: ${e.message}`);
    }
  }
  progress(cancelled ? hit.length + none.length + failed.length + skipped : files.length, '');

  const processed = hit.length + none.length;
  const lines = [
    `${cancelled ? '(중간에 취소됨) ' : ''}처리 ${processed}장 / 건너뜀 ${skipped}장${reviewedSkipped ? ` (그중 검수 완료 ${reviewedSkipped}장)` : ''} / 실패 ${failed.length}장`,
    `가린 그림 ${hit.length}장, 감지 없음 ${none.length}장`,
    '',
    '[감지 없음 - 공개 전에 눈으로 꼭 확인]',
    ...none,
    '',
    '[실패]',
    ...failed,
  ];
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, '결과보고.txt'), lines.join('\n'), 'utf8');
  return { total: files.length, processed, skipped, hit: hit.length, none: none.length, failed: failed.length, cancelled, outputDir };
}

async function main() {
  const { cfg, flags } = loadConfig(process.argv.slice(2));
  const r = await runBatch(cfg, { debug: flags.debug, onLog: (s) => console.log(s) });
  console.log(`\n처리 ${r.processed}장 / 건너뜀 ${r.skipped}장 / 실패 ${r.failed}장 (가림 ${r.hit}, 감지 없음 ${r.none})`);
  console.log('결과보고.txt에 "감지 없음" 목록을 적어뒀어요. 자동 감지는 100%가 아니니 공개 전에 훑어보세요.');
}

module.exports = {
  LABELS, DETECTORS, DEFAULT_CONFIG, IMAGE_EXT,
  readUserConfig, validateConfig, loadConfig,
  ensureModel, readOnnxMeta, getSession, withLock,
  loadRaw, readPngTextChunks, injectPngChunks, detectWith, detectAll, censor, writeDebug, listImages, runBatch,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('\n오류: ' + e.message);
    process.exitCode = 1;
  });
}
