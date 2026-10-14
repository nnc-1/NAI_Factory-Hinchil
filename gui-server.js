'use strict';
// Made by 크랙 크리에이터 넉넉한 취향 (https://share.crack.wrtn.ai/4dihl6) 의 클로드 어시스턴트 서한결 제작
// 흰칠 GUI 서버: 내 PC(127.0.0.1)에서만 열리는 작은 웹 화면.
// 브라우저에서 파라미터를 바꿔 가며 미리보기하고, 폴더 전체 실행까지 함.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./hinchil');


const BASE_PORT = 5177;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const abs = (p) => (p ? path.resolve(__dirname, p) : '');
const isImage = (p) => H.IMAGE_EXT.has(path.extname(p).toLowerCase());

// ---------- 모델 준비 상태 (감지기별) ----------
const models = {};
for (const k of Object.keys(H.DETECTORS)) models[k] = { state: 'idle', msg: '아직 안 불러왔어요' };

// 감지기 하나를 준비(없으면 내려받기). 같은 감지기를 동시에 불러도 한 번만 처리됨
function ensure(key) {
  const st = models[key];
  if (!st) return Promise.reject(new Error('알 수 없는 감지기: ' + key));
  if (st.state !== 'ready') {
    st.state = 'loading';
    st.msg = '모델 준비 중... (처음엔 내려받느라 조금 걸려요)';
  }
  return H.getSession(key).then(
    (r) => {
      st.state = 'ready';
      st.msg = r.warn ? '모델 준비됨 (' + r.warn + ')' : '모델 준비됨';
      return r;
    },
    (e) => {
      st.state = 'error';
      st.msg = e.message;
      throw e;
    }
  );
}
function warmup(keys) {
  for (const k of keys) ensure(k).catch(() => {});
}
function parseDetectors(str, fallback) {
  const list = str ? String(str).split(',').filter(Boolean) : fallback;
  const bad = list.filter((k) => !H.DETECTORS[k]);
  if (bad.length || !list.length) throw new Error('감지기를 하나 이상 골라 주세요');
  return list;
}
function modelOverall(keys) {
  const sts = keys.map((k) => ({ key: k, ...models[k] }));
  const err = sts.find((x) => x.state === 'error');
  if (err) return { state: 'error', msg: err.msg };
  if (sts.some((x) => x.state === 'loading' || x.state === 'idle')) return { state: 'loading', msg: '모델 준비 중...' };
  const warn = sts.find((x) => x.msg && x.msg.includes('('));
  return { state: 'ready', msg: warn ? warn.msg : '모델 준비됨' };
}

// ---------- 일괄 실행 작업 ----------
const job = { state: 'idle', progress: null, log: [], summary: null, error: null, cancel: false };

// 마지막에 쓴 폴더 기억 (설정 저장을 안 눌러도 다음에 켜면 그대로). 캐시 폴더에 둠
const LAST_FILE = path.join(__dirname, '캐시', 'last-folders.json');
function readLast() {
  try {
    const j = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8'));
    return { inputDir: typeof j.inputDir === 'string' ? j.inputDir : '', outputDir: typeof j.outputDir === 'string' ? j.outputDir : '', outInside: j.outInside === true };
  } catch (e) {
    return { inputDir: '', outputDir: '', outInside: false };
  }
}
function writeLast(inputDir, outputDir, outInside) {
  try {
    fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
    fs.writeFileSync(LAST_FILE, JSON.stringify({ inputDir, outputDir, outInside: !!outInside }, null, 2), 'utf8');
  } catch (e) {
    /* 못 써도 동작엔 지장 없음 */
  }
}

// 감지 결과 저장 + 백그라운드 미리 스캔
const scanner = require('./scan')({ H, ensure, isBusy: () => job.state === 'running' });

function startJob(cfg, debug) {
  const reviewed = cfg.skipReviewed ? new Set(scanner.reviewedList(abs(cfg.inputDir))) : null;
  Object.assign(job, { state: 'running', progress: { done: 0, total: 0, hit: 0, none: 0, failed: 0, skipped: 0, current: '' }, log: [], summary: null, error: null, cancel: false });
  H.runBatch(cfg, {
    debug,
    onLog: (s) => {
      job.log.push(s);
      if (job.log.length > 5000) job.log.splice(0, 1000);
    },
    onProgress: (p) => {
      job.progress = p;
    },
    shouldCancel: () => job.cancel,
    skipRel: reviewed && reviewed.size ? (rel) => reviewed.has(rel) : null,
  })
    .then((summary) => {
      job.summary = summary;
      job.state = summary.cancelled ? 'cancelled' : 'done';
    })
    .catch((e) => {
      job.error = e.message;
      job.state = 'error';
    });
}

