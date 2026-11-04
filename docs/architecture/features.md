# Feature structure and ownership

Read this when adding a feature, defining a sub-feature, or choosing where shared feature code belongs.
Each top-level folder under `src/features/` represents a domain, such as `Weather/`.

## Feature layout

The same layout applies at **every depth**. A feature can own `components/` for UI, `hooks/` for
React behavior, `utils/` for helpers, and `state/` for Redux state. Place feature SCSS files directly
in `assets/` and images in `assets/images/`. A feature's `features/` folder holds its child features.
Create each folder when it has content.

### Feature assembly files

Use what the page renders to decide which features need an assembly file. The file lives at the
root of the feature folder, uses the folder's PascalCase name, and exports the component that
brings the feature's UI together.

- **Separate pages.** If one page shows the alert list and another shows the alert creator, each
  page renders its own feature through `AlertList.jsx` or `AlertCreator.jsx`. In this layout,
  `WeatherAlerts/` groups the two workflows and their shared utilities.
- **Same page.** If a page shows the list and creator together, add
  `WeatherAlerts/WeatherAlerts.jsx` to render `AlertList` and `AlertCreator` together. The page
  renders `WeatherAlerts`.

The separate-page example has this layout.

```text
src/features/Weather/
  components/WeatherLocationPicker.jsx
  features/
    WeatherAlerts/
      utils/alertSeverity.utils.js
      features/
        AlertCreator/
          AlertCreator.jsx
          state/alertDraftSlice.js
        AlertList/
          AlertList.jsx
          assets/
            alertList.scss
            images/stormWarning.svg
          components/AlertRow.jsx
    WeatherForecast/
      components/ForecastSummary.jsx
```

An alert draft used only by the creator belongs under `AlertCreator/state/`. If the creator and
list both use the same severity rules, their nearest shared owner is `WeatherAlerts/utils/`.
If alerts and forecasts both use the location picker, its owner is `Weather/components/`.
The same reasoning applies to hooks and assets at any depth.

## Choosing an owner

1. Trace the consumers and identify the responsibility they share. Keep a reusable UI piece in
   `components/`. Give a distinct workflow, such as creating an alert, its own child under `features/`.
2. Start with the feature doing the work. When sibling features share an implementation, place it
   at their nearest common parent. Use a global folder when the responsibility applies across
   independent top-level features. Keep domain rules with the domain that defines them.
3. Place each Redux slice with the owner of its state. For example, the application store can
   register the alert draft reducer while the slice lives in `AlertCreator/state/`.

Apply this standard to the requested change. Limit moves of existing files to the agreed scope.

## Dashboard domains

The [home route](../../src/app/page.jsx) renders a [client dashboard](../../src/app/_dashboard/TradingDashboard.jsx)
that shares the clock and market observations across four domains.

- [MarketData](../../src/features/MarketData) selects the current and requested contracts, subscribes
  to feeds, and displays prices and diagnostics. Its PriceChart feature owns the chart controls,
  indicators, and drawings. Exchange requests and stream adapters live under `src/services/`.
- [Forecasting](../../src/features/Forecasting) owns live estimates, checkpoint recording,
  scheduling, settlement, and the saved forecast journal. The application store registers its
  reducer at `state.tracker`. Closing the research dialog leaves recording and settlement running.
- [ForecastResearch](../../src/features/ForecastResearch) owns evidence collection, replay, model
  evaluation, and pattern studies. Its ResearchData feature presents research reports and exports.
- [SimulatedTrading](../../src/features/SimulatedTrading) owns the PaperTrading and TradingAdvisor
  workflows. Advisor experiment rules live with TradingAdvisor. Account persistence and provider
  calls live under `src/services/research/`.
