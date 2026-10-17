// Reconnect after suspension; the server, not a retained phone view, owns current state.
export function onBrowserResume(resume: () => void): () => void {
  let frame: number | undefined;
  const schedule = () => {
    if (document.visibilityState !== 'visible' || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (document.visibilityState === 'visible') resume();
    });
  };
  const restored = (event: PageTransitionEvent) => {
    if (event.persisted) schedule();
  };
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pageshow', restored);
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', schedule);
    window.removeEventListener('pageshow', restored);
  };
}
