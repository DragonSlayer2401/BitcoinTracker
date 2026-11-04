# Project folder layout

Use this standard to decide whether code belongs to the project as a whole or to a feature.

## General ownership rules

- Place project-wide components, utilities, Redux slices, and hooks in their respective global
  folders directly under `src/`.
- Choose the narrowest owner that covers a responsibility and its consumers. When several workflows
  within one domain share code, their nearest common feature owns it. For example, a location picker
  shared by Weather Alerts and Weather Forecast belongs in `Weather/components/`. A reusable dialog
  shared across independent domains belongs in `src/components/`.
- Organize all product features under `src/features/` and all APIs and API helpers by domain under
  `src/services/`. Create each folder when it has a file to hold.

## Top-level folders

| Folder            | What belongs here                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `src/components/` | UI components shared across the project, such as a general-purpose dialog.               |
| `src/utils/`      | Utility functions shared across the project, such as a general-purpose number formatter. |
| `src/state/`      | Application-wide Redux slices and store setup.                                           |
| `src/hooks/`      | React hooks shared across the project, such as a hook that reports the viewport size.    |
| `src/features/`   | All product features. [Feature structure and ownership](features.md)                     |
| `src/services/`   | APIs and API helpers organized by domain. [APIs and services](../services.md)            |
