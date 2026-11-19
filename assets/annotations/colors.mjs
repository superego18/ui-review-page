export const COLORS = {
  violet: { label: '보라', ink: '#86198f', fill: '#a21caf1f' },
  blue: { label: '파랑', ink: '#1d4ed8', fill: '#2563eb1f' },
  green: { label: '초록', ink: '#166534', fill: '#16a34a1f' },
  amber: { label: '주황', ink: '#92400e', fill: '#f59e0b29' },
  rose: { label: '빨강', ink: '#be123c', fill: '#e11d481f' },
};

export function applyColor(element, color) {
  const value = COLORS[color] || COLORS.violet;
  element.style.setProperty('--mark-ink', value.ink);
  element.style.setProperty('--mark-fill', value.fill);
}
