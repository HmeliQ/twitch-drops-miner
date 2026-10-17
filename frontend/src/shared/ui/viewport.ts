export function viewportBounds() {
  const viewport = window.visualViewport;
  const style = getComputedStyle(document.documentElement);
  const safe = (side: string) => parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0;
  const x = viewport?.offsetLeft ?? 0;
  const y = viewport?.offsetTop ?? 0;
  return {
    left: Math.max(x, safe('left')) + 8,
    top: Math.max(y, safe('top')) + 8,
    right: Math.min(x + (viewport?.width ?? innerWidth), innerWidth - safe('right')) - 8,
    bottom: Math.min(y + (viewport?.height ?? innerHeight), innerHeight - safe('bottom')) - 8,
  };
}
