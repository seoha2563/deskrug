"""../index.html 의 러그 코드(WebGL + 천 시뮬레이션)를 꺼내 데스크톱용 renderer.html 을 만든다.
사이트의 러그 로직이 바뀌면 이 스크립트를 다시 실행하면 된다:  python -I make-renderer.py
"""
import re, pathlib

here = pathlib.Path(__file__).parent
src = (here.parent / "index.html").read_text(encoding="utf-8")

m = re.search(r"<script>\n(.*?)</script>\n</body>", src, re.S)
js = m.group(1)

def sub(old, new, count=1):
    global js
    assert old in js, "패턴을 찾지 못함: " + old[:60]
    js = js.replace(old, new, count)

# 1) 사이트 전용 테스트 훅 제거
i = js.index("// 테스트용:")
j = js.index("requestAnimationFrame(frame);", i)
js = js[:i] + js[j:]

# 2) 최대 크기 500, 처음 크기는 설정에서 받는다
sub("Math.min(+$('size').value, 300 * Math.min(1, imgW / imgH))", "Math.min(+$('size').value, 500 * Math.min(1, imgW / imgH))")
sub("if (first) $('size').value = innerWidth < 720 ? Math.max(100, Math.min(300, Math.round(innerWidth * 0.62))) : 300;", "if (first) $('size').value = 300;")

# 3) 쉴 때는 시뮬레이션/그리기를 건너뛴다 (전체화면 투명 창이라 낭비가 큼)
sub("'use strict';\n", """'use strict';
let wakeUntil = 0;
const wake = (ms = 2500) => { wakeUntil = Math.max(wakeUntil, performance.now() + ms); };
""")
sub("function layout(first) {", "function layout(first) {\n  wake();")
sub("function buildCloth() {", "function buildCloth() {\n  wake();")
sub("  uploadCloth();\n\n  gl.viewport", "  uploadCloth();\n  updateShape();\n\n  gl.viewport")
sub("function frame(now) {\n","function frame(now) {\n  if (!grabMode && now > wakeUntil) { last = now; acc = 0; requestAnimationFrame(frame); return; }\n")
sub("cloth.release(); grabMode = null;", "cloth.release(); grabMode = null; wake(3500); savePosSoon();")
js = js.replace("cloth.flatten()", "(cloth.flatten(), wake(3500))")

# 4) 기본 러그 로딩: 시작 시 자동 로딩하지 않고 메인 프로세스의 init 메시지를 기다린다
sub("layout(true);\nloadDefaultRug();\n", "layout(true);\n")

# 5) 데스크톱 연동 코드
desk = r"""
/* ---------------------------------------------------- 데스크톱(Electron) 연동 */
placeInitial = function () { docX = (innerWidth - rugW) / 2; docY = (innerHeight - rugH) / 2; };

function loadRugUrl(url) {
  const img = new Image();
  img.onload = () => {
    setTextureFrom(img); layout(); buildCloth();
    if (!touched) { placeInitial(); syncOrigin(); }
    wake();
  };
  img.onerror = () => deskApi.log('이미지를 읽지 못했습니다');
  img.src = url || DEFAULT_RUG_URL;
}

// 창의 입력 영역을 러그의 바운딩 박스로 한정한다 (setShape). 박스 밖은 클릭이 바탕화면/뒤의 창으로 그대로 통과한다.
let lastShape = '';
function updateShape() {
  if (!cloth) return;
  const P = cloth.pos, A = cloth.alpha;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < cloth.n; i++) {
    if (A[i] < 24) continue;
    const z = P[3 * i + 2], x = P[3 * i] + 0.12 * z, y = P[3 * i + 1] - 0.45 * z;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  let r;
  if (x1 < x0) r = { x: 0, y: 0, width: 1, height: 1 };
  else {
    const m = 56;   // 그림자와 잡기 여유
    const L = Math.max(0, Math.floor(originX + x0 - m)), T = Math.max(0, Math.floor(originY + y0 - m));
    const R = Math.min(innerWidth, Math.ceil(originX + x1 + m)), B = Math.min(innerHeight, Math.ceil(originY + y1 + m));
    r = { x: L, y: T, width: Math.max(1, R - L), height: Math.max(1, B - T) };
  }
  const key = r.x + ',' + r.y + ',' + r.width + ',' + r.height;
  if (key !== lastShape) { lastShape = key; deskApi.setShape(r); }
}

let posTimer = 0;
function savePosSoon() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => { const c = cloth.centroid(); deskApi.savePos(Math.round(docX + c.x), Math.round(docY + c.y)); }, 3600);
}
function setSize(v) { $('size').value = v; layout(); wake(); }

deskApi.onCommand(msg => {
  switch (msg.type) {
    case 'init': {
      const s = msg.settings;
      $('stiff').value = s.stiff; $('bgTol').value = s.tol; $('bgRemove').checked = !!s.bg; $('vTol').textContent = s.tol;
      $('size').value = s.size; layout();
      if (s.pos) {
        touched = true;
        docX = Math.min(Math.max(s.pos.x, 0), innerWidth) - rugW / 2;
        docY = Math.min(Math.max(s.pos.y, 0), innerHeight) - rugH / 2;
        syncOrigin();
      }
      loadRugUrl(msg.image);
      break;
    }
    case 'image': loadRugUrl(msg.url); break;
    case 'size': setSize(msg.value); break;
    case 'stiff': $('stiff').value = msg.value; $('stiff').dispatchEvent(new Event('input')); wake(); break;
    case 'bg': $('bgRemove').checked = msg.on; $('bgTol').value = msg.tol; applyBg(); break;
    case 'flatten': release(); cloth.flatten(); wake(3500); break;
    case 'center': {
      const c = cloth.centroid(); cloth.translate(innerWidth / 2 - (docX + c.x), innerHeight / 2 - (docY + c.y)); wake(); savePosSoon(); break;
    }
  }
});
deskApi.ready();
"""
k = js.rindex("requestAnimationFrame(frame);")   # 파일 맨 끝의 시작 호출 (frame 함수 안의 호출이 아님)
js = js[:k] + desk + js[k:]

# 6) 사이트용 UI 요소는 보이지 않게 두되 id 는 유지한다 (스크립트가 참조)
html = """<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;">
<title>DeskRug</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  #c { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
  body.dragging, body.dragging * { cursor: grabbing !important; }
  body.rug-grab, body.rug-grab * { cursor: grab !important; }
  body.rug-move, body.rug-move * { cursor: move !important; }
  #ui { display: none; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="ui">
  <div id="bar"><button id="btnOpen"></button><span id="vSize"></span><input id="size" type="range" min="100" max="500" value="300"><button id="btnFlat"></button><button id="fab"></button><button id="share"></button></div>
  <div id="panel"><button id="btnClose"></button><button id="btnDefault"></button>
    <input id="bgRemove" type="checkbox"><input id="bgTol" type="range" min="5" max="120" value="40"><span id="vTol"></span>
    <input id="stiff" type="range" min="5" max="90" value="35"><span id="vStiff"></span><input id="moveMode" type="checkbox"></div>
  <input id="file" type="file"><div id="toast"></div><div id="drop"></div>
</div>
<script src="cloth.js"></script>
<script src="rug-default.js"></script>
<script>
""" + js + """</script>
</body>
</html>
"""
(here / "renderer.html").write_text(html, encoding="utf-8")
print("renderer.html 생성:", len(html), "bytes")
