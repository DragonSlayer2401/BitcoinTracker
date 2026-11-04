import { useEffect, useState } from 'react';
import { DEFAULT_DRAWING_COLOR, getValidatedChartDrawing } from '../utils/chartDrawings.utils';

const drawingMetadata = { id: 'drawing-preview', label: '', color: DEFAULT_DRAWING_COLOR };

/** Translate plot clicks into price/time coordinates; panning is disabled by the chart while drawing. */
export default function useChartDrawingInteraction({
  chart,
  activeTool,
  onToolChange,
  addDrawing,
}) {
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  useEffect(() => {
    setStart(null);
    setEnd(null);
  }, [activeTool, chart]);

  useEffect(() => {
    if (!chart || !['horizontal', 'vertical', 'trend'].includes(activeTool) || chart.isDisposed?.())
      return;
    const renderer = chart.getZr?.();
    if (!renderer) return;
    function getPoint(event) {
      if (chart.isDisposed?.()) return null;
      const pixel = [event?.offsetX, event?.offsetY];
      if (!pixel.every(Number.isFinite)) return null;
      // During a chart replacement ECharts may no longer have a coordinate system to convert.
      try {
        if (!chart.containPixel({ gridIndex: 0 }, pixel)) return null;
        const coordinates = chart.convertFromPixel({ gridIndex: 0 }, pixel);
        if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;
        const [time, price] = coordinates;
        if (!Number.isFinite(time) || !Number.isFinite(price)) return null;
        const point = {
          time: Math.round(time / 1000) * 1000,
          price: Math.round(price * 100) / 100,
        };
        return getValidatedChartDrawing({
          ...drawingMetadata,
          type: 'vertical',
          time: point.time,
        }) &&
          getValidatedChartDrawing({ ...drawingMetadata, type: 'horizontal', price: point.price })
          ? point
          : null;
      } catch {
        return null;
      }
    }
    function click(event) {
      const point = getPoint(event);
      if (!point) return;
      if (activeTool === 'trend' && !start) {
        setStart(point);
        return;
      }
      const drawing =
        activeTool === 'horizontal'
          ? { type: 'horizontal', price: point.price }
          : activeTool === 'vertical'
            ? { type: 'vertical', time: point.time }
            : { type: 'trend', start, end: point };
      if (!getValidatedChartDrawing({ ...drawingMetadata, ...drawing })) return;
      if (addDrawing(drawing)) {
        setStart(null);
        setEnd(null);
        onToolChange('select');
      }
    }
    function move(event) {
      if (start) setEnd(getPoint(event));
    }
    renderer.on('click', click);
    renderer.on('mousemove', move);
    return () => {
      renderer.off('click', click);
      renderer.off('mousemove', move);
    };
  }, [chart, activeTool, start, addDrawing, onToolChange]);

  return {
    draftDrawing:
      start && end
        ? getValidatedChartDrawing({ ...drawingMetadata, type: 'trend', start, end })
        : null,
    isChoosingEnd: Boolean(start),
  };
}
