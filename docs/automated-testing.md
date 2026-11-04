# Automated feature tests

Read this when writing, moving, or reviewing an automated test. Each suite exercises one feature
through its normal user entry point. Its components, hooks, utilities, and Redux state run together
as the user completes a workflow.

## Where tests live

Keep the primary domain folder, such as `Weather/`, free of tests. The first child features, such
as `WeatherAlerts/` and `WeatherForecast/`, usually own separate `__tests__/` folders. Use exactly
two underscores on each side of `tests`.

Within each `__tests__/`, name a folder after each sub-feature under test. The folder holding
`__tests__/` groups related suites. Each suite exercises its named sub-feature independently.
Apply this layout further down the tree when a nested feature has child workflows of its own to test.

```text
src/features/Weather/features/
  WeatherAlerts/
    __tests__/
      helpers/
        buildTestAlert.js
      AlertCreator/
        CreateAlert.test.jsx
        EditDraft.test.jsx
        setup.js
        helpers/
          fillAlertForm.js
      AlertList/
        FilterAlerts.test.jsx
  WeatherForecast/
    __tests__/
      ForecastSearch/
        SearchByLocation.test.jsx
```

Keep a workflow's test files and optional setup file together. A helper used by one suite belongs
in that suite's `helpers/` folder, such as `AlertCreator/helpers/fillAlertForm.js`. When sibling
suites share a helper, place it directly under `__tests__/helpers/`. For example, both
`AlertCreator` and `AlertList` can use `WeatherAlerts/__tests__/helpers/buildTestAlert.js`.
Create either folder only when it has a helper to hold.

## What to test

- Start from a task the user can complete. Render the feature with the providers it needs and
  interact with it through named buttons, labeled fields, and other visible controls.
- Exercise the real feature code, including validation, formatting, and state updates. When the
  workflow needs an external dependency, control that boundary, such as the API response.
- Assert what the user sees or can do next. For example, in `AlertCreator`, submit a draft with a
  missing title, check the validation message, enter a title, submit again, and check the success
  confirmation. This covers validation and draft state through the same workflow.
- Give `AlertList` its own scenario. Start with alerts of different severities, select a severity
  filter, and verify which alerts remain visible. The test should still pass if the list's internal
  components or filtering utility are reorganized while that behavior stays the same.
