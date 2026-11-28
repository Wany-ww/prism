// 더블클릭 피드백: 더블클릭으로 여는 항목(표 행, 카드, Flow 노드 등)에 짧은 강조를 한 번 보여 준다.
// CSS 만으로는 더블클릭을 구분할 수 없어 전역 리스너 하나로 처리한다 (애니메이션은 styles.css 의 .dbl-pulse).
const TARGETS = '.ant-table-row, .op-card, .tile-click, .list-item, .parser-row, .palette-card, .agent-hist, [data-dbl]';

export function installMotion() {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  document.addEventListener(
    'dblclick',
    (ev) => {
      if (reduce?.matches) return;
      const el = (ev.target as Element | null)?.closest?.(TARGETS);
      if (!el) return;
      // 연속 더블클릭에도 다시 재생되도록: 떼고 → 레이아웃을 한 번 계산시킨 뒤 → 다시 붙임
      el.classList.remove('dbl-pulse');
      void (el as HTMLElement).offsetWidth;
      el.classList.add('dbl-pulse');
      window.clearTimeout((el as any).__dblTimer);
      (el as any).__dblTimer = window.setTimeout(() => el.classList.remove('dbl-pulse'), 750);
    },
    true,
  );
}
