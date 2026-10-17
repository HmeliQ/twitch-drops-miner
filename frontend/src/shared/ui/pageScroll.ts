export function pageScrollElement() {
  const content = document.getElementById('main');
  return content && window.matchMedia('(max-width: 1023px)').matches
    ? content
    : (document.scrollingElement ?? document.documentElement);
}
