'use strict';
// Made by 크랙 크리에이터 넉넉한 취향 (https://share.crack.wrtn.ai/4dihl6) 의 클로드 어시스턴트 서한결 제작
// 감지 결과 저장소 + 백그라운드 미리 스캔.
// 폴더마다 JSON 파일 하나(캐시 폴더)에 그림별 감지 결과를 모아 저장해서, 다시 열어도 모델을 또 돌리지 않음.
// 그림이 없어지면 해당 항목도 자동으로 지움. 그림 폴더에는 아무것도 만들지 않음.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '캐시');
const SCAN_THRESHOLD = 0.05; // 가장 낮은 민감도로 한 번만 감지해 저장. 민감도/부위는 화면에서 바로 걸러냄
const SIG_TAG = 't005';

module.exports = function createScanner({ H, ensure, isBusy }) {
  const stores = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r1 = (v) => Math.round(v * 10) / 10;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // ----- 저장소 -----
  function storeFile(dirAbs) {
    const base = path.basename(dirAbs).replace(/[^\w가-힣.-]/g, '_').slice(0, 30) || 'dir';
    const h = crypto.createHash('sha1').update(dirAbs).digest('hex').slice(0, 8);
    return path.join(CACHE_DIR, `${base}-${h}.json`);
  }
  function getStore(dirAbs, create) {
    if (stores.has(dirAbs)) return stores.get(dirAbs);
    const file = storeFile(dirAbs);
    let data = null;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.v === 1 && j.dir === dirAbs && j.files && typeof j.files === 'object') data = j;
    } catch (e) {
      /* 없거나 깨졌으면 새로 시작 */
    }
    if (!data && !create) return null;
    if (!data) data = { v: 1, dir: dirAbs, files: {} };
    if (!data.reviewed || typeof data.reviewed !== 'object') data.reviewed = {};
    let ver = 0;
    for (const e of Object.values(data.files)) if (e.q > ver) ver = e.q;
    const store = { file, data, ver, timer: null };
    stores.set(dirAbs, store);
    return store;
  }
  const serialize = (st) => ({ v: 1, dir: st.data.dir, reviewed: st.data.reviewed, files: st.data.files });
  function save(store) {
    if (store.timer) return;
    store.timer = setTimeout(() => {
      store.timer = null;
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = store.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(serialize(store)), 'utf8');
        fs.renameSync(tmp, store.file);
      } catch (e) {
        console.error('캐시 저장 실패(무시하고 계속해요): ' + e.message);
      }
    }, 1500);
  }
  function flushAll() {
    for (const s of stores.values()) {
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
        try {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          fs.writeFileSync(s.file, JSON.stringify(serialize(s)), 'utf8');
        } catch (e) {
          /* 무시 */
        }
      }
    }
  }

  // 모델 파일이 바뀌면 그 모델의 저장 결과는 무효
  function sig(key) {
    try {
      const st = fs.statSync(path.resolve(__dirname, H.DETECTORS[key].file));
      return `${st.size}-${Math.round(st.mtimeMs)}-${SIG_TAG}`;
    } catch (e) {
      return null;
    }
  }

  const keyedNow = (e, st) => e && e.m === Math.round(st.mtimeMs) && e.s === st.size;
  const detView = (e, keys) => {
    const out = [];
    for (const k of keys) for (const a of e.d[k].a) out.push({ label: a[0], score: a[1], x1: a[2], y1: a[3], x2: a[4], y2: a[5], det: k });
    return out.map((d, i) => ({ id: i, ...d }));
  };

  // ----- 감지 (저장된 게 있으면 그대로, 없으면 모델을 돌리고 저장) -----
  async function detectCached(dirAbs, rel, keys) {
    const full = path.join(dirAbs, rel);
    const st = fs.statSync(full);
    const store = getStore(dirAbs, true);
    let e = store.data.files[rel];
    const fresh = keyedNow(e, st);
    if (!fresh) e = { m: Math.round(st.mtimeMs), s: st.size, W: 0, H: 0, d: {}, q: 0 };
    for (const k of keys) await ensure(k);
    const missing = keys.filter((k) => !(fresh && e.d[k] && e.d[k].g === sig(k)));
    if (missing.length) {
      const raw = await H.loadRaw(full);
      for (const k of missing) {
        const all = await H.detectAll(raw, [k], SCAN_THRESHOLD);
        e.d[k] = { g: sig(k), a: all.map((d) => [d.label, r3(d.score), r1(d.x1), r1(d.y1), r1(d.x2), r1(d.y2)]) };
      }
      e.W = raw.width;
      e.H = raw.height;
      e.q = ++store.ver;
      store.data.files[rel] = e;
      save(store);
    }
    return { width: e.W, height: e.H, detections: detView(e, keys) };
  }

  // ----- 없어진 그림 정리 -----
  function prune(dirAbs) {
    const store = getStore(dirAbs, false);
    if (!store) return 0;
    let n = 0;
    for (const rel of Object.keys(store.data.files)) {
      if (!fs.existsSync(path.join(dirAbs, rel))) {
        delete store.data.files[rel];
        n++;
      }
    }
    for (const rel of Object.keys(store.data.reviewed)) {
      if (!fs.existsSync(path.join(dirAbs, rel))) {
        delete store.data.reviewed[rel];
        n++;
      }
    }
    if (n) {
      store.ver++;
      save(store);
    }
    return n;
  }
  // 시작할 때: 폴더 자체가 사라진 캐시 파일 지우기. 상위 폴더까지 없으면(드라이브가 꺼진 경우 등) 건드리지 않음
  function cleanupOrphans() {
    let names = [];
    try {
      names = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith('.json'));
    } catch (e) {
      return 0;
    }
    let removed = 0;
    for (const n of names) {
      const f = path.join(CACHE_DIR, n);
      try {
        const fd = fs.openSync(f, 'r');
        const buf = Buffer.alloc(2048);
        const len = fs.readSync(fd, buf, 0, 2048, 0);
        fs.closeSync(fd);
        const m = /"dir":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, len));
        if (!m) continue;
        const dir = JSON.parse(m[1]);
        if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) {
          fs.unlinkSync(f);
          removed++;
        }
      } catch (e) {
        /* 무시 */
      }
    }
    return removed;
  }

  // ----- 결과 조회 (화면 표시용). since 이후 바뀐 것만 -----
  function results(dirAbs, keys, since) {
    const store = getStore(dirAbs, false);
    if (!store) return { ver: 0, files: {} };
    const files = {};
    for (const [rel, e] of Object.entries(store.data.files)) {
      if (!(e.q > since)) continue;
      if (!keys.every((k) => e.d[k] && e.d[k].g === sig(k))) continue;
      files[rel] = detView(e, keys).map((d) => [d.label, d.score, d.x1, d.y1, d.x2, d.y2, d.det]);
    }
    return { ver: store.ver, files };
  }

  // ----- 백그라운드 스캔 -----
  const scan = { state: 'idle', dir: '', recursive: true, keys: [], total: 0, done: 0, failed: 0, current: '', error: null, token: 0, userPending: 0 };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function start({ dirAbs, recursive, outAbs, keys }) {
    if (scan.state === 'running' && scan.dir === dirAbs && scan.recursive === recursive && same(scan.keys, keys)) return;
    const my = ++scan.token;
    Object.assign(scan, { state: 'running', dir: dirAbs, recursive, keys: keys.slice(), total: 0, done: 0, failed: 0, current: '', error: null });
    run(my, dirAbs, recursive, outAbs, keys.slice()).catch((e) => {
      if (scan.token === my) Object.assign(scan, { state: 'error', error: e.message });
    });
  }
  async function run(my, dirAbs, recursive, outAbs, keys) {
    prune(dirAbs);
    const files = H.listImages(dirAbs, recursive, outAbs || null);
    scan.total = files.length;
    for (const full of files) {
      if (scan.token !== my) return;
      // 사용자가 그림을 열었거나 일괄 실행 중이면 잠깐 양보
      while ((scan.userPending > 0 || isBusy()) && scan.token === my) await sleep(80);
      if (scan.token !== my) return;
      const rel = path.relative(dirAbs, full);
      const rv = getStore(dirAbs, false);
      if (rv && rv.data.reviewed[rel]) {
        scan.done++; // 검수 끝난 그림은 스캔하지 않음
        continue;
      }
      scan.current = rel;
      try {
        await detectCached(dirAbs, rel, keys);
      } catch (e) {
        if (scan.token !== my) return;
        scan.failed++;
        // 모델 자체 문제(파일 없음 등)면 계속해 봐야 소용없으니 멈춤
        if (/모델|model/i.test(e.message)) {
          Object.assign(scan, { state: 'error', error: e.message });
          return;
        }
      }
      scan.done++;
    }
    if (scan.token === my) {
      scan.state = 'done';
      scan.current = '';
    }
  }
  function stop() {
    scan.token++;
    if (scan.state === 'running') scan.state = 'stopped';
  }
  const status = () => ({ state: scan.state, dir: scan.dir, total: scan.total, done: scan.done, failed: scan.failed, current: scan.current, error: scan.error });
  const userBusy = async (fn) => {
    scan.userPending++;
    try {
      return await fn();
    } finally {
      scan.userPending--;
    }
  };

  // ----- 검수 체크 (그림마다 저장) -----
  // edit: 검수하면서 고친 내용. ex = 제외한 박스 [[라벨,x1,y1,x2,y2],...], man = 직접 그린 박스 [{x1,y1,x2,y2},...]
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
  function cleanEdit(edit) {
    if (!edit || typeof edit !== 'object') return null;
    const ex = (Array.isArray(edit.ex) ? edit.ex : []).slice(0, 300).map((a) => [String(a[0] || ''), num(a[1]), num(a[2]), num(a[3]), num(a[4])]);
    const man = (Array.isArray(edit.man) ? edit.man : []).slice(0, 300).map((b) => ({ x1: num(b.x1), y1: num(b.y1), x2: num(b.x2), y2: num(b.y2) }));
    return ex.length || man.length ? { ex, man } : null;
  }
  function setReviewed(dirAbs, rel, on, edit) {
    const store = getStore(dirAbs, true);
    if (on) {
      const e = cleanEdit(edit);
      store.data.reviewed[rel] = e ? { t: Date.now(), ex: e.ex, man: e.man } : { t: Date.now() };
    } else delete store.data.reviewed[rel];
    save(store);
  }
  function reviewedEdits(dirAbs) {
    const store = getStore(dirAbs, false);
    const out = {};
    if (store) for (const [rel, v] of Object.entries(store.data.reviewed)) if (v && typeof v === 'object' && (v.ex || v.man)) out[rel] = { ex: v.ex || [], man: v.man || [] };
    return out;
  }
  function reviewedList(dirAbs) {
    const store = getStore(dirAbs, false);
    return store ? Object.keys(store.data.reviewed) : [];
  }

  // 완전 초기화: 스캔을 멈추고, 메모리와 캐시 폴더(감지 결과, 검수 표시, 마지막 폴더 기억)를 모두 비워요
  function resetAll() {
    try { stop(); } catch (e) { /* 실행 중이 아니면 무시 */ }
    for (const s of stores.values()) if (s.timer) clearTimeout(s.timer);
    stores.clear();
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  }

  // 캐시만 비우기: 미리 스캔한 감지 결과만 지워요. 검수 표시, 고친 박스, 마지막에 쓴 폴더 기억, 설정은 그대로 둬요
  function clearCache() {
    try { stop(); } catch (e) { /* 실행 중이 아니면 무시 */ }
    // 아직 파일에 안 쓴 검수 표시부터 저장하고, 메모리의 감지 결과는 저장소 객체째 비워요.
    // (객체를 버리면, 돌던 감지가 끝나며 옛 결과 전체를 파일에 다시 써 버려요)
    flushAll();
    for (const st of stores.values()) st.data.files = {};
    let names = [];
    try { names = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith('.json') && n !== 'last-folders.json'); } catch (e) { return { folders: 0, entries: 0, bytes: 0 }; }
    let folders = 0, entries = 0, bytes = 0;
    for (const n of names) {
      const f = path.join(CACHE_DIR, n);
      try {
        const before = fs.statSync(f).size;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const cnt = j && j.files ? Object.keys(j.files).length : 0;
        const keepReviewed = j && j.reviewed && typeof j.reviewed === 'object' && Object.keys(j.reviewed).length > 0;
        if (keepReviewed) {
          j.files = {};
          fs.writeFileSync(f, JSON.stringify({ v: 1, dir: j.dir, reviewed: j.reviewed, files: {} }), 'utf8');
          bytes += Math.max(0, before - fs.statSync(f).size);
        } else {
          fs.rmSync(f, { force: true });
          bytes += before;
        }
        folders++; entries += cnt;
      } catch (e) { /* 깨진 파일은 건너뜀 */ }
    }
    return { folders, entries, bytes };
  }

  return { clearCache, resetAll, setReviewed, reviewedList, reviewedEdits, detectCached, prune, cleanupOrphans, results, start, stop, status, userBusy, flushAll };
};
