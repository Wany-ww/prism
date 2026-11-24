export default function Sparkline({ data, color = 'var(--blue)', width = 84, height = 34 }: { data: number[]; color?: string; width?: number; height?: number }) {
  if (!data.length || data.every((v) => v === 0)) {
    return (
      <svg width={width} height={height} aria-hidden>
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke="var(--text-4)" strokeDasharray="2 3" />
      </svg>
    );
  }
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => `${(i / Math.max(1, data.length - 1)) * width},${height - 3 - ((v - min) / (max - min || 1)) * (height - 6)}`);
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
