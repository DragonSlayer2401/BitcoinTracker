# Feature structure and ownership

Read this when adding a feature, defining a sub-feature, or choosing where shared feature code belongs.
Each top-level folder under `src/features/` represents a domain, such as `Weather/`.

## Feature layout

The same layout applies at **every depth**. A feature can own `components/` for UI, `hooks/` for
React behavior, `utils/` for helpers, `state/` for Redux state, and `assets/` for files such as
images. Its `features/` folder holds child features. Create each folder when it has content.

For example, a Weather domain could have this layout. The filenames illustrate ownership.

```text
src/features/Weather/
  components/WeatherLocationPicker.jsx
  features/
    WeatherAlerts/
      utils/alertSeverity.utils.js
      features/
        AlertCreator/
          state/alertDraftSlice.js
        AlertList/
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
