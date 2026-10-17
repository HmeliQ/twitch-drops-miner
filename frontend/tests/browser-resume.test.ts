import { afterEach, expect, it, vi } from 'vitest';
import { onBrowserResume } from '../src/app/browserResume';
import { viewportBounds } from '../src/shared/ui/viewport';

afterEach(() => vi.unstubAllGlobals());

it('coalesces foreground/BFCache events and cancels pending work on disposal', () => {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(1, callback);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  const resume = vi.fn();
  const close = onBrowserResume(resume);
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  flush();
  expect(resume).not.toHaveBeenCalled();
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  flush();
  expect(resume).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event('visibilitychange'));
  document.visibilityState = 'hidden';
  flush();
  expect(resume).toHaveBeenCalledTimes(1);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  close();
  flush();
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  flush();
  expect(resume).toHaveBeenCalledTimes(1);
});

it('keeps overlays inside safe areas and the keyboard viewport without double insets', () => {
  const viewport = { offsetLeft: 0, offsetTop: 0, width: 844, height: 390 };
  vi.stubGlobal('window', { visualViewport: viewport });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('innerWidth', 844);
  vi.stubGlobal('innerHeight', 390);
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (key: string) =>
      ({
        '--safe-left': '44px',
        '--safe-right': '44px',
        '--safe-top': '0px',
        '--safe-bottom': '21px',
      })[key] ?? '',
  }));
  expect(viewportBounds()).toEqual({ left: 52, top: 8, right: 792, bottom: 361 });
  viewport.offsetLeft = 60;
  viewport.offsetTop = 30;
  viewport.width = 700;
  viewport.height = 180;
  expect(viewportBounds()).toEqual({ left: 68, top: 38, right: 752, bottom: 202 });
});
