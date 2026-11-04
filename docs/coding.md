# Coding standards

Read this when writing or reviewing functions, naming values, or choosing a filename.

## Functions

Write all functions as arrow functions. Give named functions a `const` binding. Use arrow syntax
for exported helpers, React components, event handlers, test callbacks, and asynchronous functions.
Name a function for the action it performs or the value it returns.

```js
const getDeviceNameMap = (devices) =>
  new Map(devices.map((deviceObj) => [deviceObj.id, deviceObj.name]));

const deviceNameMap = getDeviceNameMap(devices);
```

## Names

Use camelCase for variables, parameters, constants, and functions. Use `UPPER_SNAKE_CASE` for variables
that hold configuration values in config files. Choose plain domain words that
tell the reader exactly what a value represents. Use `deviceResponse` for an HTTP response,
`deviceObj` for the device object returned by the API, and `deviceName` for the name string.
Use `deviceNameMap` for a lookup from device IDs to names. Names such as `data`, `result`, or
`map` lose those distinctions. Name booleans as statements that can be true or false, such as
`isDeviceOnline`.

## Casing in files and folders

| Use                                                     | Convention                                       | Example                             |
| ------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| Ordinary source filenames                               | camelCase base name, retaining any role suffix   | `deviceGroups.service.js`           |
| Project-defined config filenames                        | camelCase base name followed by `.config.js`     | `deviceStatus.config.js`            |
| Feature and API domain folders                          | PascalCase                                       | `WeatherAlerts/`, `DeviceGroups/`   |
| React component filenames and JSX component identifiers | PascalCase                                       | `AlertList.jsx` exports `AlertList` |
| Test filenames                                          | PascalCase base name followed by the test suffix | `CreateAlert.test.jsx`              |

For example, `deviceStatus.config.js` can declare a configuration variable as
`export const DEVICE_POLL_INTERVAL_MS = 5000;`. Keep exact filenames and keys that an external
tool or API requires.
