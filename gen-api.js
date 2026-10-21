'use strict';
// 생성 탭용 서버 쪽 도우미: NovelAI에 요청을 보내고, 받은 그림을 폴더에 저장해요.
// API 키는 브라우저가 요청마다 보내 주는 값을 그대로 쓰고, 파일이나 로그에는 남기지 않아요.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const API_URL = 'https://image.novelai.net/ai/generate-image';

// NovelAI 응답은 zip 한 개예요. 안에서 첫 그림 파일을 꺼내요 (zlib만 사용).
function firstImageFromZip(zip) {
  let e = zip.length - 22;
  while (e >= 0 && zip.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('응답이 zip 형식이 아니에요');
  const count = zip.readUInt16LE(e + 10);
  let p = zip.readUInt32LE(e + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28);
    const xlen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const lho = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nlen);
    if (/\.(png|jpg|jpeg)$/i.test(name)) {
      const start = lho + 30 + zip.readUInt16LE(lho + 26) + zip.readUInt16LE(lho + 28);
      const data = zip.subarray(start, start + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error('응답에 그림이 없어요');
}

function safeName(name) {
  const base = path.basename(String(name || 'image.png')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  return /\.png$/i.test(base) ? base : base + '.png';
}

// 한 장 생성 → dir/filename 으로 저장. 실패는 { ok:false, status, error } 로 돌려줘요.
async function generate({ key, body, dir, filename }) {
  if (!key) return { ok: false, status: 401, error: 'NovelAI API 키가 필요해요' };
  if (!dir || !path.isAbsolute(dir)) return { ok: false, status: 0, error: '저장 폴더를 먼저 골라 주세요' };
  if (!body || typeof body !== 'object') return { ok: false, status: 0, error: '요청 내용이 비었어요' };
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `NovelAI에 연결하지 못했어요: ${e.name === 'TimeoutError' ? '시간 초과' : e.message}` };
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(key, '***').slice(0, 200);
    return { ok: false, status: res.status, error: `서버 응답 오류 ${res.status}${text ? ': ' + text : ''}` };
  }
  let png;
  try {
    png = firstImageFromZip(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
  fs.mkdirSync(dir, { recursive: true });
  // 이름이 겹치면 "이름(1).png", "이름(2).png" … 로 저장해요 (기존 파일은 덮어쓰지 않아요)
  const base = safeName(filename).replace(/\.png$/i, '');
  let name = `${base}.png`;
  for (let n = 0; ; n++) {
    if (n > 0) name = `${base}(${n}).png`;
    try { fs.writeFileSync(path.join(dir, name), png, { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST' || n > 9999) return { ok: false, status: 0, error: `저장하지 못했어요: ${e.message}` }; }
  }
  return { ok: true, name, bytes: png.length };
}

// ----- 잔여량 (Anlas, V5 사용량 %) -----
// 계정 정보를 돌려주는 주소가 바뀐 적이 있어서, 새 주소부터 시도하고 안 되면 옛 주소를 써요.
const BALANCE_URLS = ['https://image.novelai.net/user/subscription', 'https://api.novelai.net/user/data'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// 응답(JSON)에서 Anlas와 V5 사용량을 뽑아요. 못 찾은 값은 null.
function parseBalance(j) {
  if (!j || typeof j !== 'object') return null;
  const sub = j.subscription && typeof j.subscription === 'object' ? j.subscription : j;
  const steps = sub.trainingStepsLeft || j.trainingStepsLeft || null;
  const fixed = steps ? num(steps.fixedTrainingStepsLeft) : null;
  const purchased = steps ? num(steps.purchasedTrainingSteps) : null;
  const usage = (sub.usage && typeof sub.usage === 'object' ? sub.usage : null) || (j.usage && typeof j.usage === 'object' ? j.usage : null);
  const pct = usage ? num(usage.percent) : null;
  if (fixed === null && purchased === null && pct === null) return null;
  return {
    anlas: fixed === null && purchased === null ? null : (fixed || 0) + (purchased || 0),
    fixed, purchased,
    usagePercent: pct, // V5 사용량: 100이 가득, 쓰면 줄어요
    usageNegative: usage && typeof usage.isNegative === 'boolean' ? usage.isNegative : null,
    tier: num(sub.tier), active: typeof sub.active === 'boolean' ? sub.active : null,
  };
}

async function balance(key) {
  if (!key) return { ok: false, status: 401, error: 'NovelAI API 키가 필요해요' };
  let last = '';
  for (const url of BALANCE_URLS) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 401) return { ok: false, status: 401, error: '키가 올바르지 않아요 (401)' };
      if (!res.ok) { last = `서버 응답 ${res.status}`; continue; }
      const b = parseBalance(await res.json());
      if (b) return { ok: true, ...b };
      last = '응답에서 잔여량을 찾지 못했어요';
    } catch (e) { last = e.name === 'TimeoutError' ? '시간 초과' : e.message; }
  }
  return { ok: false, status: 0, error: `잔여량을 못 읽었어요: ${String(last).replace(key, '***')}` };
}

module.exports = { generate, balance, parseBalance, firstImageFromZip, safeName };
