// 判定範囲（セーフ4区域・投手守備範囲・電球・手前の障害物）の保持と検証。
// 形状は背景画像の正規化座標 (0〜1)、その形がある「面」はワールド座標で持つ。

export const STORAGE_KEY = 'lrb.zones.v1';

// zones.initial.json に無い補足情報（判定面・電球・障害物）の既定値
const SURFACE_BY_ID = {
  between_curtains: { type: 'backWall' },
  right_door: { type: 'rightWall' },
  calendar: { type: 'backWall' },
  rear_left_cabinet_top: { type: 'depth', z: 4.7 },
};

const DEFAULT_EXTRAS = {
  pitcherCatchZone: { center: [0.56, 0.455], radius: [0.058, 0.097], depthZ: 4.4 },
  lamp: { center: [0.553, 0.093], radius: [0.052, 0.073], depthZ: 3.2 },
  obstacles: [
    {
      id: 'tv',
      label: 'テレビ',
      depthZ: 3.6,
      polygon: [
        [0.166, 0.31],
        [0.342, 0.31],
        [0.342, 0.49],
        [0.166, 0.49],
      ],
    },
    {
      id: 'vase',
      label: '花瓶',
      depthZ: 2.87,
      polygon: [
        [0.121, 0.262],
        [0.159, 0.262],
        [0.159, 0.338],
        [0.121, 0.338],
      ],
    },
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

const isPoint = (p) =>
  Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n));

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** 読み込んだJSONを検証し、足りない項目を既定値で補う。不正なら例外。 */
export function normalizeZones(json) {
  if (!json || !Array.isArray(json.safeZones)) throw new Error('safeZones がありません');
  const safeZones = json.safeZones.map((z, i) => {
    if (!z.polygon || z.polygon.length < 3 || !z.polygon.every(isPoint)) {
      throw new Error(`safeZones[${i}] のポリゴンが不正です`);
    }
    const id = String(z.id ?? `zone_${i}`);
    return {
      id,
      label: String(z.label ?? id),
      polygon: z.polygon.map(([x, y]) => [clamp01(x), clamp01(y)]),
      surface: clone(z.surface ?? SURFACE_BY_ID[id] ?? { type: 'backWall' }),
    };
  });
  const pz = json.pitcherCatchZone ?? {};
  const lamp = json.lamp ?? {};
  const ellipse = (src, def) => ({
    center: isPoint(src.center) ? [...src.center] : [...def.center],
    radius: isPoint(src.radius) ? src.radius.map((r) => Math.max(0.005, r)) : [...def.radius],
    depthZ: typeof src.depthZ === 'number' ? src.depthZ : def.depthZ,
  });
  const obstacles = Array.isArray(json.obstacles)
    ? json.obstacles
        .filter((o) => o && o.polygon && o.polygon.length >= 3 && o.polygon.every(isPoint))
        .map((o) => ({ id: String(o.id), label: String(o.label ?? o.id), depthZ: Number(o.depthZ), polygon: clone(o.polygon) }))
    : clone(DEFAULT_EXTRAS.obstacles);
  return {
    version: 1,
    coordinateSystem: 'normalized image coordinates, x right, y down; reference background 1536x1024',
    safeZones,
    pitcherCatchZone: { ...ellipse(pz, DEFAULT_EXTRAS.pitcherCatchZone), priority: 'out overrides safe' },
    lamp: ellipse(lamp, DEFAULT_EXTRAS.lamp),
    obstacles,
    defaultResult: 'out',
  };
}

/**
 * 点がポリゴン内か。境界上（縁）はセーフ側＝内側として扱う。
 */
export function pointInPolygon(pt, poly, eps = 1e-9) {
  const [x, y] = pt;
  // 縁の上なら内側
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distToSegment(pt, poly[j], poly[i]) <= eps) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 楕円内（縁を含む）か */
export function pointInEllipse([x, y], { center, radius }) {
  const dx = (x - center[0]) / radius[0];
  const dy = (y - center[1]) / radius[1];
  return dx * dx + dy * dy <= 1 + 1e-9;
}

export function loadSavedZones(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? normalizeZones(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveZones(zones, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(zones));
    return true;
  } catch {
    return false;
  }
}

export function clearSavedZones(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* 保存領域が使えない環境では何もしない */
  }
}
