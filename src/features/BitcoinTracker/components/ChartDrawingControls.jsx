import { useState } from 'react';
import { Alert, Button, ButtonGroup, Form, Modal } from 'react-bootstrap';
import Select from 'react-select';
import {
  CHART_DRAWING_COLORS,
  DEFAULT_DRAWING_COLOR,
  MAXIMUM_CHART_DRAWINGS,
  MAXIMUM_DRAWING_LABEL_LENGTH,
  getValidatedChartDrawing,
} from '../utils/chartDrawings.utils';
import './KalshiEventControl.scss';

const drawingTypes = [
  { value: 'horizontal', label: 'Horizontal price line' },
  { value: 'vertical', label: 'Vertical time line' },
  { value: 'trend', label: 'Trend line' },
];
const tools = [
  { value: 'select', label: 'Inspect', description: 'Inspect and pan chart' },
  { value: 'horizontal', label: 'H line', description: 'Draw horizontal price line' },
  { value: 'vertical', label: 'V line', description: 'Draw vertical time line' },
  { value: 'trend', label: 'Trend', description: 'Draw trend line' },
];
const selectClassNames = {
  control: ({ isFocused, isDisabled }) =>
    'schedule-select-control' +
    (isFocused ? ' schedule-select-focused' : '') +
    (isDisabled ? ' schedule-select-disabled' : ''),
  dropdownIndicator: () => 'schedule-select-arrow',
  valueContainer: () => 'schedule-select-value',
  singleValue: () => 'schedule-select-selection',
  menu: () => 'schedule-select-menu',
  menuList: () => 'schedule-select-options',
  option: ({ isFocused, isSelected }) =>
    'schedule-select-option' +
    (isFocused ? ' schedule-option-focused' : '') +
    (isSelected ? ' schedule-option-selected' : ''),
};
const pad = (value) => String(value).padStart(2, '0');
function toTimeInput(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function fromTimeInput(value) {
  const timestamp = new Date(value).getTime();
  // Reject impossible local times that Date would otherwise silently normalize.
  const normalized = value.length === 16 ? `${value}:00` : value;
  return toTimeInput(timestamp) === normalized ? timestamp : NaN;
}
const drawingName = (drawing, index) =>
  drawing.label ||
  `${drawingTypes.find((type) => type.value === drawing.type)?.label} ${index + 1}`;
function makeEditor(drawing, defaultPrice, defaultTime) {
  const time = Number.isFinite(defaultTime) ? defaultTime : Date.now();
  const price = Number.isFinite(defaultPrice) ? String(defaultPrice) : '';
  return {
    id: drawing?.id ?? null,
    type: drawing?.type ?? 'horizontal',
    label: drawing?.label ?? '',
    color: drawing?.color ?? DEFAULT_DRAWING_COLOR,
    price: drawing?.price === undefined ? price : String(drawing.price),
    time: toTimeInput(drawing?.time ?? time),
    startPrice: drawing?.start ? String(drawing.start.price) : price,
    startTime: toTimeInput(drawing?.start?.time ?? time - 60_000),
    endPrice: drawing?.end ? String(drawing.end.price) : price,
    endTime: toTimeInput(drawing?.end?.time ?? time),
  };
}

export default function ChartDrawingControls({
  drawings = [],
  onAdd,
  onUpdate,
  onRemove,
  onUndo,
  onClear,
  activeTool = 'select',
  onToolChange,
  defaultPrice,
  defaultTime,
  disabled = false,
  canUndo = true,
  embedded = false,
  mode = 'all',
}) {
  const isEmbedded = embedded && mode === 'all';
  const [isOpen, setIsOpen] = useState(false);
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState(null);
  const updateEditor = (key, value) => setEditor((previous) => ({ ...previous, [key]: value }));
  const startEditor = (drawing) => {
    setEditor(makeEditor(drawing, defaultPrice, defaultTime));
    setError(null);
  };
  const closeModal = () => {
    setIsOpen(false);
    setEditor(null);
    setError(null);
  };
  const saveDrawing = (event) => {
    event.preventDefault();
    if (disabled || !editor) return;
    const input = {
      type: editor.type,
      label: editor.label.trim(),
      color: editor.color,
      ...(editor.type === 'horizontal'
        ? { price: Number(editor.price) }
        : editor.type === 'vertical'
          ? { time: fromTimeInput(editor.time) }
          : {
              start: { time: fromTimeInput(editor.startTime), price: Number(editor.startPrice) },
              end: { time: fromTimeInput(editor.endTime), price: Number(editor.endPrice) },
            }),
    };
    if (!getValidatedChartDrawing({ ...input, id: editor.id ?? 'new-drawing' })) {
      setError('Enter positive prices and valid times. A trend line needs two distinct points.');
      return;
    }
    const result = editor.id ? onUpdate?.(editor.id, input) : onAdd?.(input);
    if (result === false) {
      setError('The drawing could not be saved. Check the chart’s storage message and try again.');
      return;
    }
    setEditor(null);
    setError(null);
  };
  const renderCoordinate = (key, label, type) => (
    <Form.Group className="mb-2" controlId={`drawing-${key}`} key={key}>
      <Form.Label className="small mb-1">{label}</Form.Label>
      <Form.Control
        type={type}
        step={type === 'number' ? 'any' : 1}
        min={type === 'number' ? 0.00000001 : undefined}
        max={type === 'number' ? 1e9 : undefined}
        value={editor[key]}
        onChange={(event) => updateEditor(key, event.target.value)}
        required
        disabled={disabled}
      />
    </Form.Group>
  );

  const managerTrigger = (
    <Button
      type="button"
      size="sm"
      variant="outline-secondary"
      disabled={disabled}
      onClick={() => {
        setIsOpen(true);
        setError(null);
      }}
      aria-label="Manage drawings"
    >
      Drawings{drawings.length ? ` (${drawings.length})` : ''}
    </Button>
  );
  const toolbar = (
    <div className="chart-drawing-controls d-flex flex-wrap align-items-center gap-1">
      <ButtonGroup size="sm" aria-label="Chart drawing tools">
        {tools.map((tool) => (
          <Button
            type="button"
            key={tool.value}
            variant={activeTool === tool.value ? 'secondary' : 'outline-secondary'}
            aria-label={tool.description}
            aria-pressed={activeTool === tool.value}
            disabled={disabled}
            onClick={() => onToolChange?.(tool.value)}
            title={tool.description}
          >
            {tool.label}
          </Button>
        ))}
      </ButtonGroup>
      {!isEmbedded && (
        <Button
          type="button"
          size="sm"
          variant="outline-secondary"
          onClick={onUndo}
          disabled={disabled || !canUndo}
          aria-label="Undo last drawing action"
        >
          Undo
        </Button>
      )}
      {!isEmbedded && mode !== 'tools' && managerTrigger}
    </div>
  );
  const management = (
    <>
      {!isEmbedded && (
        <p className="small text-secondary">
          Saved to this browser’s BRTI chart across events. Times use your local timezone.
        </p>
      )}
      {error && <Alert variant="warning">{error}</Alert>}
      {editor ? (
        <Form onSubmit={saveDrawing} aria-label={editor.id ? 'Edit drawing' : 'Add drawing'}>
          <h3 className="h6">{editor.id ? 'Edit drawing' : 'Add exact drawing'}</h3>
          <Form.Group className="mb-2">
            <Form.Label htmlFor="drawing-type" className="small mb-1">
              Drawing type
            </Form.Label>
            <Select
              inputId="drawing-type"
              instanceId="drawing-type"
              className="schedule-select schedule-select-menu-portal"
              unstyled
              classNames={selectClassNames}
              options={drawingTypes}
              value={drawingTypes.find((option) => option.value === editor.type)}
              onChange={(option) => updateEditor('type', option.value)}
              isSearchable={false}
              isDisabled={disabled || Boolean(editor.id)}
            />
          </Form.Group>
          <Form.Group className="mb-2" controlId="drawing-label">
            <Form.Label className="small mb-1">Label</Form.Label>
            <Form.Control
              value={editor.label}
              onChange={(event) => updateEditor('label', event.target.value)}
              maxLength={MAXIMUM_DRAWING_LABEL_LENGTH}
              disabled={disabled}
            />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label htmlFor="drawing-color" className="small mb-1">
              Line color
            </Form.Label>
            <Select
              inputId="drawing-color"
              instanceId="drawing-color"
              className="schedule-select schedule-select-menu-portal"
              unstyled
              classNames={selectClassNames}
              options={CHART_DRAWING_COLORS}
              value={CHART_DRAWING_COLORS.find((option) => option.value === editor.color)}
              onChange={(option) => updateEditor('color', option.value)}
              isSearchable={false}
              isDisabled={disabled}
            />
          </Form.Group>
          {editor.type === 'horizontal' && renderCoordinate('price', 'Price (USD)', 'number')}
          {editor.type === 'vertical' && renderCoordinate('time', 'Time', 'datetime-local')}
          {editor.type === 'trend' && (
            <>
              {renderCoordinate('startTime', 'Start time', 'datetime-local')}
              {renderCoordinate('startPrice', 'Start price (USD)', 'number')}
              {renderCoordinate('endTime', 'End time', 'datetime-local')}
              {renderCoordinate('endPrice', 'End price (USD)', 'number')}
            </>
          )}
          <div className="d-flex gap-2 mt-3">
            <Button type="submit" size="sm" disabled={disabled}>
              Save drawing
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline-secondary"
              onClick={() => setEditor(null)}
            >
              Cancel edit
            </Button>
          </div>
        </Form>
      ) : (
        <>
          <div className="d-flex justify-content-between align-items-center gap-2 mb-3">
            <span className="small text-secondary">
              {drawings.length} / {MAXIMUM_CHART_DRAWINGS} drawings
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => startEditor(null)}
              disabled={disabled || drawings.length >= MAXIMUM_CHART_DRAWINGS}
            >
              Add exact drawing
            </Button>
          </div>
          {!drawings.length ? (
            <p className="small mb-0">No drawings saved.</p>
          ) : (
            <ul className="list-unstyled mb-0" aria-label="Saved chart drawings">
              {drawings.map((drawing, index) => (
                <li
                  key={drawing.id}
                  className="d-flex flex-wrap justify-content-between align-items-center gap-2 py-2 border-bottom"
                >
                  <div className="small">
                    <strong className="d-block text-break">{drawingName(drawing, index)}</strong>
                    <span className="text-secondary">
                      {drawing.type === 'horizontal'
                        ? `$${drawing.price.toLocaleString()}`
                        : drawing.type === 'vertical'
                          ? new Date(drawing.time).toLocaleString()
                          : `$${drawing.start.price.toLocaleString()} → $${drawing.end.price.toLocaleString()}`}
                    </span>
                  </div>
                  <div className="d-flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline-secondary"
                      disabled={disabled}
                      aria-label={`Edit ${drawingName(drawing, index)}`}
                      onClick={() => startEditor(drawing)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline-danger"
                      disabled={disabled}
                      aria-label={`Delete ${drawingName(drawing, index)}`}
                      onClick={() => onRemove?.(drawing.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
  const actions = (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline-secondary"
        onClick={onUndo}
        disabled={disabled || !canUndo}
      >
        Undo last action
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline-danger"
        onClick={() => {
          onClear?.();
          setEditor(null);
        }}
        disabled={disabled || !drawings.length}
      >
        Clear all drawings
      </Button>
      {!isEmbedded && (
        <Button type="button" size="sm" variant="secondary" onClick={closeModal}>
          Done
        </Button>
      )}
    </>
  );
  if (mode === 'tools') return toolbar;
  if (isEmbedded)
    return (
      <section aria-label="Chart drawings">
        <h3 className="h6">Chart drawings</h3>
        {toolbar}
        <div className="mt-3">{management}</div>
        <div className="d-flex flex-wrap gap-2 mt-3">{actions}</div>
      </section>
    );
  return (
    <>
      {mode === 'manager' ? managerTrigger : toolbar}
      <Modal
        show={isOpen}
        onHide={closeModal}
        centered
        scrollable
        className="tracker-modal"
        aria-labelledby="drawings-title"
      >
        <Modal.Header closeButton>
          <Modal.Title id="drawings-title" className="h5">
            Chart drawings
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>{management}</Modal.Body>
        <Modal.Footer>{actions}</Modal.Footer>
      </Modal>
    </>
  );
}
