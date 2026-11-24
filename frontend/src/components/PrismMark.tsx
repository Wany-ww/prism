/** PRISM 로고: 흰 빛이 프리즘을 지나 여러 색으로 갈라짐 (public/favicon.svg 와 같은 도형) */
export default function PrismMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#191f28" />
      <path d="M2.5 18.2 L10.9 16" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M10.9 16 L21.3 16" stroke="#fff" strokeOpacity=".55" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 5.5 L26.4 25.5 H5.6 Z" fill="#fff" fillOpacity=".16" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      <path d="M21.3 16 L29.5 11.2" stroke="#f04452" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M21.3 16 L29.5 16" stroke="#ffc342" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M21.3 16 L29.5 20.8" stroke="#4c9bff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
