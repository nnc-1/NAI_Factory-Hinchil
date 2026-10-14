'use strict';
// NAI Factory · Hinchil 팩토리 탭: 여러 캐릭터 × 여러 동작을 한 장씩 차례대로 만들어서 폴더에 바로 저장해요.
// API 키와 입력한 내용은 이 브라우저(localStorage)에만 저장돼요.
// KDH0119님의 Novel-AI-Image-Add-Generator 에서 영감을 받아 새로 만들었어요. NOTICE-third-party.txt 참고.

const $ = (id) => document.getElementById(id);
const STORE = 'hinchil.gen.v1';
const MAX_SEED = 4294967295;
const RETRY_MS = 5000;
const MAX_FAILS = 3;
const QUALITY_TAGS = 'very aesthetic, masterpiece, no text';
const UC_TEXT = [
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy',
  '',
];
const UC_ID = ['heavy', 'light', 'human_focus', 'none'];

let uid = Date.now();
const S = {
  apiKey: '', saveDir: '생성', artist: '', negCommon: '',
  model: 'nai-diffusion-4-5-full', sampler: 'k_euler_ancestral', size: '832x1216', steps: 28, scale: 6, rescale: 0.1, uc: 0,
  quality: true, variety: false, order: 'action', delay: 0, rndDelay: true,
  chars: [], acts: [],
};
const run = { active: false, stop: false, items: [] };

// ---------- 저장 ----------
function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); Object.assign(S, saved || {}); } catch (e) { /* 저장된 게 없거나 깨짐 */ }
  if (!String(S.saveDir || '').trim()) S.saveDir = '생성';
  // 처음 켰을 때만 예시 카드를 만들어요. 직접 다 비운 건 비운 채로 둬요
  if (!saved || !Array.isArray(saved.chars)) { S.chars = [newChar('캐릭터 1')]; }
  if (!saved || !Array.isArray(saved.acts)) { S.acts = [newAct('동작 1')]; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { toast('브라우저에 저장하지 못했어요 (저장 공간이 막혔을 수 있어요)'); }
}
const newChar = (name) => ({ id: uid++, on: true, fold: false, name, main: '1girl, solo', look: '', neg: '', seed: '' });
const newAct = (name) => ({ id: uid++, on: true, fold: false, name, tags: '' });

// ---------- 작은 도구 ----------
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, ms);
}
async function api(url, body) {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j && j.error && r.status >= 400) throw new Error(j.error);
  return j;
}
const joinTags = (...p) => p.map((s) => String(s || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
const oneLine = (s) => joinTags(...String(s || '').split(/\r?\n/));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const fname = (s) => String(s || '').replace(/[^a-zA-Z0-9가-힣ㄱ-ㆎ_-]/g, '_').slice(0, 40) || 'x';
function parseSeed(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= MAX_SEED ? n : NaN;
}
async function sleep(ms) {
  const end = Date.now() + ms;
  while (!run.stop && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function readText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^﻿/, '')); r.onerror = rej; r.readAsText(file, 'utf-8'); });
}

// ---------- 카드 목록 (캐릭터 / 동작) ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function field(label, node) { const w = el('div'); w.appendChild(el('label', 'lab', label)); w.appendChild(node); return w; }
function textInput(value, ph, onInput) { const i = el('input'); i.type = 'text'; i.value = value; if (ph) i.placeholder = ph; i.addEventListener('input', () => { onInput(i.value); save(); }); return i; }
function area(value, rows, ph, onInput) { const t = el('textarea'); t.rows = rows; t.value = value; if (ph) t.placeholder = ph; t.addEventListener('input', () => { onInput(t.value); save(); }); return t; }

