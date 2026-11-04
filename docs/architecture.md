# Architecture and code ownership

Use this target layout when adding a feature, placing a file, or planning a refactor. A file's path
should tell a developer which part of the application owns it. Choose the narrowest owner that
covers its responsibility and the features that use it.

## Project scope

| Folder            | What belongs here                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `src/components/` | UI components shared across the project, such as a general-purpose dialog.               |
| `src/utils/`      | Utility functions shared across the project, such as a general-purpose number formatter. |
| `src/state/`      | Application-wide Redux slices and store setup.                                           |
| `src/hooks/`      | React hooks shared across the project, such as a hook that reports the viewport size.    |
| `src/features/`   | All product features. Each top-level folder represents a domain, such as `Weather/`.     |
| `src/services/`   | APIs and API helpers organized by domain. [APIs and services](services.md)               |

## Feature scope

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

Apply this standard to the requested change. Create global and feature-local folders as their first
files are added, and limit moves of existing files to the agreed scope.
