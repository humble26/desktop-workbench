'use strict';

// 生成桌面工作台图标：暗色圆角底 + 2x2 彩色瓷砖，多尺寸并存为 .ico
const { PNG } = require('pngjs');
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const MASTER = 768;
const SIZES = [256, 128, 64, 48, 32, 16];

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

const BG = [35, 34, 32];
const TILES = [
  { x: 160, y: 160, c: hex('#6f8f6a') },
  { x: 402, y: 160, c: hex('#5f7a99') },
  { x: 160, y: 402, c: hex('#bd8a4e') },
  { x: 402, y: 402, c: hex('#b5715a') }
];
const TILE = 206;
const TILE_R = 46;
const BG_R = 168;

// 标准圆角矩形 SDF（<=0 为内部）
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function renderMaster() {
  const png = new PNG({ width: MASTER, height: MASTER });
  for (let y = 0; y < MASTER; y++) {
    for (let x = 0; x < MASTER; x++) {
      const i = (y * MASTER + x) * 4;
      // 背景：圆角方形
      const cx = MASTER / 2;
      const insideBg = sdRoundRect(x + 0.5, y + 0.5, cx, cx, cx, cx, BG_R) <= 0;
      if (!insideBg) {
        png.data[i] = png.data[i + 1] = png.data[i + 2] = png.data[i + 3] = 0;
        continue;
      }
      let c = BG;
      for (const t of TILES) {
        const hw = TILE / 2;
        if (sdRoundRect(x + 0.5, y + 0.5, t.x + hw, t.y + hw, hw, hw, TILE_R) <= 0) {
          c = t.c;
          break;
        }
      }
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  return png;
}

function downsample(src, size) {
  const f = MASTER / size;
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = 0; yy < f; yy++) {
        for (let xx = 0; xx < f; xx++) {
          const idx = (((y * f + yy) * MASTER) + (x * f + xx)) * 4;
          r += src.data[idx];
          g += src.data[idx + 1];
          b += src.data[idx + 2];
          a += src.data[idx + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

async function main() {
  const buildDir = path.join(__dirname, '..', 'build');
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

  const master = renderMaster();
  const png256 = downsample(master, 256);
  const png256Buf = PNG.sync.write(png256);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), png256Buf);

  const buffers = SIZES.map(s => {
    const p = downsample(master, s);
    return PNG.sync.write(p);
  });
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

  console.log('icon.ico + icon.png generated (sizes: ' + SIZES.join(',') + ')');
}

main().catch(e => { console.error(e); process.exit(1); });