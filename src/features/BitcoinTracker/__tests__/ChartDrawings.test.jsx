import { useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartDrawingControls from '../components/ChartDrawingControls';
import useChartDrawings from '../hooks/useChartDrawings';
import {
  CHART_DRAWINGS_STORAGE_KEY,
  DEFAULT_DRAWING_COLOR,
  getValidatedChartDrawing,
  getValidatedChartDrawings,
  readChartDrawings,
  writeChartDrawings,
} from '../utils/chartDrawings.utils';

const NOW = Date.UTC(2026, 8, 14, 12);
const horizontal = (overrides = {}) => ({
  id: 'horizontal-1',
  type: 'horizontal',
  label: 'Support',
  color: DEFAULT_DRAWING_COLOR,
  price: 100_000,
  ...overrides,
});
const vertical = (overrides = {}) => ({
  id: 'vertical-1',
  type: 'vertical',
  label: 'Close',
  color: '#f4c56a',
  time: NOW,
  ...overrides,
});
const trend = (overrides = {}) => ({
  id: 'trend-1',
  type: 'trend',
  label: 'Trend',
  color: '#31d0aa',
  start: { time: NOW - 60_000, price: 100_000 },
  end: { time: NOW, price: 100_100 },
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('validates and copies all three coordinate types without inventing forecast data', () => {
  const input = [horizontal(), vertical(), trend()];
  const drawings = getValidatedChartDrawings(input);
  expect(drawings).toEqual(input);
  expect(drawings[2].start).not.toBe(input[2].start);
  expect(
    getValidatedChartDrawing(trend({ end: { time: NOW + 60_000, price: 100_200 } })),
  ).not.toBeNull();
});

test.each([NaN, Infinity, -1, 0, 1e9 + 1, '100000', null])('rejects invalid price %s', (price) => {
  expect(getValidatedChartDrawing(horizontal({ price }))).toBeNull();
  expect(getValidatedChartDrawing(trend({ end: { time: NOW, price } }))).toBeNull();
});

test.each([NaN, Infinity, 0, NOW + 0.5, Date.UTC(2008, 0, 1), Date.UTC(2030, 0, 1), '2026-09-14'])(
  'rejects invalid time %s',
  (time) => {
    expect(getValidatedChartDrawing(vertical({ time }))).toBeNull();
  },
);

test('rejects invalid labels, colors, types, duplicate IDs, and identical trend points', () => {
  for (const changes of [
    { label: 'x'.repeat(41) },
    { label: 'first\nsecond' },
    { color: 'url(javascript:alert(1))' },
    { type: 'script' },
    { extra: 'unexpected' },
  ])
    expect(getValidatedChartDrawing(horizontal(changes))).toBeNull();
  expect(getValidatedChartDrawing(trend({ end: trend().start }))).toBeNull();
  expect(getValidatedChartDrawings([horizontal(), horizontal()])).toBeNull();
  expect(
    getValidatedChartDrawings(
      Array.from({ length: 51 }, (_, index) => horizontal({ id: `line-${index}` })),
    ),
  ).toBeNull();
});

test('persists a symbol-wide bounded collection and restores it through reload', () => {
  const first = renderHook(() => useChartDrawings());
  expect(first.result.current.isRestored).toBe(true);
  let added;
  act(() => {
    added = first.result.current.addDrawing({ type: 'horizontal', price: 100_050 });
  });
  expect(added).toBe(true);
  const saved = JSON.parse(localStorage.getItem(CHART_DRAWINGS_STORAGE_KEY));
  expect(saved.symbol).toBe('CF-BRTI');
  expect(saved.drawings[0]).toMatchObject({
    type: 'horizontal',
    price: 100_050,
    label: '',
    color: DEFAULT_DRAWING_COLOR,
  });
  expect(saved.drawings[0].id).toEqual(expect.any(String));
  first.unmount();
  const restored = renderHook(() => useChartDrawings());
  expect(restored.result.current.drawings).toEqual(saved.drawings);
  expect(restored.result.current.warning).toBeNull();
});

test('updates and deletes by identity, and Undo reverses edit, delete, and Clear', () => {
  writeChartDrawings([horizontal(), vertical()]);
  const view = renderHook(() => useChartDrawings());
  act(() =>
    view.result.current.updateDrawing('horizontal-1', { price: 99_900, label: 'Lower support' }),
  );
  expect(view.result.current.drawings[0]).toMatchObject({ price: 99_900, label: 'Lower support' });
  act(() => view.result.current.undoLast());
  expect(view.result.current.drawings[0]).toEqual(horizontal());
  act(() => view.result.current.removeDrawing('vertical-1'));
  expect(view.result.current.drawings).toEqual([horizontal()]);
  act(() => view.result.current.undoLast());
  expect(view.result.current.drawings).toEqual([horizontal(), vertical()]);
  act(() => view.result.current.clearDrawings());
  expect(view.result.current.drawings).toEqual([]);
  expect(view.result.current.canUndo).toBe(true);
  act(() => view.result.current.undoLast());
  expect(readChartDrawings().drawings).toEqual([horizontal(), vertical()]);
});

test('merges another tab’s newest drawings before local edits and follows storage events', () => {
  const view = renderHook(() => useChartDrawings());
  writeChartDrawings([horizontal()]);
  act(() => view.result.current.addDrawing(vertical()));
  expect(view.result.current.drawings).toEqual([horizontal(), vertical()]);
  act(() => {
    writeChartDrawings([trend()]);
    window.dispatchEvent(new StorageEvent('storage', { key: CHART_DRAWINGS_STORAGE_KEY }));
  });
  expect(view.result.current.drawings).toEqual([trend()]);
  expect(view.result.current.canUndo).toBe(false);
  act(() => {
    localStorage.removeItem(CHART_DRAWINGS_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(view.result.current.drawings).toEqual([]);
});

test('undo never restores an older snapshot over an undelivered other-tab change', () => {
  const view = renderHook(() => useChartDrawings());
  act(() => view.result.current.addDrawing(horizontal()));
  writeChartDrawings([horizontal(), vertical()]);
  let undone;
  act(() => {
    undone = view.result.current.undoLast();
  });
  expect(undone).toBe(false);
  expect(readChartDrawings().drawings).toEqual([horizontal(), vertical()]);
  expect(view.result.current.warning).toMatch(/another tab/);
});

test.each([
  '{invalid',
  JSON.stringify({ version: 1, symbol: 'CF-BRTI', drawings: [horizontal({ price: null })] }),
])('preserves malformed saved drawings without overwriting them', (stored) => {
  localStorage.setItem(CHART_DRAWINGS_STORAGE_KEY, stored);
  const view = renderHook(() => useChartDrawings());
  expect(view.result.current.warning).toMatch(/preserved/);
  let added;
  act(() => {
    added = view.result.current.addDrawing(horizontal());
  });
  act(() => view.result.current.clearDrawings());
  expect(added).toBe(false);
  expect(writeChartDrawings([])).toMatch(/preserved/);
  expect(localStorage.getItem(CHART_DRAWINGS_STORAGE_KEY)).toBe(stored);
});

test('a storage quota failure retains the previous drawings and reports failure', () => {
  writeChartDrawings([horizontal()]);
  const view = renderHook(() => useChartDrawings());
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  let updated;
  act(() => {
    updated = view.result.current.updateDrawing('horizontal-1', { price: 90_000 });
  });
  expect(updated).toBe(false);
  expect(view.result.current.drawings).toEqual([horizontal()]);
  expect(view.result.current.warning).toMatch(/could not be saved/);
});

test('a full chart rejects a 51st drawing while keeping existing lines editable', () => {
  const drawings = Array.from({ length: 50 }, (_, index) => horizontal({ id: `line-${index}` }));
  writeChartDrawings(drawings);
  const view = renderHook(() => useChartDrawings());
  let added;
  act(() => {
    added = view.result.current.addDrawing(vertical());
  });
  expect(added).toBe(false);
  expect(view.result.current.drawings).toHaveLength(50);
  act(() => view.result.current.updateDrawing('line-0', { price: 100_100 }));
  expect(view.result.current.drawings[0].price).toBe(100_100);
});

function DrawingEditor({ embedded = false, mode }) {
  const state = useChartDrawings();
  const [activeTool, onToolChange] = useState('select');
  return (
    <ChartDrawingControls
      embedded={embedded}
      mode={mode}
      drawings={state.drawings}
      onAdd={state.addDrawing}
      onUpdate={state.updateDrawing}
      onRemove={state.removeDrawing}
      onUndo={state.undoLast}
      onClear={state.clearDrawings}
      canUndo={state.canUndo}
      activeTool={activeTool}
      onToolChange={onToolChange}
      defaultPrice={100_000}
      defaultTime={NOW}
      disabled={!state.isRestored}
    />
  );
}

test('embedded drawings show their list and exact add/edit controls without opening a nested modal', async () => {
  const user = userEvent.setup();
  writeChartDrawings([horizontal()]);
  render(<DrawingEditor embedded />);
  const panel = screen.getByRole('region', { name: 'Chart drawings' });
  expect(within(panel).getByRole('heading', { name: 'Chart drawings' })).toBeInTheDocument();
  expect(within(panel).getByRole('list', { name: 'Saved chart drawings' })).toHaveTextContent(
    'Support',
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Manage drawings' })).not.toBeInTheDocument();
  await user.click(within(panel).getByRole('button', { name: 'Add exact drawing' }));
  await user.type(within(panel).getByRole('textbox', { name: 'Label' }), 'Resistance');
  const price = within(panel).getByRole('spinbutton', { name: 'Price (USD)' });
  await user.clear(price);
  await user.type(price, '100250[Enter]');
  expect(readChartDrawings().drawings).toHaveLength(2);
  expect(within(panel).getByRole('list', { name: 'Saved chart drawings' })).toHaveTextContent(
    'Resistance',
  );
  await user.click(within(panel).getByRole('button', { name: 'Edit Support' }));
  const editedPrice = within(panel).getByRole('spinbutton', { name: 'Price (USD)' });
  await user.clear(editedPrice);
  await user.type(editedPrice, '99900[Enter]');
  expect(readChartDrawings().drawings[0].price).toBe(99_900);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(within(panel).getByRole('button', { name: 'Clear all drawings' }));
  expect(within(panel).getByText('No drawings saved.')).toBeInTheDocument();
  await user.click(within(panel).getByRole('button', { name: 'Undo last action' }));
  expect(readChartDrawings().drawings).toHaveLength(2);
});

test('embedded drawing tools tell the parent which tool was selected', async () => {
  const user = userEvent.setup();
  const onToolChange = jest.fn();
  render(<ChartDrawingControls embedded onToolChange={onToolChange} />);
  await user.click(screen.getByRole('button', { name: 'Draw trend line' }));
  expect(onToolChange).toHaveBeenCalledWith('trend');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('manager mode opens directly to saved drawings and can delete one, clear all, and undo', async () => {
  const user = userEvent.setup();
  writeChartDrawings([horizontal(), vertical()]);
  render(<DrawingEditor mode="manager" />);
  const trigger = screen.getByRole('button', { name: 'Manage drawings' });
  expect(trigger).toHaveTextContent('Drawings (2)');
  expect(
    screen.queryByRole('button', { name: 'Draw horizontal price line' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Undo last drawing action' }),
  ).not.toBeInTheDocument();
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Chart drawings' });
  expect(within(dialog).getByRole('list', { name: 'Saved chart drawings' })).toHaveTextContent(
    'Support',
  );
  expect(within(dialog).getByRole('button', { name: 'Edit Support' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Add exact drawing' })).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Delete Support' }));
  expect(readChartDrawings().drawings).toEqual([vertical()]);
  expect(within(dialog).queryByRole('button', { name: 'Delete Support' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Delete Close' })).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Clear all drawings' }));
  expect(readChartDrawings().drawings).toEqual([]);
  expect(within(dialog).getByText('No drawings saved.')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Undo last action' }));
  expect(readChartDrawings().drawings).toEqual([vertical()]);
});

test('tools mode contains only drawing tools and Undo, without a manager or exact editor', async () => {
  const user = userEvent.setup();
  const onToolChange = jest.fn();
  const onUndo = jest.fn();
  render(
    <ChartDrawingControls
      mode="tools"
      embedded
      drawings={[horizontal()]}
      onToolChange={onToolChange}
      onUndo={onUndo}
    />,
  );
  expect(screen.getByRole('button', { name: 'Inspect and pan chart' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Draw horizontal price line' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Draw vertical time line' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Draw trend line' }));
  expect(onToolChange).toHaveBeenCalledWith('trend');
  await user.click(screen.getByRole('button', { name: 'Undo last drawing action' }));
  expect(onUndo).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Manage drawings' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add exact drawing' })).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Saved chart drawings' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('keyboard users can select a drawing tool and create, edit, remove, and restore exact lines', async () => {
  const user = userEvent.setup();
  render(<DrawingEditor />);
  screen.getByRole('button', { name: 'Draw horizontal price line' }).focus();
  await user.keyboard('[Space]');
  expect(screen.getByRole('button', { name: 'Draw horizontal price line' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  screen.getByRole('button', { name: 'Manage drawings' }).focus();
  await user.keyboard('[Enter]');
  const dialog = await screen.findByRole('dialog', { name: 'Chart drawings' });
  await user.click(within(dialog).getByRole('button', { name: 'Add exact drawing' }));
  await user.type(within(dialog).getByRole('textbox', { name: 'Label' }), 'Support level');
  const price = within(dialog).getByRole('spinbutton', { name: 'Price (USD)' });
  await user.clear(price);
  await user.type(price, '99900');
  await user.keyboard('[Enter]');
  expect(readChartDrawings().drawings[0]).toMatchObject({ price: 99_900, label: 'Support level' });
  await user.click(within(dialog).getByRole('button', { name: 'Edit Support level' }));
  const editedPrice = within(dialog).getByRole('spinbutton', { name: 'Price (USD)' });
  await user.clear(editedPrice);
  await user.type(editedPrice, '99950[Enter]');
  expect(readChartDrawings().drawings[0].price).toBe(99_950);
  await user.click(within(dialog).getByRole('button', { name: 'Delete Support level' }));
  expect(within(dialog).getByText('No drawings saved.')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Undo last action' }));
  expect(readChartDrawings().drawings[0].price).toBe(99_950);
  await user.click(within(dialog).getByRole('button', { name: 'Clear all drawings' }));
  expect(readChartDrawings().drawings).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'Undo last action' }));
  expect(readChartDrawings().drawings).toHaveLength(1);
});

test('the exact editor supports vertical times and two-point trends with React Select', async () => {
  const user = userEvent.setup();
  render(<DrawingEditor />);
  await user.click(screen.getByRole('button', { name: 'Manage drawings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Chart drawings' });
  await user.click(within(dialog).getByRole('button', { name: 'Add exact drawing' }));
  await user.click(within(dialog).getByRole('combobox', { name: 'Drawing type' }));
  await user.click(screen.getByRole('option', { name: 'Vertical time line' }));
  fireEvent.change(within(dialog).getByLabelText('Time'), {
    target: { value: '2026-09-14T12:05' },
  });
  await user.click(within(dialog).getByRole('button', { name: 'Save drawing' }));
  expect(readChartDrawings().drawings[0]).toMatchObject({
    type: 'vertical',
    time: new Date('2026-09-14T12:05').getTime(),
  });
  await user.click(within(dialog).getByRole('button', { name: 'Add exact drawing' }));
  await user.click(within(dialog).getByRole('combobox', { name: 'Drawing type' }));
  await user.click(screen.getByRole('option', { name: 'Trend line' }));
  const endPrice = within(dialog).getByRole('spinbutton', { name: 'End price (USD)' });
  await user.clear(endPrice);
  await user.type(endPrice, '100250');
  await user.click(within(dialog).getByRole('button', { name: 'Save drawing' }));
  expect(readChartDrawings().drawings[1]).toMatchObject({
    type: 'trend',
    end: { time: NOW, price: 100_250 },
  });
});

test('labels render as text and disabled controls cannot mutate drawings', async () => {
  const user = userEvent.setup();
  const props = {
    drawings: [horizontal({ label: '<img src=x onerror=alert(1)>' })],
    onRemove: jest.fn(),
    onAdd: jest.fn(),
    onToolChange: jest.fn(),
  };
  const { rerender } = render(<ChartDrawingControls {...props} />);
  await user.click(screen.getByRole('button', { name: 'Manage drawings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Chart drawings' });
  expect(within(dialog).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(dialog.querySelector('img')).toBeNull();
  rerender(<ChartDrawingControls {...props} disabled />);
  const remove = within(dialog).getByRole('button', { name: /Delete <img/ });
  expect(remove).toBeDisabled();
  await user.click(remove);
  expect(props.onRemove).not.toHaveBeenCalled();
});