function buildCard(list, item, index, kind, rerender) {
  const card = el('div', 'card' + (item.on ? '' : ' off') + (item.fold ? ' fold' : ''));
  const head = el('div', 'head');
  const on = el('input'); on.type = 'checkbox'; on.checked = item.on; on.title = '생성에 포함';
  on.addEventListener('change', () => { item.on = on.checked; card.classList.toggle('off', !item.on); save(); summary(); });
  const name = textInput(item.name, kind === 'char' ? '캐릭터 이름' : '동작 이름', (v) => { item.name = v; });
  const btns = el('div', 'btns');
  const mk = (t, title, fn, cls) => { const b = el('button', cls || '', t); b.title = title; b.addEventListener('click', fn); btns.appendChild(b); };
  mk(item.fold ? '▸' : '▾', '접기/펴기', () => { item.fold = !item.fold; save(); rerender(); });
  mk('▲', '위로', () => move(list, index, -1, rerender));
  mk('▼', '아래로', () => move(list, index, 1, rerender));
  mk('⧉', '복제', () => { list.splice(index + 1, 0, { ...item, id: uid++, name: item.name + ' 복사' }); save(); rerender(); });
  mk('✕', '삭제', () => {
    if (!confirm(`'${item.name || '이름 없음'}'을(를) 삭제할까요?`)) return;
    list.splice(index, 1); save(); rerender();
  }, 'danger');
  head.append(on, name, btns);
  const body = el('div', 'body');
  if (kind === 'char') {
    body.append(
      field('메인 프롬프트 추가 (작가 태그 뒤: 1girl, 1boy 등)', area(item.main, 2, '1girl, solo', (v) => { item.main = v; })),
      field('외형 태그 (캐릭터 프롬프트)', area(item.look, 5, '', (v) => { item.look = v; })),
      field('개별 네거티브', area(item.neg, 2, '', (v) => { item.neg = v; }))
    );
    const seed = el('div', 'seedrow');
    const si = textInput(item.seed, '무작위', (v) => { item.seed = v.trim(); }); si.inputMode = 'numeric';
    const sc = el('button', 'small', '비우기'); sc.addEventListener('click', () => { item.seed = ''; si.value = ''; save(); });
    seed.append(si, sc);
    body.appendChild(field('시드 (비우면 무작위)', seed));
  } else {
    body.appendChild(area(item.tags, 5, '동작 태그', (v) => { item.tags = v; }));
  }
  card.append(head, body);
  return card;
}
function move(list, i, d, rerender) {
  const j = i + d; if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]]; save(); rerender();
}
function renderChars() { const box = $('chars'); box.replaceChildren(...S.chars.map((c, i) => buildCard(S.chars, c, i, 'char', renderChars))); summary(); }
function renderActs() { const box = $('acts'); box.replaceChildren(...S.acts.map((a, i) => buildCard(S.acts, a, i, 'act', renderActs))); summary(); }
function summary() {
  const c = S.chars.filter((x) => x.on).length, a = S.acts.filter((x) => x.on).length;
  $('charCnt').textContent = `${c}/${S.chars.length}`; $('actCnt').textContent = `${a}/${S.acts.length}`;
  $('summary').textContent = `캐릭터 ${c} × 동작 ${a} = ${c * a}장`;
  $('charAll').textContent = c === S.chars.length ? '전체 해제' : '전체 체크';
  $('actAll').textContent = a === S.acts.length ? '전체 해제' : '전체 체크';
  runButtons();
}
// 캐릭터 카드가 하나도 없으면 두 생성 버튼을 막아요
function runButtons() {
  const none = !S.chars.length;
  $('btnStart').disabled = run.active || none; $('btnTest').disabled = run.active || none;
  const tip = none ? '캐릭터를 먼저 추가해 주세요' : '';
  $('btnStart').title = tip; $('btnTest').title = none ? tip : '체크된 첫 캐릭터로, 동작 없이 한 장만';
}

// ---------- TXT 목록 (동작: 배치 생성기 메모장과 같은 형식) ----------
const CHAR_KEYS = [['메인', 'main'], ['외형', 'look'], ['네거티브', 'neg'], ['시드', 'seed']];
function exportChars() {
  const blocks = S.chars.map((c, i) => [`[${(c.name || `캐릭터 ${i + 1}`).trim()}]`, ...CHAR_KEYS.map(([l, k]) => `${l}: ${k === 'seed' ? String(c.seed || '').trim() : oneLine(c[k])}`)].join('\n'));
  download('character_list.txt', blocks.join('\n\n')); toast(`${S.chars.length}개 캐릭터를 저장했어요`);
}
function parseChars(text) {
  const out = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const t = line.match(/^\[([^\[\]]+)\]$/);
    if (t) { cur = { ...newChar(t[1].trim()), main: '' }; out.push(cur); continue; }
    const m = cur && line.match(/^(메인|외형|네거티브|시드)\s*:\s*(.*)$/);
    if (m) cur[CHAR_KEYS.find(([l]) => l === m[1])[1]] = m[2].trim();
  }
  return out;
}
function exportActs() {
  const blocks = S.acts.map((a, i) => `[${(a.name || `동작 ${i + 1}`).trim()}]\n캐릭터 1: ${oneLine(a.tags)}`);
  download('action_list.txt', blocks.join('\n\n')); toast(`${S.acts.length}개 동작을 저장했어요`);
}
function parseActs(text) {
  const out = []; let cur = null, skipped = 0;
  const open = (name) => { cur = { act: newAct(name), c1: null, other: null, plain: [] }; out.push(cur); };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const t = line.match(/^\[([^\[\]]+)\]$/);
    if (t) { open(t[1].trim()); continue; }
    if (!cur) open(`동작 ${out.length + 1}`);
    const m = line.match(/^캐릭터\s*(\d+)\s*:\s*(.*)$/i);
    if (!m) { cur.plain.push(line); continue; }
    if (m[1] === '1' && cur.c1 === null) cur.c1 = m[2].trim();
    else if (cur.other === null) cur.other = m[2].trim();
    else skipped++;
  }
  return { acts: out.map((o) => ({ ...o.act, tags: o.c1 ?? o.other ?? o.plain.join('\n') })), skipped };
}

