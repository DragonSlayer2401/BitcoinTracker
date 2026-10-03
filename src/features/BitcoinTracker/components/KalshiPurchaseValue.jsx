import { useId, useState } from 'react';
import { Button, Form, Table } from 'react-bootstrap';
import Select from 'react-select';
import { useGetKalshiPurchaseValueQuery } from '../../../services/kalshi/purchaseValue/purchaseValue.api';
import { formatPercent, formatTime } from '../utils/format.utils';
import {
  getKalshiPurchaseValue,
  MAXIMUM_PURCHASE_CONTRACTS,
} from '../utils/kalshi/purchaseValue.utils';
import { scheduleClassNames } from './KalshiEventControl';

const accountOptions = [
  { value: 'unknown', label: 'Choose account type' },
  { value: 'direct', label: 'Using Kalshi directly' },
  { value: 'intermediary', label: 'Using a broker / intermediary' },
];
const money = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(value)
    : '—';

/** Mount only when the optional comparison is open; no quotes poll in the background. */
export default function KalshiPurchaseValue({ contract, aboveProbability, now }) {
  const id = useId();
  const [contractInput, setContractInput] = useState('1');
  const [accountType, setAccountType] = useState('unknown');
  const canQuery = Boolean(
    contract?.ticker && now >= contract.startsAt && now < contract.expiresAt,
  );
  const {
    currentData: book,
    isFetching,
    isError,
    refetch,
  } = useGetKalshiPurchaseValueQuery(contract?.ticker, {
    skip: !canQuery,
    pollingInterval: 10_000,
    skipPollingIfUnfocused: true,
    refetchOnMountOrArgChange: true,
  });
  const value = getKalshiPurchaseValue({
    book: isError ? null : book,
    contract,
    aboveProbability,
    contracts: /^\d+$/.test(contractInput) ? Number(contractInput) : NaN,
    accountType,
    now,
  });
  const rows = value.available
    ? [
        ['Live model chance', (side) => formatPercent(side.probability)],
        ['Best displayed ask', (side) => money(side.bestAsk)],
        ['Contracts covered', (side) => `${side.filledQuantity} / ${value.contracts}`],
        ['Average purchase price', (side) => money(side.averageAsk)],
        ['Purchase cost before fees', (side) => money(side.cost)],
        ['Estimated exchange fee', (side) => money(side.exchangeFee)],
        ['Expected value before fees', (side) => money(side.grossExpectedValue)],
        ['Expected value after fees', (side) => money(side.netExpectedValue)],
        ['Break-even win chance', (side) => formatPercent(side.breakEvenProbability)],
        ['Profit if it wins', (side) => money(side.profitIfWins)],
        ['Loss if it loses', (side) => money(side.maximumLoss)],
      ]
    : [];

  return (
    <section className="mt-3" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="h6">
        Purchase value at displayed asks
      </h3>
      <p className="small text-secondary">
        Compare the live model with buying Yes or No and holding to settlement. Expected value is
        model chance × contracts − purchase cost − fees. It depends on the model being right; a
        positive estimate is not a guaranteed profit or a validated edge.
      </p>
      <div className="d-flex flex-wrap align-items-end gap-3 mb-3">
        <Form.Group controlId={`${id}-contracts`}>
          <Form.Label className="small">Contracts to compare</Form.Label>
          <Form.Control
            type="number"
            min="1"
            max={MAXIMUM_PURCHASE_CONTRACTS}
            step="1"
            value={contractInput}
            onChange={(event) => setContractInput(event.target.value)}
          />
        </Form.Group>
        <div className="flex-grow-1">
          <Form.Label htmlFor={`${id}-account`} className="small">
            Account fee basis
          </Form.Label>
          <Select
            inputId={`${id}-account`}
            instanceId={`${id}-account-select`}
            unstyled
            className="schedule-select schedule-select-menu-portal"
            classNames={scheduleClassNames}
            options={accountOptions}
            menuPlacement="auto"
            value={accountOptions.find((option) => option.value === accountType)}
            onChange={(option) => setAccountType(option.value)}
            isSearchable={false}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline-secondary"
          disabled={!canQuery || isFetching}
          onClick={() => refetch()}
        >
          {isFetching ? 'Refreshing prices…' : 'Refresh prices'}
        </Button>
      </div>
      {value.available ? (
        <>
          <Table responsive size="sm" className="small align-middle">
            <caption className="caption-top">
              One hypothetical order · book received {formatTime(value.receivedAt)}
            </caption>
            <thead>
              <tr>
                <th scope="col">Comparison</th>
                <th scope="col">Buy Yes</th>
                <th scope="col">Buy No</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, render]) => (
                <tr key={label}>
                  <th scope="row" className="fw-normal">
                    {label}
                  </th>
                  <td>{render(value.yes)}</td>
                  <td>{render(value.no)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {(!value.yes.isFullyCovered || !value.no.isFullyCovered) && (
            <p className="small text-warning">
              Insufficient displayed depth for the full quantity on at least one side. Its cost
              covers only the shown contracts; expected value and break-even are unavailable for
              that side.
            </p>
          )}
          {value.feeReason && <p className="small text-secondary">{value.feeReason}</p>}
        </>
      ) : (
        <p className="small" role="status">
          {isError ? 'Purchase prices could not be refreshed. Try again shortly.' : value.reason}
        </p>
      )}
      <p className="small text-secondary mb-0">
        Asks come from the opposite side’s bids and include up to 100 price levels. Depth can change
        before a fill. Fees assume one taker order with the displayed price-level fills and
        accumulated rounding; actual fills and broker charges can differ. Direct-member balances
        round to $0.0001; intermediary balances round to $0.01. No order is placed here.{' '}
        <a
          href="https://docs.kalshi.com/getting_started/fee_rounding"
          target="_blank"
          rel="noreferrer"
        >
          Fee rounding
        </a>
        {' · '}
        <a href="https://kalshi.com/docs/kalshi-fee-schedule.pdf" target="_blank" rel="noreferrer">
          Fee schedule
        </a>
      </p>
    </section>
  );
}
