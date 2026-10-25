// 画像素材の読み込み。透過PNGはそのまま描画する（黒背景として扱わない）。
const pad = (n) => String(n).padStart(2, '0');

export const ASSET_PATHS = {
  background: 'assets/background/living_room.png',
  pitcher: Array.from({ length: 12 }, (_, i) => `assets/pitcher/pitcher_${pad(i + 1)}.png`),
  batter: Array.from({ length: 12 }, (_, i) => `assets/batter/batter_${pad(i + 1)}.png`),
  props: Object.fromEntries(
    ['lamp_intact', 'lamp_broken', 'glass_fragments', 'vase_intact', 'vase_broken', 'pingpong_ball'].map((k) => [
      k,
      `assets/props/${k}.png`,
    ]),
  ),
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${src}`));
    img.src = src;
  });
}

export async function loadAssets(onProgress) {
  const list = [
    ['background', ASSET_PATHS.background],
    ...ASSET_PATHS.pitcher.map((p, i) => [`pitcher${i + 1}`, p]),
    ...ASSET_PATHS.batter.map((p, i) => [`batter${i + 1}`, p]),
    ...Object.entries(ASSET_PATHS.props),
  ];
  let done = 0;
  const entries = await Promise.all(
    list.map(async ([key, src]) => {
      const img = await loadImage(src);
      onProgress?.(++done, list.length);
      return [key, img];
    }),
  );
  const m = Object.fromEntries(entries);
  return {
    background: m.background,
    pitcher: Array.from({ length: 12 }, (_, i) => defringe(m[`pitcher${i + 1}`])),
    batter: Array.from({ length: 12 }, (_, i) => defringe(m[`batter${i + 1}`])),
    props: Object.fromEntries(Object.keys(ASSET_PATHS.props).map((k) => [k, m[k]])),
  };
}

/**
 * 切り抜きの縁に残った暗い半透明ピクセルを弱める（色にじみ対策）。
 * 不透明部分はそのまま。キャンバスが使えない環境では元画像を返す。
 */
function defringe(img) {
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a > 0 && a < 255) d[i] = Math.round(255 * (a / 255) ** 1.8);
    }
    ctx.putImageData(data, 0, 0);
    return c;
  } catch {
    return img;
  }
}