// ---------- 요청 만들기 (NovelAI 이미지 생성) ----------
function buildJobs() {
  const cs = S.chars.filter((c) => c.on), as = S.acts.filter((a) => a.on), jobs = [];
  if (S.order === 'character') cs.forEach((c) => as.forEach((a) => jobs.push({ c, a })));
  else as.forEach((a) => cs.forEach((c) => jobs.push({ c, a })));
  return jobs;
}
function requestBody(c, a, seed) {
  const v5 = S.model.includes('nai-diffusion-5');
  const positive = joinTags(S.artist, c.main, S.quality ? QUALITY_TAGS : '');
  const negative = joinTags(UC_TEXT[S.uc] ?? UC_TEXT[0], S.negCommon);
  const cp = joinTags(c.look, a.tags), cn = joinTags(c.neg), has = !!(cp || cn);
  const [width, height] = S.size.split('x').map(Number);
  const center = { x: 0.5, y: 0.5 };
  const common = {
    width, height, scale: S.scale, sampler: S.sampler || 'k_euler_ancestral', steps: S.steps, seed, n_samples: 1,
    autoSmea: false, dynamic_thresholding: false, controlnet_strength: 1, legacy: false, add_original_image: false,
    cfg_rescale: S.rescale, legacy_v3_extend: false, skip_cfg_above_sigma: S.variety && !v5 ? 58 : null, use_coords: false,
    normalize_reference_strength_multiple: true, inpaintImg2ImgStrength: 1,
    characterPrompts: has ? [{ prompt: cp, uc: cn, center, enabled: true }] : [],
    v4_prompt: { caption: { base_caption: positive, char_captions: has ? [{ char_caption: cp, centers: [center] }] : [] }, use_coords: false, use_order: true },
    v4_negative_prompt: { caption: { base_caption: negative, char_captions: has ? [{ char_caption: cn, centers: [center] }] : [] }, legacy_uc: false },
    negative_prompt: negative, deliberate_euler_ancestral_bug: false, prefer_brownian: true, noise_schedule: 'karras', image_format: 'png', stream: 'msgpack',
  };
  const parameters = v5
    ? { params_version: 4, ucPresetId: UC_ID[S.uc] || 'heavy', qualityPresetId: S.quality ? 'standard' : 'none', legacy_uc: false, straight_alpha: true, tag_hint_qt: S.quality ? 1 : 0, tag_hint_uc_preset: S.uc, ...common }
    : { params_version: 3, ucPreset: S.uc, qualityToggle: S.quality, ...common };
  return { input: positive, model: S.model, action: 'generate', parameters, use_new_shared_trial: true };
}
function validate(jobs) {
  if (!S.apiKey.trim()) { toast('NovelAI API 키를 먼저 넣어 주세요'); return false; }
  if (!S.saveDir.trim()) { toast('저장 폴더를 먼저 골라 주세요'); return false; }
  if (!jobs.length) { toast('체크된 캐릭터와 동작이 최소 1개씩 있어야 해요'); return false; }
  for (const c of S.chars.filter((x) => x.on)) {
    if (Number.isNaN(parseSeed(c.seed))) { toast(`'${c.name}' 시드가 이상해요. 0~${MAX_SEED} 숫자로 넣거나 비워 주세요`, 5000); return false; }
  }
  return !(jobs.length > 30 && !confirm(`총 ${jobs.length}장을 만들어요. 계속할까요?`));
}

// ---------- 생성 ----------
function setRunning(on) {
  run.active = on;
  runButtons(); $('btnStop').style.display = on ? '' : 'none';
}
function progress(done, total, text) {
  $('prog').firstElementChild.style.width = total ? `${(done / total) * 100}%` : '0';
  $('count').textContent = total ? `${done} / ${total}` : '';
  if (text !== undefined) $('stat').textContent = text;
}
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

