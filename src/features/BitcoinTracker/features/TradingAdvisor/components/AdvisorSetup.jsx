import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Form, Modal, Spinner } from 'react-bootstrap';
import Select from 'react-select';
import {
  readAdvisorConfiguration,
  saveAdvisorConfiguration,
  readCollectorControl,
  changeCollectorControl,
} from '@/services/research/tradingAdvisor/advisorSetup.service';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import { formatAdvisorMoney } from '../utils/advisorDisplay.utils';
import { scheduleClassNames } from '../../../components/KalshiEventControl';

const riskOptions = [
  { value: 'conservative', label: 'Conservative · smaller positions' },
  { value: 'balanced', label: 'Balanced · larger risk allowance' },
];

/** Local setup keeps editable drafts separate from the saved account and running collector. */
export default function AdvisorSetup({ onSaved }) {
  const [isOpen, setIsOpen] = useState(false);
  const [configuration, setConfiguration] = useState(null);
  const [control, setControl] = useState(null);
  const [allocation, setAllocation] = useState('100');
  const [riskLevel, setRiskLevel] = useState('conservative');
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestController = useRef(null);
  const preview = useMemo(() => {
    try {
      return createTradingAdvisorPolicy({
        allocation: Number(allocation),
        riskLevel,
        runId: 'preview',
      });
    } catch {
      return null;
    }
  }, [allocation, riskLevel]);
  const hasUnsavedChanges = Boolean(
    configuration &&
    (configuration.policy.version !== 2 ||
      configuration.policy.totalBudget !== Number(allocation) ||
      configuration.policy.riskLevel !== riskLevel),
  );

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    requestController.current = controller;
    setIsLoading(true);
    setError('');
    setMessage('');
    setConfiguration(null);
    setControl(null);
    Promise.allSettled([
      readAdvisorConfiguration(controller.signal),
      readCollectorControl(controller.signal),
    ])
      .then(([saved, collector]) => {
        if (controller.signal.aborted) return;
        if (collector.status === 'fulfilled') setControl(collector.value);
        if (saved.status === 'rejected') throw saved.reason;
        setConfiguration(saved.value);
        setAllocation(String(saved.value.policy.totalBudget));
        setRiskLevel(saved.value.policy.riskLevel ?? 'conservative');
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    const timer = setInterval(() => {
      readCollectorControl(controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setControl(next);
        })
        .catch(() => {
          if (!controller.signal.aborted) setControl(null);
        });
    }, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [isOpen]);

  async function runCommand(action) {
    if (isBusy) return;
    setIsBusy(true);
    setError('');
    setMessage('');
    const signal = requestController.current.signal;
    try {
      if (action === 'save') {
        const saved = await saveAdvisorConfiguration(
          { allocation: Number(allocation), riskLevel, expectedRevision: configuration.revision },
          signal,
        );
        if (signal.aborted) return;
        setConfiguration(saved);
        setMessage(
          'Setup saved. Previous losses and results are retained. Start collection to use these settings.',
        );
        onSaved?.();
      } else {
        const next = await changeCollectorControl(action, signal);
        if (!signal.aborted) {
          setControl(next);
          onSaved?.();
        }
      }
    } catch (failure) {
      if (!signal.aborted) setError(failure.message);
    } finally {
      if (!signal.aborted) setIsBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline-secondary" onClick={() => setIsOpen(true)}>
        Setup
      </Button>
      <Modal
        show={isOpen}
        onHide={() => !isBusy && setIsOpen(false)}
        className="tracker-modal"
        centered
        scrollable
        aria-labelledby="advisor-setup-heading"
      >
        <Modal.Header closeButton={!isBusy}>
          <Modal.Title id="advisor-setup-heading" as="h2" className="h5">
            Paper account setup
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}
          {message && (
            <Alert variant="success" role="status">
              {message}
            </Alert>
          )}
          {isLoading ? (
            <p role="status">
              <Spinner as="span" size="sm" aria-hidden="true" /> Loading saved setup…
            </p>
          ) : (
            <>
              <h3 className="h6">1. Choose your allocation</h3>
              <p className="small text-secondary">
                Choose $1–$100 of simulated capital. Changing setup preserves your losses and
                account history. Stop collection and wait for positions and settlement comparisons
                to finish before saving.
              </p>
              <Form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (preview && configuration) runCommand('save');
                }}
              >
                <Form.Group controlId="advisor-allocation" className="mb-3">
                  <Form.Label>Paper allocation ($)</Form.Label>
                  <Form.Control
                    type="number"
                    min="1"
                    max="100"
                    step="0.01"
                    inputMode="decimal"
                    value={allocation}
                    onChange={(event) => setAllocation(event.target.value)}
                    disabled={isBusy || !configuration}
                    aria-describedby="advisor-allocation-help"
                    required
                  />
                  <Form.Text id="advisor-allocation-help">
                    This is your total allocation, not the amount to put into each trade.
                  </Form.Text>
                </Form.Group>
                <Form.Label htmlFor="advisor-risk-profile">Risk allowance</Form.Label>
                <Select
                  inputId="advisor-risk-profile"
                  instanceId="advisor-risk-profile"
                  className="schedule-select schedule-select-menu-portal mb-3"
                  unstyled
                  classNames={scheduleClassNames}
                  options={riskOptions}
                  value={riskOptions.find((item) => item.value === riskLevel)}
                  onChange={(item) => setRiskLevel(item.value)}
                  isDisabled={isBusy || !configuration}
                  isSearchable={false}
                />
                {preview && (
                  <dl className="row g-2 small mb-3">
                    {[
                      ['Cash kept aside', preview.cashReserve],
                      ['Maximum per position', preview.maxPositionCost],
                      ['Combined BTC exposure', preview.maxOpenRisk],
                      ['Drawdown stop', preview.maxDrawdown],
                    ].map(([label, value]) => (
                      <div className="col-6" key={label}>
                        <dt className="text-secondary fw-normal">{label}</dt>
                        <dd className="mb-0">{formatAdvisorMoney(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <p className="small text-secondary">
                  Actual size also depends on estimated edge, fees, depth, remaining loss capacity
                  and account value. Larger estimates do not authorize spending the entire account.
                </p>
                <Button type="submit" size="sm" disabled={isBusy || !preview || !configuration}>
                  Save allocation and risk
                </Button>
              </Form>
              <hr />
              <h3 className="h6">2. Run collection</h3>
              {hasUnsavedChanges && (
                <p className="small text-warning">
                  Save your allocation and risk settings before starting.
                </p>
              )}
              <p className="small" role="status">
                {control?.message ?? 'Collector status unavailable. Reload setup to check again.'}
              </p>
              <div className="d-flex gap-2">
                <Button
                  size="sm"
                  onClick={() => runCommand('start')}
                  disabled={
                    isBusy ||
                    !control?.canStart ||
                    configuration?.policy?.version !== 2 ||
                    hasUnsavedChanges
                  }
                >
                  Start collection
                </Button>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => runCommand('stop')}
                  disabled={isBusy || !control?.canStop}
                >
                  Stop collection
                </Button>
              </div>
              <p className="small text-secondary mt-2 mb-0">
                Save setup before starting. Collection continues while this local app server runs.
                It records forecasts, paper trades and strategy trials through the existing API rate
                limiter. No real orders are submitted.
              </p>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" disabled={isBusy} onClick={() => setIsOpen(false)}>
            Close setup
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
