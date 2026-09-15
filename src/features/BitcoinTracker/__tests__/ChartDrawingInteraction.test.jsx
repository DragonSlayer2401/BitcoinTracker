import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import useChartDrawingInteraction from '../hooks/useChartDrawingInteraction';

const NOW = Date.UTC(2026, 8, 14, 12);

function makeChart() {
  const listeners = new Map();
  const renderer = {
    on: jest.fn((type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    }),
    off: jest.fn((type, handler) => listeners.get(type)?.delete(handler)),
  };
  const chart = {
    isDisposed: jest.fn(() => false),
    getZr: jest.fn(() => renderer),
    containPixel: jest.fn((_finder, [x, y]) => x >= 0 && x <= 600 && y >= 0 && y <= 200),
    convertFromPixel: jest.fn((_finder, [x, y]) => [NOW + x * 1000, 100_000 - y]),
  };
  return {
    chart,
    renderer,
    listeners,
    emit(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
  };
}

function setup(activeTool = 'horizontal', overrides = {}) {
  const source = makeChart();
  const input = {
    chart: source.chart,
    activeTool,
    onToolChange: jest.fn(),
    addDrawing: jest.fn(() => true),
    ...overrides,
  };
  const view = renderHook((props) => useChartDrawingInteraction(props), { initialProps: input });
  return { ...source, input, ...view };
}
const click = (view, x, y) => act(() => view.emit('click', { offsetX: x, offsetY: y }));
const move = (view, x, y) => act(() => view.emit('mousemove', { offsetX: x, offsetY: y }));

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
afterEach(() => jest.restoreAllMocks());

test('horizontal and vertical tools capture rounded price/time coordinates only from the price pane', () => {
  const view = setup();
  click(view, 40, 50.827);
  expect(view.input.addDrawing).toHaveBeenCalledWith({ type: 'horizontal', price: 99_949.17 });
  expect(view.chart.convertFromPixel).toHaveBeenCalledWith({ gridIndex: 0 }, [40, 50.827]);
  expect(view.input.onToolChange).toHaveBeenCalledWith('select');
  view.rerender({ ...view.input, activeTool: 'vertical' });
  click(view, 42.789, 50);
  expect(view.input.addDrawing).toHaveBeenLastCalledWith({ type: 'vertical', time: NOW + 43_000 });
});

test('a trend uses two clicks and previews the second point without saving during movement', () => {
  const view = setup('trend');
  click(view, 10, 10);
  expect(view.result.current.isChoosingEnd).toBe(true);
  expect(view.result.current.draftDrawing).toBeNull();
  expect(view.input.addDrawing).not.toHaveBeenCalled();
  move(view, 20, 20);
  expect(view.result.current.draftDrawing).toMatchObject({
    type: 'trend',
    start: { time: NOW + 10_000, price: 99_990 },
    end: { time: NOW + 20_000, price: 99_980 },
  });
  expect(view.input.addDrawing).not.toHaveBeenCalled();
  click(view, 25, 15);
  expect(view.input.addDrawing).toHaveBeenCalledTimes(1);
  expect(view.input.addDrawing).toHaveBeenCalledWith({
    type: 'trend',
    start: { time: NOW + 10_000, price: 99_990 },
    end: { time: NOW + 25_000, price: 99_985 },
  });
  expect(view.result.current.draftDrawing).toBeNull();
  expect(view.result.current.isChoosingEnd).toBe(false);
  expect(view.input.onToolChange).toHaveBeenCalledWith('select');
});

test('clicks on indicator panes or outside the chart never place or complete drawings', () => {
  const view = setup('trend');
  click(view, 20, 250);
  expect(view.result.current.isChoosingEnd).toBe(false);
  expect(view.chart.convertFromPixel).not.toHaveBeenCalled();
  click(view, 10, 10);
  move(view, 20, 20);
  move(view, 20, 250);
  expect(view.result.current.draftDrawing).toBeNull();
  expect(view.result.current.isChoosingEnd).toBe(true);
  click(view, -1, 50);
  expect(view.input.addDrawing).not.toHaveBeenCalled();
  click(view, 30, 30);
  expect(view.input.addDrawing).toHaveBeenCalledTimes(1);
});

test.each([
  null,
  undefined,
  [],
  [NOW],
  [NaN, 100_000],
  [NOW, Infinity],
  [NOW, -1],
  [NOW, 0.001],
  [NOW, 1e9 + 1],
  [Date.UTC(2030, 0, 1), 100_000],
  ['2026-09-14', 100_000],
])('invalid converted coordinates %j do not create a drawing or trend start', (coordinates) => {
  const view = setup('trend');
  view.chart.convertFromPixel.mockReturnValue(coordinates);
  click(view, 10, 10);
  expect(view.result.current.isChoosingEnd).toBe(false);
  expect(view.input.addDrawing).not.toHaveBeenCalled();
});

test('invalid pixel events and a missing coordinate system are ignored safely', () => {
  const view = setup();
  act(() => {
    view.emit('click', null);
    view.emit('click', { offsetX: NaN, offsetY: 10 });
    view.emit('click', { offsetX: 10, offsetY: undefined });
  });
  expect(view.chart.containPixel).not.toHaveBeenCalled();
  view.chart.convertFromPixel.mockImplementation(() => {
    throw new Error('chart is rebuilding');
  });
  expect(() => click(view, 10, 10)).not.toThrow();
  expect(view.input.addDrawing).not.toHaveBeenCalled();
});

test('identical trend endpoints are ignored and a failed save retains the selected start', () => {
  const view = setup('trend', { addDrawing: jest.fn(() => false) });
  click(view, 10, 10);
  move(view, 10, 10);
  expect(view.result.current.draftDrawing).toBeNull();
  click(view, 10, 10);
  expect(view.input.addDrawing).not.toHaveBeenCalled();
  click(view, 20, 20);
  expect(view.input.addDrawing).toHaveBeenCalledTimes(1);
  expect(view.result.current.isChoosingEnd).toBe(true);
  expect(view.input.onToolChange).not.toHaveBeenCalled();
  view.input.addDrawing.mockReturnValue(true);
  click(view, 30, 30);
  expect(view.result.current.isChoosingEnd).toBe(false);
});

test('switching tools and replacing the chart clear unfinished trends', () => {
  const view = setup('trend');
  click(view, 10, 10);
  move(view, 20, 20);
  view.rerender({ ...view.input, activeTool: 'vertical' });
  expect(view.result.current.isChoosingEnd).toBe(false);
  expect(view.result.current.draftDrawing).toBeNull();
  view.rerender(view.input);
  click(view, 30, 30);
  const replacement = makeChart();
  view.rerender({ ...view.input, chart: replacement.chart });
  expect(view.result.current.isChoosingEnd).toBe(false);
  expect(view.listeners.get('click').size).toBe(0);
  act(() => replacement.emit('click', { offsetX: 40, offsetY: 40 }));
  expect(view.result.current.isChoosingEnd).toBe(true);
  expect(view.input.addDrawing).not.toHaveBeenCalled();
});

test('Escape cancellation through the chart owner resets the draft and returns to Select', () => {
  const source = makeChart();
  const addDrawing = jest.fn(() => true);
  function Owner() {
    const [activeTool, onToolChange] = useState('trend');
    const { isChoosingEnd, draftDrawing } = useChartDrawingInteraction({
      chart: source.chart,
      activeTool,
      onToolChange,
      addDrawing,
    });
    return (
      <div
        tabIndex={0}
        data-testid="chart-owner"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onToolChange('select');
        }}
      >
        <span>{activeTool}</span>
        <span>{isChoosingEnd ? 'Choosing end' : 'No start'}</span>
        {draftDrawing && <span>Preview</span>}
      </div>
    );
  }
  render(<Owner />);
  act(() => source.emit('click', { offsetX: 10, offsetY: 10 }));
  act(() => source.emit('mousemove', { offsetX: 20, offsetY: 20 }));
  expect(screen.getByText('Preview')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByTestId('chart-owner'), { key: 'Escape' });
  expect(screen.getByText('select')).toBeInTheDocument();
  expect(screen.getByText('No start')).toBeInTheDocument();
  expect(screen.queryByText('Preview')).not.toBeInTheDocument();
  expect(addDrawing).not.toHaveBeenCalled();
  expect(source.listeners.get('click').size).toBe(0);
});

test('listeners are removed after Select, unmount, or disposal and unsupported tools add none', () => {
  const view = setup();
  const originalClick = view.renderer.on.mock.calls.find(([type]) => type === 'click')[1];
  view.rerender({ ...view.input, activeTool: 'select' });
  expect(view.renderer.off).toHaveBeenCalledWith('click', originalClick);
  expect(view.listeners.get('click').size).toBe(0);
  expect(view.listeners.get('mousemove').size).toBe(0);
  view.rerender({ ...view.input, activeTool: 'unsupported' });
  expect(view.listeners.get('click').size).toBe(0);
  view.rerender(view.input);
  view.chart.isDisposed.mockReturnValue(true);
  click(view, 10, 10);
  expect(view.input.addDrawing).not.toHaveBeenCalled();
  view.unmount();
  expect(view.listeners.get('click').size).toBe(0);
  expect(view.listeners.get('mousemove').size).toBe(0);
});