async function start(override) {
  if (run.active) return;
  const jobs = Array.isArray(override) ? override : buildJobs();
  if (!validate(jobs)) return;
  run.stop = false; setRunning(true); // 이전 미리보기는 지우지 않고 이어서 쌓아요 ('미리보기 지우기'로 직접 지워요)
  const tag = stamp();
  let done = 0, fails = 0, halted = false;
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (run.stop) break;
      const { c, a } = jobs[i];
      if (jobs[i].seed === undefined) jobs[i].seed = parseSeed(c.seed) ?? rnd(0, MAX_SEED); // 재시도해도 같은 시드
      const seed = jobs[i].seed;
      const filename = `${fname(c.name)}_${fname(a.name)}.png`; // 겹치면 서버가 (1), (2)를 붙여요
      progress(done, jobs.length, `${c.name} · ${a.name} 만드는 중... (${i + 1}/${jobs.length}, 시드 ${seed})`);
      let out;
      const sz = S.size;
      try {
        const r = await fetch('/api/gen/image', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-nai-key': S.apiKey.trim() },
          body: JSON.stringify({ body: requestBody(c, a, seed), dir: S.saveDir.trim(), filename }),
        });
        out = await r.json();
      } catch (e) { out = { ok: false, status: 0, error: `서버에 연결하지 못했어요: ${e.message}` }; }

      if (out.ok) {
        fails = 0; done++;
        run.items.push({ name: out.name, dir: S.saveDir.trim(), size: sz, label: `${i + 1}. ${c.name} · ${a.name} · ${seed}` });
        progress(done, jobs.length); renderResults();
      } else {
        if ([400, 401, 402, 403].includes(out.status) || /폴더|키가 필요/.test(out.error || '')) {
          toast(`${out.error}\n해결되지 않는 오류라 멈춰요. (401: 키 확인, 402: Anlas/구독 확인)`, 9000);
          progress(done, jobs.length, `멈춤 - ${out.error}`); halted = true; break;
        }
        fails++;
        if (fails >= MAX_FAILS) {
          run.items.push({ fail: out.error, label: `${i + 1}. ${c.name} · ${a.name}` }); renderResults();
          toast(`연속 ${MAX_FAILS}번 실패해서 멈춰요.\n${out.error}`, 9000); progress(done, jobs.length, `멈춤 - 연속 ${MAX_FAILS}번 실패: ${out.error}`); halted = true; break;
        }
        const wait = RETRY_MS * fails;
        progress(done, jobs.length, `${out.status === 429 ? '요청이 몰렸어요(429)' : '오류'} - ${wait / 1000}초 쉬고 같은 장을 다시 해요 (${fails}/${MAX_FAILS})`);
        await sleep(wait); i--; continue;
      }
      if (i < jobs.length - 1 && !run.stop) {
        const wait = S.rndDelay ? rnd(100, 2000) : Math.round(S.delay * 1000);
        if (wait > 0) { progress(done, jobs.length, `쉬는 중... (${(wait / 1000).toFixed(2)}초)`); await sleep(wait); }
      }
    }
    if (!halted) progress(done, jobs.length, run.stop ? `중단 - ${done}장 완료` : `완료 - ${done}/${jobs.length}장`);
  } finally { setRunning(false); }
}

// ---------- 결과 ----------
let lbIndex = -1;
const imgUrl = (name, dir) => `/api/image?dir=${encodeURIComponent((dir ?? S.saveDir).trim())}&rel=${encodeURIComponent(name)}`;
function renderResults() {
  const box = $('results');
  box.replaceChildren(...run.items.map((it, i) => {
    const t = el('div', 'thumb' + (it.name ? '' : ' fail'));
    if (it.name) { const im = el('img'); im.loading = 'lazy'; im.src = imgUrl(it.name, it.dir); if (it.size) im.style.aspectRatio = it.size.replace('x', ' / '); t.appendChild(im); t.addEventListener('click', () => openLb(i)); }
    else t.appendChild(el('div', 'box', `실패: ${it.fail}`));
    const cap = el('div', 'cap', it.label); cap.title = it.label; t.appendChild(cap);
    return t;
  }));
  box.scrollLeft = box.scrollWidth;
}
function openLb(i) {
  const it = run.items[i]; if (!it || !it.name) return;
  lbIndex = i; $('lbImg').src = imgUrl(it.name, it.dir); $('lbCap').textContent = it.label; $('lb').classList.add('on');
}
function stepLb(d) {
  let i = lbIndex;
  do { i += d; } while (run.items[i] && !run.items[i].name);
  if (run.items[i]) openLb(i);
}
const closeLb = () => { $('lb').classList.remove('on'); $('lbImg').src = ''; };

