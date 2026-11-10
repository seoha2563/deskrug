/* Desk Rug - 천 시뮬레이션 (Position Based Dynamics)
 * 좌표계: 러그 로컬 px. x 오른쪽, y 아래쪽, z 화면 쪽(위). 바닥은 z = 0.
 * 화면 투영은 screen = (x + 0.12 z, y - 0.45 z) 로 약한 사선 시점을 흉내낸다.
 */
(function (root) {
  'use strict';
  const OBL_X = 0.12, OBL_Y = -0.45;

  class Cloth {
    constructor(W, H, opts = {}) {
      this.W = W; this.H = H;
      const cell = Math.max(opts.cell || 8, W / 90);
      const nx = this.nx = Math.max(6, Math.round(W / cell) + 1);
      const ny = this.ny = Math.max(6, Math.round(H / cell) + 1);
      const n = this.n = nx * ny;
      this.hx = W / (nx - 1); this.hy = H / (ny - 1);
      const h = this.h = (this.hx + this.hy) / 2;
      this.d = Math.min(0.8 * h, 6.5);                  // 겹친 천 사이의 최소 간격(두께)

      this.pos = new Float32Array(n * 3);
      this.prev = new Float32Array(n * 3);
      this.start = new Float32Array(n * 3);
      this.nrm = new Float32Array(n * 3);
      this.ao = new Float32Array(n);
      this.inv = new Float32Array(n).fill(1);
      this.gi = new Int16Array(n); this.gj = new Int16Array(n);
      this.edge = new Uint8Array(n);                    // 1이면 가장자리(들어서 접는 곳)
      this.alpha = new Uint8Array(n).fill(255);
      this.contact = new Uint8Array(n);
      for (let j = 0, k = 0; j < ny; j++) for (let i = 0; i < nx; i++, k++) { this.gi[k] = i; this.gj[k] = j; }

      this.gravity = opts.gravity || 3200;
      this.floorMu = 0.22;                              // 바닥 마찰 (한 서브스텝당 이동량 감쇠)
      this.contactMu = 0.30;                            // 천끼리 마찰
      this.iters = opts.iters || 8; this.substeps = opts.substeps || 2;
      this._buildConstraints(opts.bend == null ? 0.35 : opts.bend);

      this.hsize = 8192;
      this.head = new Int32Array(this.hsize);
      this.next = new Int32Array(n);
      this.grabInfo = null;
      this.reset(0, 0);
    }

    _buildConstraints(bend) {
      const { nx, ny, hx, hy } = this;
      const A = [], B = [], R = [], K = [], T = [];
      const add = (i0, j0, i1, j1, k, type) => {
        if (i0 < 0 || i0 >= nx || j0 < 0 || j0 >= ny || i1 < 0 || i1 >= nx || j1 < 0 || j1 >= ny) return;
        A.push(j0 * nx + i0); B.push(j1 * nx + i1);
        R.push(Math.hypot((i1 - i0) * hx, (j1 - j0) * hy)); K.push(k); T.push(type);
      };
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        add(i, j, i + 1, j, 1.0, 0); add(i, j, i, j + 1, 1.0, 0);          // 구조(stretch)
        add(i, j, i + 1, j + 1, 0.7, 1); add(i + 1, j, i, j + 1, 0.7, 1);  // 전단(shear) — 대각선 둘 다
        add(i, j, i + 2, j, bend, 2); add(i, j, i, j + 2, bend, 2);        // 굽힘(bend)
      }
      this.nc = A.length;
      this.ca = Int32Array.from(A); this.cb = Int32Array.from(B);
      this.cr = Float32Array.from(R); this.ck = Float32Array.from(K); this.ct = Uint8Array.from(T);
    }

    setBend(k) { for (let c = 0; c < this.nc; c++) if (this.ct[c] === 2) this.ck[c] = k; }

    // 평평한 상태로 (왼쪽 위가 ox,oy)
    reset(ox, oy) {
      const { n, nx, pos, prev, hx, hy } = this;
      for (let k = 0; k < n; k++) {
        pos[3 * k] = ox + this.gi[k] * hx; pos[3 * k + 1] = oy + this.gj[k] * hy;
        pos[3 * k + 2] = Math.random() * 0.15;          // 압축 시 위로 휘어지게 하는 미세한 비대칭
      }
      prev.set(pos); this.inv.fill(1); this.ao.fill(0); this.grabInfo = null;
    }
    centroid() {
      let sx = 0, sy = 0; for (let k = 0; k < this.n; k++) { sx += this.pos[3 * k]; sy += this.pos[3 * k + 1]; }
      return { x: sx / this.n, y: sy / this.n };
    }
    flatten() { const c = this.centroid(); this.reset(c.x - this.W / 2, c.y - this.H / 2); }

    // 이미지 알파(u,v -> 0..255)로 불투명 여부와 '가장자리' 입자를 계산
    setAlphaFn(fn) {
      const band = 0.2 * Math.min(this.W, this.H);
      for (let k = 0; k < this.n; k++) {
        const u = this.gi[k] / (this.nx - 1), v = this.gj[k] / (this.ny - 1);
        this.alpha[k] = fn(u, v);
        let edge = 0;
        for (let a = 0; a < 16 && !edge; a++) {
          const ang = a / 16 * Math.PI * 2;
          for (const rr of [0.5, 1.0]) {
            const uu = u + Math.cos(ang) * band * rr / this.W, vv = v + Math.sin(ang) * band * rr / this.H;
            if (uu < 0 || uu > 1 || vv < 0 || vv > 1 || fn(uu, vv) < 24) { edge = 1; break; }
          }
        }
        this.edge[k] = edge;
      }
    }

    // 화면 좌표(러그 로컬 px)에서 가장 위에 있는 불투명 입자를 고른다
    pick(sx, sy, extra = 0) {
      const { pos, n } = this; const R = 12 + this.h * 0.8 + extra; let best = -1, bz = -1e9;
      for (let k = 0; k < n; k++) {
        if (this.alpha[k] < 24) continue;
        const z = pos[3 * k + 2];
        const dx = pos[3 * k] + OBL_X * z - sx, dy = pos[3 * k + 1] + OBL_Y * z - sy;
        if (dx * dx + dy * dy > R * R) continue;
        if (z > bz + 0.5 * this.d) { bz = z; best = k; }
      }
      return best;
    }

    grab(idx, sx, sy, lift, radiusCells) {
      const { pos } = this; const r = radiusCells * this.h;
      const list = [], ox = [], oy = [], z0 = [];
      const cx = pos[3 * idx], cy = pos[3 * idx + 1];
      for (let k = 0; k < this.n; k++) {
        const ddx = (this.gi[k] - this.gi[idx]) * this.hx, ddy = (this.gj[k] - this.gj[idx]) * this.hy;
        if (ddx * ddx + ddy * ddy > r * r) continue;
        list.push(k); ox.push(pos[3 * k] - cx); oy.push(pos[3 * k + 1] - cy); z0.push(pos[3 * k + 2]); this.inv[k] = 0;
      }
      this.grabInfo = { list, ox, oy, z0, cx, cy, sx, sy, px: sx, py: sy, lift: 0, liftT: lift };
    }
    dragTo(px, py) { if (this.grabInfo) { this.grabInfo.px = px; this.grabInfo.py = py; } }
    release() {
      const g = this.grabInfo; if (!g) return;
      for (const k of g.list) { this.inv[k] = 1; for (let c = 0; c < 3; c++) this.prev[3 * k + c] = this.pos[3 * k + c]; }
      this.grabInfo = null;
    }
    translate(dx, dy) {
      for (let k = 0; k < this.n; k++) for (const A of [this.pos, this.prev]) { A[3 * k] += dx; A[3 * k + 1] += dy; }
    }

    step(dt) {
      const sub = this.substeps, h = dt / sub;
      for (let s = 0; s < sub; s++) this._substep(h, s === sub - 1);
    }

    _substep(h, last) {
      const { n, pos, prev, start, inv } = this;
      const g = this.gravity * h * h, damp = 0.999;
      start.set(pos);
      for (let k = 0, k3 = 0; k < n; k++, k3 += 3) {
        if (inv[k] === 0) continue;
        const vx = (pos[k3] - prev[k3]) * damp, vy = (pos[k3 + 1] - prev[k3 + 1]) * damp, vz = (pos[k3 + 2] - prev[k3 + 2]) * damp;
        prev[k3] = pos[k3]; prev[k3 + 1] = pos[k3 + 1]; prev[k3 + 2] = pos[k3 + 2];
        pos[k3] += vx; pos[k3 + 1] += vy; pos[k3 + 2] += vz - g;
      }
      // 잡고 있는 입자: 포인터를 부드럽게 따라가게 고정
      const gr = this.grabInfo;
      if (gr) {
        gr.lift += (gr.liftT - gr.lift) * Math.min(1, 14 * h);
        const pz = gr.lift;
        const tx = gr.cx + (gr.px - gr.sx) - OBL_X * pz, ty = gr.cy + (gr.py - gr.sy) - OBL_Y * pz;
        for (let a = 0; a < gr.list.length; a++) {
          const k = gr.list[a], k3 = 3 * k;
          pos[k3] += (tx + gr.ox[a] - pos[k3]) * 0.45;
          pos[k3 + 1] += (ty + gr.oy[a] - pos[k3 + 1]) * 0.45;
          pos[k3 + 2] += (gr.z0[a] + pz - pos[k3 + 2]) * 0.45;
          prev[k3] = pos[k3]; prev[k3 + 1] = pos[k3 + 1]; prev[k3 + 2] = pos[k3 + 2];
        }
      }
      this.contact.fill(0);
      if (last) this.ao.fill(0);
      for (let it = 0; it < this.iters; it++) {
        this._constraints();
        if (it === this.iters - 2) this._collide(last);
        for (let k = 0; k < n; k++) if (inv[k] !== 0 && pos[3 * k + 2] < 0) pos[3 * k + 2] = 0;   // 바닥
      }
      // 마찰: 바닥/다른 천에 닿은 입자는 가로 이동을 줄인다
      for (let k = 0, k3 = 0; k < n; k++, k3 += 3) {
        if (inv[k] === 0) continue;
        let mu = 0;
        if (pos[k3 + 2] < 0.6) mu = this.floorMu;
        if (this.contact[k]) mu = Math.max(mu, this.contactMu);
        if (mu > 0) { pos[k3] = start[k3] + (pos[k3] - start[k3]) * (1 - mu); pos[k3 + 1] = start[k3 + 1] + (pos[k3 + 1] - start[k3 + 1]) * (1 - mu); }
      }
    }

    _constraints() {
      const { pos, inv, ca, cb, cr, ck } = this;
      for (let c = 0, nc = this.nc; c < nc; c++) {
        const a = ca[c], b = cb[c], wa = inv[a], wb = inv[b], w = wa + wb;
        if (w === 0) continue;
        const a3 = 3 * a, b3 = 3 * b;
        const dx = pos[b3] - pos[a3], dy = pos[b3 + 1] - pos[a3 + 1], dz = pos[b3 + 2] - pos[a3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) continue;
        const f = (len - cr[c]) / len * ck[c] / w;
        pos[a3] += dx * f * wa; pos[a3 + 1] += dy * f * wa; pos[a3 + 2] += dz * f * wa;
        pos[b3] -= dx * f * wb; pos[b3 + 1] -= dy * f * wb; pos[b3 + 2] -= dz * f * wb;
      }
    }

    // 천끼리 뚫지 않게: 공간 해시로 가까운 입자쌍을 d 이상 떨어뜨린다
    _collide(doAO) {
      const { n, pos, inv, head, next, gi, gj, d } = this;
      const cs = d * 1.8, mask = this.hsize - 1, inc = 1 / cs;
      head.fill(-1);
      for (let k = 0; k < n; k++) {
        const key = (Math.imul(Math.floor(pos[3 * k] * inc), 73856093) ^ Math.imul(Math.floor(pos[3 * k + 1] * inc), 19349663)) & mask;
        next[k] = head[key]; head[key] = k;
      }
      const lim2 = cs * cs;
      for (let a = 0; a < n; a++) {
        const a3 = 3 * a, cx = Math.floor(pos[a3] * inc), cy = Math.floor(pos[a3 + 1] * inc);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const key = (Math.imul(cx + ox, 73856093) ^ Math.imul(cy + oy, 19349663)) & mask;
          for (let b = head[key]; b !== -1; b = next[b]) {
            if (b <= a) continue;
            if (Math.abs(gi[a] - gi[b]) <= 2 && Math.abs(gj[a] - gj[b]) <= 2) continue;   // 이웃은 제약이 담당
            const b3 = 3 * b;
            let dx = pos[a3] - pos[b3], dy = pos[a3 + 1] - pos[b3 + 1], dz = pos[a3 + 2] - pos[b3 + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= lim2) continue;
            const dist = Math.sqrt(d2);
            if (doAO) {
              const wgt = 1 - dist / cs;
              if (dz < -0.3 * d) this.ao[a] += wgt; else if (dz > 0.3 * d) this.ao[b] += wgt;
            }
            if (dist >= d) continue;
            if (dist < 1e-5) { dx = 0; dy = 0; dz = 1; } else { dx /= dist; dy /= dist; dz /= dist; }
            const wa = inv[a], wb = inv[b], w = wa + wb; if (w === 0) continue;
            const corr = (d - dist) / w;
            pos[a3] += dx * corr * wa; pos[a3 + 1] += dy * corr * wa; pos[a3 + 2] += dz * corr * wa;
            pos[b3] -= dx * corr * wb; pos[b3 + 1] -= dy * corr * wb; pos[b3 + 2] -= dz * corr * wb;
            this.contact[a] = 1; this.contact[b] = 1;
          }
        }
      }
    }

    // 렌더링용 법선 (격자 중앙차분) 계산
    computeNormals() {
      const { nx, ny, pos, nrm } = this;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const il = Math.max(i - 1, 0), ir = Math.min(i + 1, nx - 1), ju = Math.max(j - 1, 0), jd = Math.min(j + 1, ny - 1);
        const L = 3 * (j * nx + il), R = 3 * (j * nx + ir), U = 3 * (ju * nx + i), D = 3 * (jd * nx + i);
        const ax = pos[R] - pos[L], ay = pos[R + 1] - pos[L + 1], az = pos[R + 2] - pos[L + 2];
        const bx = pos[D] - pos[U], by = pos[D + 1] - pos[U + 1], bz = pos[D + 2] - pos[U + 2];
        let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        const l = Math.hypot(cx, cy, cz) || 1; const o = 3 * (j * nx + i);
        nrm[o] = cx / l; nrm[o + 1] = cy / l; nrm[o + 2] = cz / l;
      }
      return nrm;
    }
  }
  Cloth.OBL_X = OBL_X; Cloth.OBL_Y = OBL_Y;
  if (typeof module !== 'undefined' && module.exports) module.exports = Cloth; else root.Cloth = Cloth;
})(typeof self !== 'undefined' ? self : this);
