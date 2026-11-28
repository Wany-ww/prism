/**
 * 차트 배경 이미지 (예: 제품 도면, 지그·트레이 사진 위에 측정 위치를 겹쳐 보기).
 *
 * - percent: 차트 영역 기준 % 좌표. 왼쪽 위가 (0,0), 오른쪽 아래가 (100,100). 모든 차트 종류에서 동작.
 * - axis:    축 값 기준 좌표. 이미지의 왼쪽 아래 모서리를 (X, Y) 에 두고 축 단위로 가로·세로 크기를 정함.
 *            확대/축소·크기 변경에도 데이터와 같이 움직임. 숫자 X·Y 축이 있는 차트(산점도, XY 위치)만.
 *
 * 이미지는 대시보드 정의(layout JSON) 안에 data URL 로 저장한다 — 내보내기/가져오기 파일 하나로 그대로 옮겨짐.
 */

import type { CSSProperties } from 'react';

export type BgUnit = 'percent' | 'axis';
export type ChartBackground = {
  src: string;
  name?: string;
  /** 원본(저장된) 이미지 픽셀 크기 — 비율 유지 계산용 */
  iw?: number;
  ih?: number;
  /** 0~1 */
  opacity?: number;
  unit?: BgUnit;
  x?: number | null;
  y?: number | null;
  w?: number | null;
  h?: number | null;
  /** 가로 크기에 맞춰 세로를 원본 비율로 */
  keepAspect?: boolean;
};

/** 축 값 좌표를 쓸 수 있는 차트 종류 (X·Y 가 모두 숫자 축) */
export const AXIS_BG_KINDS = ['scatter', 'xy'];

export const BG_DEFAULTS = { opacity: 0.35, unit: 'percent' as BgUnit, x: 0, y: 0, w: 100, h: 100, keepAspect: false };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 실제로 적용되는 좌표 방식 (축 좌표를 못 쓰는 차트면 % 로) */
export function bgUnit(bg: ChartBackground, kind: string): BgUnit {
  return bg.unit === 'axis' && AXIS_BG_KINDS.includes(kind) ? 'axis' : 'percent';
}

/** 세로 크기: 비율 유지면 가로 × 원본 세로/가로 */
export function bgHeight(bg: ChartBackground): number | null {
  if (bg.keepAspect && finite(bg.w) && bg.iw && bg.ih) return (bg.w * bg.ih) / bg.iw;
  return finite(bg.h) ? bg.h : null;
}

/** 축 좌표 모드의 이미지 영역 [x0, y0, x1, y1] (설정이 덜 됐으면 null) */
export function bgAxisBox(bg: ChartBackground | undefined, kind: string): [number, number, number, number] | null {
  if (!bg?.src || bgUnit(bg, kind) !== 'axis') return null;
  const h = bgHeight(bg);
  if (!finite(bg.x) || !finite(bg.y) || !finite(bg.w) || h === null || bg.w <= 0 || h <= 0) return null;
  return [bg.x, bg.y, bg.x + bg.w, bg.y + h];
}

/** ECharts 옵션에 축 좌표 배경 이미지를 맨 아래 레이어로 추가 */
export function addAxisBackground(option: any, bg: ChartBackground | undefined, kind: string): any {
  const box = bgAxisBox(bg, kind);
  if (!box || !option || option.xAxis?.type !== 'value' || option.yAxis?.type !== 'value') return option;
  const series: any[] = option.series ?? [];
  // 범례에 배경 이미지 항목이 생기지 않도록 범례 항목을 기존 시리즈 이름으로 고정
  const legend = option.legend?.show && !option.legend.data ? { ...option.legend, data: [...new Set(series.map((s) => s.name).filter(Boolean))] } : option.legend;
  const opacity = bg!.opacity ?? BG_DEFAULTS.opacity;
  const src = bg!.src;
  return {
    ...option,
    legend,
    series: [
      {
        type: 'custom',
        name: '__background',
        silent: true,
        clip: true,
        z: -10,
        tooltip: { show: false },
        data: [box],
        encode: { x: [0, 2], y: [1, 3] },
        renderItem: (_: unknown, api: any) => {
          const a = api.coord([api.value(0), api.value(1)]);
          const b = api.coord([api.value(2), api.value(3)]);
          return {
            type: 'image',
            silent: true,
            style: { image: src, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), opacity },
          };
        },
      },
      ...series,
    ],
  };
}

/** % 모드: 차트 뒤에 깔 <img> 스타일 */
export function bgPercentStyle(bg: ChartBackground): CSSProperties {
  const h = bg.keepAspect ? null : bgHeight(bg);
  return {
    position: 'absolute',
    left: `${bg.x ?? 0}%`,
    top: `${bg.y ?? 0}%`,
    width: `${bg.w ?? 100}%`,
    height: h === null ? 'auto' : `${h}%`,
    opacity: bg.opacity ?? BG_DEFAULTS.opacity,
    pointerEvents: 'none',
    userSelect: 'none',
    zIndex: 0,
  };
}

const MAX_SIDE = 2000;
const KEEP_BYTES = 1_500_000;

/** 고른 이미지 파일을 data URL 로. 크거나 무거우면 긴 변 2000px 로 줄여 WebP 로 다시 저장 (투명도 유지) */
export async function readImageFile(file: File): Promise<Pick<ChartBackground, 'src' | 'name' | 'iw' | 'ih'>> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (PNG, JPG, SVG, WebP …).');
  const url = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((ok, fail) => {
    const el = new Image();
    el.onload = () => ok(el);
    el.onerror = () => fail(new Error('This image could not be opened.'));
    el.src = url;
  });
  const iw = img.naturalWidth || 1000;
  const ih = img.naturalHeight || 1000;
  if (file.type === 'image/svg+xml' || (file.size <= KEEP_BYTES && Math.max(iw, ih) <= MAX_SIDE)) return { src: url, name: file.name, iw, ih };
  const s = Math.min(1, MAX_SIDE / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.round(iw * s);
  c.height = Math.round(ih * s);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return { src: c.toDataURL('image/webp', 0.88), name: file.name, iw: c.width, ih: c.height };
}

/** data URL 의 대략적인 크기 (바이트) */
export const dataUrlBytes = (src: string) => Math.round(((src.length - src.indexOf(',') - 1) * 3) / 4);