// ---------- 화면 연결 ----------
function bindValue(id, key, parse = (v) => v, evt = 'change') {
  const e = $(id); e.value = S[key];
  e.addEventListener(evt, () => { S[key] = parse(e.value); save(); });
}
function bindCheck(id, key, after) {
  const e = $(id); e.checked = !!S[key];
  e.addEventListener('change', () => { S[key] = e.checked; save(); if (after) after(); });
}
function keyState() {
  const st = $('keyState'), has = !!S.apiKey.trim();
  st.className = has ? 'ok' : 'no'; st.textContent = has ? '✓ 이 브라우저에 저장됨' : '키가 없어요. 넣으면 바로 저장돼요';
}
let whereSeq = 0;
async function showWhere() {
  const my = ++whereSeq, box = $('dirWhere'), v = S.saveDir.trim();
  if (!v) { box.textContent = '저장 폴더를 골라 주세요'; return; }
  try {
    const j = await api('/api/gen/where?dir=' + encodeURIComponent(v));
    if (my === whereSeq) box.textContent = '저장 위치: ' + j.abs + (/^([a-zA-Z]:[\\/]|[\\/])/.test(v) ? '' : '  (상대경로: 앱 폴더 기준)');
  } catch (e) { /* 표시만 못 하는 거예요 */ }
}
// Variety+는 V5에서는 없는 기능이라 V5를 고르면 끄고 잠가요 (요청에도 안 보내요)
function varietyUi() {
  const v5 = S.model.includes('nai-diffusion-5'), cb = $('variety');
  cb.disabled = v5; cb.checked = v5 ? false : !!S.variety;
  $('varietyHint').textContent = v5 ? '(V5에는 없는 기능이에요)' : '(다양성 증가)';
  cb.closest('label').style.opacity = v5 ? '.5' : '';
}
function delayUi() {
  $('delayV').textContent = S.rndDelay ? '무작위 사용 중' : `${S.delay}초`;
  $('delay').disabled = S.rndDelay;
}


// ---------- 그림에서 태그 가져오기 (PNG 메타데이터 / NovelAI 스텔스 정보) ----------
async function inflate(bytes, fmt) {
  const ds = new DecompressionStream(fmt);
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);
async function pngTexts(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), out = {};
  if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50) return out;
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const d = u8.subarray(p + 8, p + 8 + len);
    try {
      if (type === 'tEXt') { const z = d.indexOf(0); out[utf8(d.subarray(0, z))] = utf8(d.subarray(z + 1)); }
      else if (type === 'zTXt') { const z = d.indexOf(0); out[utf8(d.subarray(0, z))] = utf8(await inflate(d.subarray(z + 2), 'deflate')); }
      else if (type === 'iTXt') {
        const z = d.indexOf(0), comp = d[z + 1]; let q = z + 3;
        q = d.indexOf(0, q) + 1; q = d.indexOf(0, q) + 1;
        out[utf8(d.subarray(0, z))] = comp ? utf8(await inflate(d.subarray(q), 'deflate')) : utf8(d.subarray(q));
      }
    } catch (e) { /* 깨진 조각은 건너뜀 */ }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}
// NovelAI 스텔스 정보: 알파 채널 맨 아래 비트에 숨겨진 gzip JSON (열 단위로 읽어요)
async function stealthText(file) {
  const bmp = await createImageBitmap(file);
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data, W = cv.width, H = cv.height;
  let x = 0, y = 0;
  const bit = () => { if (x >= W) return null; const b = px[(y * W + x) * 4 + 3] & 1; if (++y >= H) { y = 0; x++; } return b; };
  const bytes = (n) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < 8; k++) { const b = bit(); if (b === null) return null; v = (v << 1) | b; } o[i] = v; } return o; };
  const sig = bytes(15); if (!sig) return '';
  const s = String.fromCharCode(...sig);
  if (s !== 'stealth_pngcomp' && s !== 'stealth_pnginfo') return '';
  const l = bytes(4); if (!l) return '';
  const n = ((l[0] << 24) | (l[1] << 16) | (l[2] << 8) | l[3]) >>> 0;
  if (!n || n > 8 * 4_000_000) return '';
  const data = bytes(Math.ceil(n / 8)); if (!data) return '';
  return utf8(s === 'stealth_pngcomp' ? await inflate(data, 'gzip') : data);
}
const tryJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
async function readImageTags(file) {
  const texts = await pngTexts(await file.arrayBuffer());
  let meta = tryJson(texts.Comment) || null, desc = texts.Description || '';
  if (!meta && !desc) {
    const st = tryJson(await stealthText(file).catch(() => ''));
    if (st) { meta = typeof st.Comment === 'string' ? tryJson(st.Comment) : st.Comment || st; desc = st.Description || ''; }
  }
  if (!meta && !desc) return null;
  meta = meta || {};
  const cap = (o) => (o && o.caption) || {};
  const v4 = cap(meta.v4_prompt), v4n = cap(meta.v4_negative_prompt);
  // 입력한 원본(랜덤 문법 ||a|b|| 그대로)은 v4_prompt에, 실제로 뽑힌 결과는 actual_prompts에 들어 있어요
  const pack = (pos, neg, fbBase, fbNeg) => {
    const pc = (pos && pos.char_captions) || [], nc = (neg && neg.char_captions) || [];
    return {
      base: String((pos && pos.base_caption) ?? fbBase ?? ''),
      neg: String((neg && neg.base_caption) ?? fbNeg ?? ''),
      chars: pc.map((c, i) => ({ look: String(c.char_caption || ''), neg: String((nc[i] && nc[i].char_caption) || '') })).filter((c) => c.look || c.neg),
    };
  };
  const o = pack(v4, v4n, meta.prompt ?? desc, meta.uc);
  const ap = meta.actual_prompts;
  const a = ap && (ap.prompt || ap.negative_prompt) ? pack(ap.prompt, ap.negative_prompt, o.base, o.neg) : o;
  const hasActual = JSON.stringify(a) !== JSON.stringify(o);
  return { orig: o, act: a, hasActual, seed: meta.seed, meta };
}