// ---------- 감지 캐시 / 썸네일 캐시 ----------
const thumbCache = new Map();

function safeJoin(dir, rel) {
  const root = abs(dir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('폴더 밖의 파일은 열 수 없어요');
  if (!isImage(full)) throw new Error('그림 파일이 아니에요');
  return full;
}

// ---------- Windows 도우미 ----------
// 탐색기 모양 폴더 선택창(IFileOpenDialog, 폴더 고르기 모드). 실패하면 예전 기본 선택창으로 대신 열어요.
const PICKER_CS = `
using System;
using System.Runtime.InteropServices;

public static class HinchilFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  class FileOpenDialogRCW { }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close([MarshalAs(UnmanagedType.Error)] int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem ppv);

  // 폴더를 고르면 경로, 취소하면 빈 문자열
  public static string Pick(IntPtr owner, string initial, string title) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts;
    dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20 | 0x40 | 0x8); // PICKFOLDERS | FORCEFILESYSTEM | NOCHANGEDIR
    dlg.SetTitle(title);
    if (!string.IsNullOrEmpty(initial)) {
      try {
        Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
        IShellItem start;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out start);
        dlg.SetFolder(start);
      } catch (Exception) { }
    }
    int hr = dlg.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return ""; // 취소
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShellItem item;
    dlg.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
`;

function pickFolder(initial) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('폴더 선택창은 Windows에서만 지원해요. 경로를 직접 입력해 주세요.'));
    const init = String(initial || '').replace(/'/g, "''");
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" +
      "Add-Type -AssemblyName System.Windows.Forms\n" +
      "$f=New-Object System.Windows.Forms.Form\n" +
      "$f.TopMost=$true; $f.ShowInTaskbar=$false; $f.Opacity=0; $f.StartPosition='CenterScreen'; $f.Show()\n" +
      `$init='${init}'\n` +
      "$res=$null\n" +
      "try {\n" +
      "  Add-Type -TypeDefinition @'\n" + PICKER_CS + "\n'@\n" +
      "  $res=[HinchilFolderPicker]::Pick($f.Handle,$init,'폴더를 고르세요')\n" +
      "} catch {\n" +
      "  $d=New-Object System.Windows.Forms.FolderBrowserDialog\n" +
      "  $d.Description='폴더를 고르세요'\n" +
      "  if(Test-Path -LiteralPath $init){$d.SelectedPath=$init}\n" +
      "  if($d.ShowDialog($f) -eq 'OK'){ $res=$d.SelectedPath } else { $res='' }\n" +
      "}\n" +
      "$f.Close()\n" +
      "if($res){ Write-Output $res }\n";
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell', ['-NoProfile', '-STA', '-EncodedCommand', enc]);
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d.toString('utf8')));
    ps.stderr.on('data', (d) => (err += d.toString('utf8')));
    ps.on('error', reject);
    ps.on('close', () => (out.trim() ? resolve(out.trim()) : err.trim() ? reject(new Error(err.trim().slice(0, 200))) : resolve('')));
  });
}

function openFolder(p) {
  if (process.platform === 'win32') spawn('explorer', [p], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [p], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2e6) {
        reject(new Error('요청이 너무 커요'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('JSON 형식 오류'));
      }
    });
    req.on('error', reject);
  });
}

function pickParams(p) {
  const base = H.readUserConfig();
  const cfg = { ...base };
  for (const k of ['inputDir', 'outputDir', 'recursive', 'mode', 'shape', 'fillColor', 'mosaicSize', 'padding', 'feather', 'threshold', 'detectors', 'parts', 'skipExisting', 'skipReviewed', 'outInside', 'keepMetadata']) {
    if (p && p[k] !== undefined) cfg[k] = p[k];
  }
  return H.validateConfig(cfg);
}

