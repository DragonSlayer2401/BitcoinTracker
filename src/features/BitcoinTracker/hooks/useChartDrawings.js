import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHART_DRAWINGS_STORAGE_KEY,
  DEFAULT_DRAWING_COLOR,
  MAXIMUM_CHART_DRAWINGS,
  getValidatedChartDrawing,
  readChartDrawings,
  writeChartDrawings,
} from '../utils/chartDrawings.utils';

/** A symbol's chart annotations persist across Kalshi events; actions merge with durable state. */
export default function useChartDrawings() {
  const [drawings, setDrawings] = useState([]);
  const [warning, setWarning] = useState(null);
  const [isRestored, setIsRestored] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const undoHistory = useRef([]);

  useEffect(() => {
    const restore = () => {
      const saved = readChartDrawings();
      setWarning(saved.warning);
      if (!saved.warning) setDrawings(saved.drawings);
      undoHistory.current = [];
      setCanUndo(false);
      setIsRestored(true);
    };
    const handleStorage = (event) => {
      if (event.key === null || event.key === CHART_DRAWINGS_STORAGE_KEY) restore();
    };
    restore();
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const changeDrawings = useCallback(
    (getNext) => {
      if (!isRestored) return false;
      const saved = readChartDrawings();
      if (saved.warning) {
        setWarning(saved.warning);
        return false;
      }
      const next = getNext(saved.drawings);
      if (!next) return false;
      const saveWarning = writeChartDrawings(next);
      setWarning(saveWarning);
      if (saveWarning) return false;
      const previousAction = undoHistory.current.at(-1);
      if (previousAction && JSON.stringify(previousAction.after) !== JSON.stringify(saved.drawings))
        undoHistory.current = [];
      undoHistory.current = [
        ...undoHistory.current.slice(-(MAXIMUM_CHART_DRAWINGS - 1)),
        { before: saved.drawings, after: next },
      ];
      setCanUndo(true);
      setDrawings(next);
      return true;
    },
    [isRestored],
  );

  const addDrawing = useCallback(
    (input) =>
      changeDrawings((current) => {
        const drawing = getValidatedChartDrawing({
          label: '',
          color: DEFAULT_DRAWING_COLOR,
          ...input,
          id: input?.id ?? crypto.randomUUID(),
        });
        if (!drawing || current.some((entry) => entry.id === drawing.id)) {
          setWarning(
            'Choose valid, distinct drawing coordinates and a label of at most 40 characters.',
          );
          return null;
        }
        if (current.length >= MAXIMUM_CHART_DRAWINGS) {
          setWarning('The chart supports 50 drawings. Remove one before adding another.');
          return null;
        }
        return [...current, drawing];
      }),
    [changeDrawings],
  );
  const updateDrawing = useCallback(
    (id, changes) =>
      changeDrawings((current) => {
        const existing = current.find((drawing) => drawing.id === id);
        const drawing = getValidatedChartDrawing({ ...existing, ...changes });
        if (!existing || !drawing || drawing.id !== id || drawing.type !== existing.type) {
          setWarning('The drawing could not be updated. Check its label, price, and time.');
          return null;
        }
        return current.map((entry) => (entry.id === id ? drawing : entry));
      }),
    [changeDrawings],
  );
  const removeDrawing = useCallback(
    (id) =>
      changeDrawings((current) => {
        if (!current.some((drawing) => drawing.id === id)) return null;
        return current.filter((drawing) => drawing.id !== id);
      }),
    [changeDrawings],
  );
  const clearDrawings = useCallback(
    () => changeDrawings((current) => (current.length ? [] : null)),
    [changeDrawings],
  );
  const undoLast = useCallback(() => {
    if (!isRestored || !undoHistory.current.length) return false;
    const previous = undoHistory.current.at(-1);
    const saved = readChartDrawings();
    if (saved.warning) {
      setWarning(saved.warning);
      return false;
    }
    if (JSON.stringify(saved.drawings) !== JSON.stringify(previous.after)) {
      undoHistory.current = [];
      setCanUndo(false);
      setDrawings(saved.drawings);
      setWarning('Drawings changed in another tab. That tab’s changes were kept; undo was reset.');
      return false;
    }
    const saveWarning = writeChartDrawings(previous.before);
    setWarning(saveWarning);
    if (saveWarning) return false;
    undoHistory.current.pop();
    setCanUndo(undoHistory.current.length > 0);
    setDrawings(previous.before);
    return true;
  }, [isRestored]);

  return {
    drawings,
    addDrawing,
    updateDrawing,
    removeDrawing,
    undoLast,
    clearDrawings,
    warning,
    isRestored,
    canUndo,
  };
}