// 그림 메타데이터를 NovelAI처럼 고른 항목만 그대로 가져와요 (태그를 걸러내거나 고치지 않아요)
function openTagDialog(file, info) {
  const stem = file.name.replace(/\.[^.]+$/, '');
  const dlg = $('tagDlg'); dlg.replaceChildren();
  const m = info.meta || {};
  const sizeKey = m.width && m.height ? `${m.width}x${m.height}` : '';
  const sizeOk = [...$('size').options].some((o) => o.value === sizeKey);
  const samplerOk = m.sampler && [...$('sampler').options].some((o) => o.value === m.sampler);
  const hasSettings = m.steps !== undefined || m.scale !== undefined || m.cfg_rescale !== undefined || samplerOk || sizeOk || m.ucPreset !== undefined;
  const items = [
    ['prompt', '메인 프롬프트 (작가 태그 칸으로)', !!info.orig.base],
    ['neg', '네거티브 (공통 네거티브로)', !!info.orig.neg],
    ['chars', '캐릭터 프롬프트 (외형·네거티브)', info.orig.chars.length > 0 || info.act.chars.length > 0],
    ['settings', '설정 (스텝·가이던스·샘플러·크기 등)', hasSettings],
    ['seed', '시드', info.seed !== undefined],
    ['actual', '실제 프롬프트 (랜덤 프롬프트의 결과값만 남기기)', info.hasActual],
  ];
  const box = el('div', 'box');
  const head = el('div', 'dh'); head.append(el('b', '', '이 그림에 메타데이터가 있어요! 가져올까요?'), el('span', 'dim', ` ${file.name}`));
  const x = el('button', 'x', '✕'); x.addEventListener('click', () => { dlg.classList.remove('on'); }); head.appendChild(x);
  box.appendChild(head);
  const cbs = {};
  for (const [key, label, has] of items) {
    const row = el('label', 'chk'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = has && key !== 'actual'; cb.disabled = !has;
    row.append(cb, document.createTextNode(' ' + label + (has ? '' : key === 'actual' ? ' (이 그림은 해당 없음)' : ' (없음)'))); if (!has) row.style.opacity = '.5';
    cbs[key] = cb; box.appendChild(row);
  }
  const note = el('div', 'dim', '※ 가져온 프롬프트는 고치지 않고 그대로 넣어요. 그림에 든 포즈·표정 같은 동작 태그는 자동으로 나눠지지 않으니, 필요하면 직접 지우고 동작 카드에 옮겨 주세요.');
  note.style.margin = '8px 0';
  const go = el('button', 'primary', '메타데이터 가져오기');
  go.addEventListener('click', () => {
    const did = [];
    const v = cbs.actual.checked ? info.act : info.orig;
    if (cbs.prompt.checked && v.base) { S.artist = v.base; $('artist').value = S.artist; did.push('작가 태그 칸'); }
    if (cbs.chars.checked && v.chars.length) {
      const seed = cbs.seed.checked && info.seed !== undefined ? String(info.seed) : '';
      v.chars.forEach((c, i) => S.chars.push({ ...newChar(i ? `${stem} ${i + 1}` : stem), main: '', look: c.look, neg: c.neg, seed }));
      renderChars(); did.push(`캐릭터 카드 ${v.chars.length}개 추가`);
    } else if (cbs.seed.checked) toast('시드는 새 캐릭터 카드에 들어가요. 캐릭터 프롬프트도 같이 골라 주세요', 5000);
    if (cbs.neg.checked && v.neg) { S.negCommon = v.neg; $('negCommon').value = S.negCommon; did.push('공통 네거티브'); }
    if (cbs.settings.checked) {
      const set = (id, key, v) => { S[key] = v; $(id).value = v; };
      if (m.steps !== undefined) set('steps', 'steps', Number(m.steps));
      if (m.scale !== undefined) set('scale', 'scale', Number(m.scale));
      if (m.cfg_rescale !== undefined) set('rescale', 'rescale', Number(m.cfg_rescale));
      if (samplerOk) set('sampler', 'sampler', m.sampler);
      if (sizeOk) set('size', 'size', sizeKey);
      if (m.ucPreset !== undefined && [0, 1, 2, 3].includes(Number(m.ucPreset))) set('uc', 'uc', Number(m.ucPreset));
      did.push('설정');
    }
    save(); dlg.classList.remove('on');
    toast(did.length ? `가져왔어요: ${did.join(', ')}` : '가져올 항목을 골라 주세요');
  });
  box.append(note, go);
  dlg.appendChild(box); dlg.classList.add('on');
}
async function importImageTags(file) {
  if (!file) return;
  if (!/\.png$/i.test(file.name) && file.type !== 'image/png') return toast('PNG 그림만 읽을 수 있어요 (JPG/WebP는 태그가 없어요)');
  try {
    const info = await readImageTags(file);
    if (!info) return toast('이 그림에서 태그를 찾지 못했어요.\n(흰칠 탭 결과물처럼 메타데이터를 지운 그림이거나, 다른 곳에서 다시 저장한 그림일 수 있어요)', 6000);
    openTagDialog(file, info);
  } catch (e) { toast(`읽지 못했어요: ${e.message}`); }
}
function initTagDrop() {
  const ov = $('dropOv'); let depth = 0;
  const hasFile = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFile(e)) return; depth++; ov.classList.add('on'); });
  window.addEventListener('dragleave', (e) => { if (!hasFile(e)) return; if (--depth <= 0) { depth = 0; ov.classList.remove('on'); } });
  window.addEventListener('dragover', (e) => { if (hasFile(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFile(e)) return; e.preventDefault(); depth = 0; ov.classList.remove('on');
    importImageTags([...e.dataTransfer.files].find((f) => /\.png$/i.test(f.name) || f.type === 'image/png') || e.dataTransfer.files[0]);
  });
  $('tagPick').addEventListener('click', () => $('tagFile').click());
  $('tagFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importImageTags(f); });
  $('tagDlg').addEventListener('click', (e) => { if (e.target === $('tagDlg')) $('tagDlg').classList.remove('on'); });
}

function init() {
  load();
  $('apiKey').value = S.apiKey; keyState();
  $('apiKey').addEventListener('input', () => { S.apiKey = $('apiKey').value.trim(); save(); keyState(); });
  $('keyShow').addEventListener('click', () => { const k = $('apiKey'); k.type = k.type === 'password' ? 'text' : 'password'; $('keyShow').textContent = k.type === 'password' ? '보기' : '숨기기'; });
  $('keyClear').addEventListener('click', () => { if (!S.apiKey || confirm('저장된 API 키를 지울까요?')) { S.apiKey = ''; $('apiKey').value = ''; save(); keyState(); } });

  bindValue('artist', 'artist', (v) => v, 'input');
  bindValue('negCommon', 'negCommon', (v) => v, 'input');
  bindValue('model', 'model'); bindValue('size', 'size');
  bindValue('sampler', 'sampler');
  bindValue('steps', 'steps', (v) => parseInt(v, 10) || 28);
  bindValue('scale', 'scale', (v) => parseFloat(v) || 6);
  bindValue('rescale', 'rescale', (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; });
  bindValue('uc', 'uc', (v) => parseInt(v, 10) || 0);
  bindValue('order', 'order');
  bindCheck('quality', 'quality'); bindCheck('variety', 'variety');
  $('model').addEventListener('change', varietyUi); varietyUi();
  bindCheck('rndDelay', 'rndDelay', delayUi);
  $('delay').value = S.delay;
  $('delay').addEventListener('input', () => { S.delay = parseFloat($('delay').value) || 0; delayUi(); });
  $('delay').addEventListener('change', save);
  delayUi();

  // 저장 폴더: 처음엔 검열 탭의 그림 폴더 안 '생성' 폴더를 제안
  $('saveDir').value = S.saveDir;
  $('saveDir').addEventListener('input', () => { S.saveDir = $('saveDir').value.trim(); save(); showWhere(); });
  showWhere();
  $('pickDir').addEventListener('click', async () => {
    try { const j = await api('/api/pick-folder', { initial: S.saveDir }); if (j.dir) { S.saveDir = j.dir; $('saveDir').value = j.dir; save(); showWhere(); } } catch (e) { toast(e.message); }
  });
  const openDir = async () => { if (!S.saveDir.trim()) return toast('저장 폴더를 먼저 골라 주세요'); try { await api('/api/open-folder', { dir: S.saveDir.trim() }); } catch (e) { toast(e.message); } };
  $('btnClearPrev').addEventListener('click', () => { run.items = []; closeLb(); renderResults(); });
  $('openDir').addEventListener('click', openDir); $('btnOpen').addEventListener('click', openDir);
  $('btnCensor').addEventListener('click', async () => {
    if (!S.saveDir.trim()) return toast('저장 폴더를 먼저 골라 주세요');
    try {
      const cfg = await api('/api/config');
      const w = await api('/api/gen/where?dir=' + encodeURIComponent(S.saveDir.trim()));
      await api('/api/last', { inputDir: w.abs, outputDir: cfg.outputAbs || '', outInside: !!cfg.outInside });
    } catch (e) { /* 못 넘겨도 검열 화면으로는 가요 */ }
    location.href = '/';
  });

  $('charAdd').addEventListener('click', () => { S.chars.push(newChar(`캐릭터 ${S.chars.length + 1}`)); save(); renderChars(); $('chars').lastElementChild?.scrollIntoView({ block: 'nearest' }); });
  $('actAdd').addEventListener('click', () => { S.acts.push(newAct(`동작 ${S.acts.length + 1}`)); save(); renderActs(); $('acts').lastElementChild?.scrollIntoView({ block: 'nearest' }); });
  $('charAll').addEventListener('click', () => { const all = S.chars.every((c) => c.on); S.chars.forEach((c) => { c.on = !all; }); save(); renderChars(); });
  $('actAll').addEventListener('click', () => { const all = S.acts.every((a) => a.on); S.acts.forEach((a) => { a.on = !all; }); save(); renderActs(); });
  $('charExport').addEventListener('click', exportChars);
  $('actExport').addEventListener('click', exportActs);
  $('charImport').addEventListener('click', () => $('charFile').click());
  $('actImport').addEventListener('click', () => $('actFile').click());
  $('charFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const list = parseChars(await readText(f));
    if (!list.length) return toast('TXT에서 [캐릭터 이름] 형식을 찾지 못했어요');
    S.chars = list; save(); renderChars(); toast(`${list.length}개 캐릭터를 불러왔어요`);
  });
  $('actFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const { acts, skipped } = parseActs(await readText(f));
    if (!acts.length) return toast('TXT에서 [동작 이름] 형식을 찾지 못했어요');
    S.acts = acts; save(); renderActs(); toast(`${acts.length}개 동작을 불러왔어요` + (skipped ? ' (여러 명이 든 메모장은 캐릭터 1 줄만 가져왔어요)' : ''), 5000);
  });

  $('btnStart').addEventListener('click', () => start());
  $('btnTest').addEventListener('click', () => {
    const c = S.chars.find((x) => x.on); if (!c) return toast('체크된 캐릭터가 없어요');
    start([{ c, a: { name: '테스트', tags: '' } }]);
  });
  $('btnStop').addEventListener('click', () => { run.stop = true; $('stat').textContent = '중단 요청됨 - 지금 만드는 장까지만 받고 멈춰요'; });

  $('lb').addEventListener('click', (e) => { if (e.target === $('lb')) closeLb(); });
  $('lbX').addEventListener('click', closeLb);
  document.addEventListener('keydown', (e) => {
    if (!$('lb').classList.contains('on')) return;
    if (e.key === 'Escape') closeLb(); else if (e.key === 'ArrowLeft') stepLb(-1); else if (e.key === 'ArrowRight') stepLb(1);
  });
  window.addEventListener('beforeunload', (e) => { if (run.active) { e.preventDefault(); e.returnValue = ''; } });

  initTagDrop();
  renderChars(); renderActs(); renderResults(); progress(0, 0, '');
}
init();

