import { useEffect, useState } from 'react';

export type RecentKind = 'match' | 'analysis' | 'dashboard' | 'parser';
export type Recent = { key: string; label: string; path: string; kind: RecentKind };

const KEY = 'prism.recent';
const EVT = 'prism-recent';

function read(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
function write(list: Recent[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* storage unavailable: 최근 본 목록은 편의 기능이므로 무시 */
  }
  window.dispatchEvent(new Event(EVT));
}

export function pushRecent(item: Recent) {
  write([item, ...read().filter((r) => r.key !== item.key)]);
}
export function removeRecent(key: string) {
  write(read().filter((r) => r.key !== key));
}

export function useRecentList() {
  const [list, setList] = useState<Recent[]>(read);
  useEffect(() => {
    const h = () => setList(read());
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, []);
  return list;
}

export function useTrackRecent(item: Recent | null) {
  useEffect(() => {
    if (item) pushRecent(item);
  }, [item?.key, item?.label]);
}
