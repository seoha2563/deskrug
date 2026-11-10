const { app, BrowserWindow, Tray, Menu, nativeImage, screen, dialog, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const SELFTEST = process.env.DESKRUG_SELFTEST;           // 자동 점검용 (경로를 주면 스크린샷 저장)
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'deskrug-selftest'));   // 실행 중인 DeskRug와 겹치지 않게 분리
if (!app.requestSingleInstanceLock()) { app.quit(); }
const DEFAULTS = { ver: 3, size: 300, stiff: 70, onTop: false, bg: false, tol: 40, image: null, pos: null, autostart: false, firstRun: true };
let settingsFile, settings = { ...DEFAULTS };
let win, tray, rendererReady = false;

function loadSettings() {
  settingsFile = path.join(SELFTEST ? app.getPath('temp') : app.getPath('userData'), SELFTEST ? 'deskrug-selftest.json' : 'settings.json');
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch (_) {}
  if (settings.ver !== DEFAULTS.ver) { settings.ver = DEFAULTS.ver; settings.stiff = DEFAULTS.stiff; saveSettings(); }   // 기본 뻣뻣함을 바꾼 버전: 한 번만 새 기본값으로
}
let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (_) {}
  }, 200);
}
const send = msg => { if (win && !win.isDestroyed() && rendererReady) win.webContents.send('cmd', msg); };

function imageDataUrl(file) {
  try {
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[ext];
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch (_) { return null; }
}

function createWindow() {
  const b = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, focusable: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setShape([{ x: 0, y: 0, width: 1, height: 1 }]);   // 러그가 정해지기 전에는 입력을 받지 않는다
  applyOnTop();
  win.loadFile(path.join(__dirname, 'renderer.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { win = null; });
}

function applyOnTop() { if (win) win.setAlwaysOnTop(!!settings.onTop, 'floating'); }
function fitToDisplay() { if (win) win.setBounds(screen.getPrimaryDisplay().bounds); }

function pickImage() {
  const r = dialog.showOpenDialogSync({
    title: '러그로 쓸 사진 고르기', properties: ['openFile'],
    filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (!r || !r[0]) return;
  const url = imageDataUrl(r[0]);
  if (!url) { dialog.showErrorBox('DeskRug', '이 파일은 읽을 수 없습니다.'); return; }
  settings.image = r[0]; saveSettings(); send({ type: 'image', url });
}

function buildMenu() {
  const radio = (label, value, key, type) => ({
    label, type: 'radio', checked: settings[key] === value,
    click: () => { settings[key] = value; saveSettings(); send({ type, value }); },
  });
  return Menu.buildFromTemplate([
    { label: '사진 바꾸기…', click: pickImage },
    { label: '기본 러그로 되돌리기', click: () => { settings.image = null; saveSettings(); send({ type: 'image', url: null }); } },
    { type: 'separator' },
    { label: '크기', submenu: [150, 200, 250, 300, 400, 500].map(v => radio(v + 'px', v, 'size', 'size')) },
    { label: '뻣뻣함', submenu: [['부드럽게', 30], ['보통', 50], ['뻣뻣하게', 70], ['아주 뻣뻣하게', 90]].map(([l, v]) => radio(l, v, 'stiff', 'stiff')) },
    { label: '사진 배경 제거', type: 'checkbox', checked: settings.bg, click: m => { settings.bg = m.checked; saveSettings(); send({ type: 'bg', on: settings.bg, tol: settings.tol }); } },
    {
      label: '배경 제거 강도',
      submenu: [['약하게', 20], ['보통', 40], ['강하게', 70], ['아주 강하게', 100]].map(([l, v]) => ({
        label: l, type: 'radio', checked: settings.tol === v,
        click: () => { settings.tol = v; saveSettings(); send({ type: 'bg', on: settings.bg, tol: v }); },
      })),
    },
    { type: 'separator' },
    { label: '러그 펴기', click: () => send({ type: 'flatten' }) },
    { label: '러그를 화면 가운데로', click: () => send({ type: 'center' }) },
    { type: 'separator' },
    { label: '항상 다른 창 위에 표시', type: 'checkbox', checked: settings.onTop, click: m => { settings.onTop = m.checked; saveSettings(); applyOnTop(); } },
    {
      label: 'Windows 시작 시 자동 실행', type: 'checkbox', checked: settings.autostart, enabled: app.isPackaged,
      click: m => { settings.autostart = m.checked; saveSettings(); app.setLoginItemSettings({ openAtLogin: m.checked }); },
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')).resize({ width: 32, height: 32 }));
  tray.setToolTip('DeskRug — 클릭: 메뉴');
  const open = () => tray.popUpContextMenu(buildMenu());
  tray.on('click', open); tray.on('right-click', open);
}

ipcMain.on('set-shape', (_e, r) => {
  if (win && !win.isDestroyed()) win.setShape([{ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }]);
});
ipcMain.on('save-pos', (_e, p) => { settings.pos = p; saveSettings(); });
ipcMain.on('log', (_e, m) => console.log('[renderer]', m));
ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  send({ type: 'init', settings, image: settings.image ? imageDataUrl(settings.image) : null });
  if (settings.firstRun && !SELFTEST) {
    settings.firstRun = false; saveSettings();
    if (Notification.isSupported()) {
      new Notification({ title: 'DeskRug', body: '러그를 바탕화면에 깔았어요. 열려 있는 창을 최소화하면 보여요. 설정은 작업표시줄 오른쪽 아래의 러그 모양 아이콘에서 바꿀 수 있어요.' }).show();
    }
  }
  if (SELFTEST) runSelfTest();
});

// 자동 점검: 모서리를 잡아 접은 뒤 창 화면을 PNG로 저장
async function runSelfTest() {
  const js = code => win.webContents.executeJavaScript(code);
  await new Promise(r => setTimeout(r, 2500));
  await js(`(() => {
    const W = rugW, H = rugH;
    const fire = (t, x, y) => canvas.dispatchEvent(new PointerEvent(t, { clientX: originX + x, clientY: originY + y, button: 0, pointerId: 1, bubbles: true }));
    let best = -1;
    for (let i = 0; i < cloth.n; i++) if (cloth.edge[i] && cloth.alpha[i] >= 128) { if (best < 0 || cloth.pos[3*i] + cloth.pos[3*i+1] > cloth.pos[3*best] + cloth.pos[3*best+1]) best = i; }
    const x0 = cloth.pos[3*best], y0 = cloth.pos[3*best+1], tx = cloth.pos[0] + W * 0.45, ty = cloth.pos[1] + H * 0.45;
    fire('pointerdown', x0, y0);
    for (let i = 1; i <= 40; i++) { fire('pointermove', x0 + (tx - x0) * i / 40, y0 + (ty - y0) * i / 40); for (let j = 0; j < 2; j++) cloth.step(STEP); }
    for (let j = 0; j < 10; j++) cloth.step(STEP);
    fire('pointerup', tx, ty);
    for (let j = 0; j < 150; j++) cloth.step(STEP);
    wake(1500);
  })()`);
  await new Promise(r => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(SELFTEST, img.toPNG());
  console.log('selftest saved', SELFTEST, JSON.stringify(img.getSize()));
  app.quit();
}

app.whenReady().then(() => {
  loadSettings();
  if (SELFTEST) settings.firstRun = false;
  createWindow(); createTray();
  screen.on('display-metrics-changed', fitToDisplay);
  screen.on('display-added', fitToDisplay);
  screen.on('display-removed', fitToDisplay);
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => { if (win) win.showInactive(); });