(() => {
  // 서버에 '화면이 열려 있어요' 신호를 보내요. 창을 닫으면 서버(검은 창)도 같이 꺼져요.
  const id = Math.random().toString(36).slice(2);
  let fails = 0, bar = null;
  const hb = () => {
    fetch('/api/hb?id=' + id, { method: 'POST', keepalive: true })
      .then(() => { fails = 0; if (bar) { bar.remove(); bar = null; } })
      .catch(() => {
        // 서버(검은 창)가 꺼졌어요. 웹페이지는 스스로 탭을 닫을 수 없어서 안내만 띄워요
        if (++fails >= 1 && !bar) {
          bar = document.createElement('div');
          bar.style.cssText = 'position:fixed;inset:0;z-index:99;background:#0b1020ee;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;font:600 18px/1.7 sans-serif;padding:24px';
          bar.textContent = 'NAI Factory · Hinchil이 꺼졌어요 (검은 창이 닫혔어요). 이 탭을 닫아 주세요.\n다시 쓰려면 start-gui.bat 을 실행하세요.';
          bar.style.whiteSpace = 'pre-line'; document.body.appendChild(bar);
        }
      });
  };
  hb(); setInterval(hb, 2000);
  addEventListener('pageshow', hb);
  addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye?id=' + id); } catch (e) { /* 무시 */ } });
})();
