/** Cancel the browser zoom only inside the PDF viewport. */
export function installPdfWheel(viewport: HTMLElement, zoom: () => number, setZoom: (value: number) => void, render: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout>;
  let anchor: { x: number; y: number; left: number; top: number; zoom: number } | null = null;
  let generation = 0;
  viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation();
    const rect = viewport.getBoundingClientRect();
    if (!anchor) anchor = {x: event.clientX - rect.left, y: event.clientY - rect.top, left: viewport.scrollLeft, top: viewport.scrollTop, zoom: zoom()};
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    setZoom(Math.max(.5, Math.min(3, zoom() * Math.exp(-Math.max(-160, Math.min(160, pixels)) * .002))));
    const version = ++generation;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const origin = anchor!; anchor = null;
      const ratio = zoom() / origin.zoom;
      await render();
      if (version !== generation) return;
      viewport.scrollLeft = (origin.left + origin.x) * ratio - origin.x;
      viewport.scrollTop = (origin.top + origin.y) * ratio - origin.y;
    }, 65);
  }, {passive:false});
}
