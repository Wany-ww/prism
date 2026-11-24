import { ConfigProvider, theme as antdTheme, ThemeConfig } from 'antd';
import koKR from 'antd/locale/ko_KR';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

export type Mode = 'light' | 'dark';

const FONT = '"Pretendard Variable", Pretendard, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif';

// 토스증권 데스크탑 톤: 토스 블루, 상승 빨강 / 하락 파랑, 회색 계열 텍스트
const common: ThemeConfig['token'] = {
  colorPrimary: '#3182f6',
  colorInfo: '#3182f6',
  colorError: '#f04452',
  colorSuccess: '#03b26c',
  colorWarning: '#fe9800',
  colorLink: '#3182f6',
  fontFamily: FONT,
  fontSize: 14,
  borderRadius: 10,
  borderRadiusLG: 16,
  borderRadiusSM: 8,
  controlHeight: 38,
  wireframe: false,
  motionDurationMid: '0.15s',
};

const light: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...common,
    colorText: '#191f28',
    colorTextSecondary: '#4e5968',
    colorTextTertiary: '#8b95a1',
    colorTextQuaternary: '#b0b8c1',
    colorBorder: '#e5e8eb',
    colorBorderSecondary: '#f2f4f6',
    colorBgLayout: '#f2f4f6',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorFillSecondary: '#f2f4f6',
    colorFillTertiary: '#f9fafb',
    colorFillQuaternary: '#f9fafb',
    boxShadowSecondary: '0 8px 24px rgba(2, 32, 71, 0.10)',
  },
};

const dark: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...common,
    colorText: '#e4e4e5',
    colorTextSecondary: '#9e9ea4',
    colorTextTertiary: '#7e7e87',
    colorTextQuaternary: '#5e5e66',
    colorBorder: '#3c3c47',
    colorBorderSecondary: '#2c2c35',
    colorBgBase: '#17171c',
    colorBgLayout: '#101013',
    colorBgContainer: '#202027',
    colorBgElevated: '#2c2c35',
    colorFillSecondary: '#2c2c35',
    colorFillTertiary: '#26262e',
    colorFillQuaternary: '#26262e',
    boxShadowSecondary: '0 8px 24px rgba(0, 0, 0, 0.45)',
  },
};

const components = (m: Mode): ThemeConfig['components'] => ({
  Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', fontWeight: 600, defaultBorderColor: m === 'light' ? '#e5e8eb' : '#3c3c47' },
  Table: {
    headerBg: 'transparent',
    headerColor: m === 'light' ? '#8b95a1' : '#7e7e87',
    headerSplitColor: 'transparent',
    headerSortActiveBg: 'transparent',
    headerSortHoverBg: 'transparent',
    rowHoverBg: m === 'light' ? '#f9fafb' : '#26262e',
    borderColor: m === 'light' ? '#f2f4f6' : '#2c2c35',
    cellPaddingBlock: 14,
    cellPaddingBlockSM: 10,
    bodySortBg: 'transparent',
    fixedHeaderSortActiveBg: 'transparent',
  },
  Tabs: { itemColor: m === 'light' ? '#8b95a1' : '#7e7e87', itemSelectedColor: m === 'light' ? '#191f28' : '#ffffff', inkBarColor: m === 'light' ? '#191f28' : '#ffffff', titleFontSize: 15 },
  Card: { headerFontSize: 16 },
  Modal: { borderRadiusLG: 20, titleFontSize: 18 },
  Drawer: { borderRadiusLG: 20 },
  Segmented: { itemSelectedBg: m === 'light' ? '#ffffff' : '#3c3c47', trackBg: m === 'light' ? '#f2f4f6' : '#2c2c35', trackPadding: 3 },
  Select: { optionSelectedBg: m === 'light' ? '#e8f3ff' : 'rgba(49,130,246,0.18)' },
  Tag: { defaultBg: m === 'light' ? '#f2f4f6' : '#2c2c35' },
});

type Ctx = { mode: Mode; toggle: () => void };
const ThemeCtx = createContext<Ctx>({ mode: 'light', toggle: () => undefined });
export const useTheme = () => useContext(ThemeCtx);

function initialMode(): Mode {
  try {
    const v = localStorage.getItem('prism.theme');
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem('prism.theme', mode);
    } catch {
      /* ignore */
    }
  }, [mode]);
  const cfg = mode === 'dark' ? dark : light;
  return (
    <ThemeCtx.Provider value={{ mode, toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')) }}>
      <ConfigProvider locale={koKR} theme={{ ...cfg, components: components(mode) }}>
        {children}
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}