async function handle(req, res, port) {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return sendJson(res, 403, { error: 'forbidden' });
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return sendJson(res, 403, { error: 'forbidden' });
  }
  const q = u.searchParams;

  try {
    // 정적 파일
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'gui.html')));
    }
    if (req.method === 'GET' && u.pathname === '/core.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'core.js')));
    }

    // 설정
    if (req.method === 'GET' && u.pathname === '/api/config') {
      const cfg = H.readUserConfig();
      const last = readLast();
      const lastIn = last.inputDir && fs.existsSync(last.inputDir) ? last.inputDir : '';
      return sendJson(res, 200, {
        cfg,
        inputAbs: cfg.inputDir ? abs(cfg.inputDir) : lastIn,
        outputAbs: cfg.outputDir ? abs(cfg.outputDir) : last.outputDir,
        outInside: cfg.outInside || last.outInside,
        detectorInfo: Object.fromEntries(Object.entries(H.DETECTORS).map(([k, d]) => [k, { name: d.name, file: d.file, url: d.url, page: d.page }])),
        model: modelOverall(cfg.detectors),
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/config') {
      const cfg = pickParams(await readBody(req));
      const keep = {};
      for (const k of ['inputDir', 'outputDir', 'recursive', 'mode', 'shape', 'fillColor', 'mosaicSize', 'padding', 'feather', 'threshold', 'detectors', 'parts', 'skipExisting', 'skipReviewed', 'outInside', 'keepMetadata']) keep[k] = cfg[k];
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(keep, null, 2) + '\n', 'utf8');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/model') {
      const keys = parseDetectors(q.get('det'), H.readUserConfig().detectors);
      return sendJson(res, 200, { ...modelOverall(keys), detectors: Object.fromEntries(keys.map((k) => [k, models[k]])) });
    }
    if (req.method === 'POST' && u.pathname === '/api/model/retry') {
      const body = await readBody(req);
      const keys = parseDetectors((body.det || []).join(','), H.readUserConfig().detectors);
      warmup(keys.filter((k) => models[k].state !== 'loading'));
      return sendJson(res, 200, modelOverall(keys));
    }

    // 폴더
    if (req.method === 'POST' && u.pathname === '/api/pick-folder') {
      const body = await readBody(req);
      const dir = await pickFolder(body.initial ? abs(body.initial) : '');
      return sendJson(res, 200, { dir });
    }
    if (req.method === 'POST' && u.pathname === '/api/open-folder') {
      const body = await readBody(req);
      if (!body.dir) throw new Error('결과 폴더를 먼저 골라 주세요');
      const dir = abs(body.dir);
      fs.mkdirSync(dir, { recursive: true });
      openFolder(dir);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/list') {
      const dir = abs(q.get('dir') || '');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendJson(res, 200, { error: '폴더를 찾을 수 없어요', files: [] });
      const outDir = q.get('out') ? abs(q.get('out')) : null;
      scanner.prune(dir); // 없어진 그림의 저장된 감지 결과 정리
      const files = H.listImages(dir, q.get('recursive') !== '0', outDir).map((f) => path.relative(dir, f));
      return sendJson(res, 200, { files: files.slice(0, 5000), total: files.length });
    }

    // 그림 / 썸네일
    if (req.method === 'GET' && u.pathname === '/api/image') {
      const full = safeJoin(q.get('dir') || '', q.get('rel') || '');
      const st = fs.statSync(full);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      return fs.createReadStream(full).pipe(res);
    }
    if (req.method === 'GET' && u.pathname === '/api/thumb') {
      const full = safeJoin(q.get('dir') || '', q.get('rel') || '');
      const key = full + '|' + fs.statSync(full).mtimeMs;
      let buf = thumbCache.get(key);
      if (!buf) {
        buf = await require('sharp')(full).rotate().resize(120, 120, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
        thumbCache.set(key, buf);
        if (thumbCache.size > 3000) thumbCache.delete(thumbCache.keys().next().value);
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=600' });
      return res.end(buf);
    }

    // 감지 (미리보기용): 낮은 임계값으로 한 번 뽑아 저장해 두고, 임계값/부위 선택은 화면에서 바로 바꿈
    if (req.method === 'GET' && u.pathname === '/api/detect') {
      const dets = parseDetectors(q.get('det'), H.readUserConfig().detectors);
      const full = safeJoin(q.get('dir') || '', q.get('rel') || '');
      const dirAbs = abs(q.get('dir'));
      const r = await scanner.userBusy(() => scanner.detectCached(dirAbs, path.relative(dirAbs, full), dets));
      return sendJson(res, 200, r);
    }

    // 결과 폴더(그림 폴더/output) 만들기. 이름이 output인 폴더만, 절대 경로만 만듦
    if (req.method === 'POST' && u.pathname === '/api/mkdir') {
      const body = await readBody(req);
      const dir = String(body.dir || '');
      if (!path.isAbsolute(dir) || path.basename(dir.replace(/[\\/]+$/, '')) !== 'output') throw new Error('output 폴더만 만들 수 있어요');
      fs.mkdirSync(dir, { recursive: true });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/last') {
      const body = await readBody(req);
      writeLast(String(body.inputDir || ''), String(body.outputDir || ''), body.outInside === true);
      return sendJson(res, 200, { ok: true });
    }

    // 검수 체크
    if (req.method === 'GET' && u.pathname === '/api/review') return sendJson(res, 200, { files: scanner.reviewedList(abs(q.get('dir'))), edits: scanner.reviewedEdits(abs(q.get('dir'))) });
    if (req.method === 'POST' && u.pathname === '/api/review') {
      const body = await readBody(req);
      const full = safeJoin(body.dir || '', body.rel || '');
      const dirAbs = abs(body.dir);
      scanner.setReviewed(dirAbs, path.relative(dirAbs, full), !!body.on, body.edit);
      return sendJson(res, 200, { ok: true });
    }

    // 미리 스캔 (백그라운드)
    if (req.method === 'POST' && u.pathname === '/api/scan/start') {
      const body = await readBody(req);
      const dirAbs = abs(body.dir);
      if (!dirAbs || !fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) throw new Error('폴더를 찾을 수 없어요');
      const keys = parseDetectors(Array.isArray(body.det) ? body.det.join(',') : '', H.readUserConfig().detectors);
      scanner.start({ dirAbs, recursive: body.recursive !== false, outAbs: body.out ? abs(body.out) : null, keys });
      return sendJson(res, 200, scanner.status());
    }
    if (req.method === 'POST' && u.pathname === '/api/scan/stop') {
      scanner.stop();
      return sendJson(res, 200, scanner.status());
    }
    if (req.method === 'GET' && u.pathname === '/api/scan/status') return sendJson(res, 200, scanner.status());
    if (req.method === 'GET' && u.pathname === '/api/scan/results') {
      const keys = parseDetectors(q.get('det'), H.readUserConfig().detectors);
      return sendJson(res, 200, scanner.results(abs(q.get('dir')), keys, Number(q.get('since') || 0)));
    }

    // 이 그림만 저장 (화면에서 고친 박스 그대로)
    if (req.method === 'POST' && u.pathname === '/api/save-one') {
      const body = await readBody(req);
      const cfg = pickParams(body.params);
      if (!(body.dir || cfg.inputDir)) throw new Error('그림 폴더를 먼저 골라 주세요');
      if (!cfg.outputDir) throw new Error('결과 폴더를 먼저 골라 주세요');
      const full = safeJoin(body.dir || cfg.inputDir, body.rel || '');
      const inputAbs = abs(body.dir || cfg.inputDir);
      const outPath = path.join(abs(cfg.outputDir), path.relative(inputAbs, full));
      if (path.resolve(outPath) === path.resolve(full)) throw new Error('입력 폴더와 결과 폴더가 같아요');
      const boxes = (Array.isArray(body.boxes) ? body.boxes : []).map((b) => ({
        x1: Number(b.x1), y1: Number(b.y1), x2: Number(b.x2), y2: Number(b.y2), exact: !!b.exact,
      }));
      if (boxes.some((b) => ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite))) throw new Error('박스 좌표가 이상해요');
      const raw = await H.loadRaw(full);
      await H.censor(raw, boxes, cfg, outPath);
      return sendJson(res, 200, { out: outPath });
    }

    // 폴더 전체 실행
    if (req.method === 'POST' && u.pathname === '/api/run') {
      if (job.state === 'running') throw new Error('이미 실행 중이에요');
      const body = await readBody(req);
      const cfg = pickParams(body.params);
      startJob(cfg, !!body.debug);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/progress') {
      const since = Number(q.get('since') || 0);
      return sendJson(res, 200, {
        state: job.state,
        progress: job.progress,
        summary: job.summary,
        error: job.error,
        logFrom: since,
        log: job.log.slice(since),
        logTotal: job.log.length,
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/cancel') {
      job.cancel = true;
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

function listen(port, tries) {
  const server = http.createServer((req, res) => handle(req, res, port));
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
    else {
      console.error('서버를 열 수 없어요: ' + e.message);
      process.exitCode = 1;
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`흰칠 GUI: ${url}`);
    console.log('이 창을 닫으면 GUI도 꺼져요.');
    console.log('Made by 크랙 크리에이터 넉넉한 취향 (https://share.crack.wrtn.ai/4dihl6) 의 클로드 어시스턴트 서한결 제작');
    if (process.platform === 'win32' && !process.argv.includes('--no-open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    try {
      warmup(H.readUserConfig().detectors);
    } catch (e) {
      console.error('설정 오류: ' + e.message);
    }
  });
}

process.on('exit', () => scanner.flushAll());
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
try {
  scanner.cleanupOrphans();
} catch (e) {
  /* 무시 */
}
listen(BASE_PORT, 10);
