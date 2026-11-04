# APIs and services

Read this when adding or moving an API endpoint, an uncached request, or an API helper.
All three belong under `src/services/`. Choose the folder by the API resource the code operates on,
even when only one feature uses it.

## Domain folders

Give each API domain its own folder. Place each subdomain directly inside its parent and apply the
same layout at each level. For example, device operations belong to `Devices/`. Operations on groups
of devices belong to its child, `DeviceGroups/`.

```text
src/services/
  Devices/
    devices.api.js
    devices.service.js
    DeviceGroups/
      deviceGroups.api.js
      deviceGroups.service.js
```

## File responsibilities

| File                  | What belongs here                                                                                      | Device group example                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `<domain>.api.js`     | RTK Query endpoint definitions for cached server data, their cache configuration, and generated hooks. | Define the query for a cached list of device groups in `deviceGroups.api.js`.                                          |
| `<domain>.service.js` | Uncached API calls and reusable API helpers, including manual cache update helpers.                    | Put a one-time group export request or a helper that applies a group update to the cache in `deviceGroups.service.js`. |

Keep each operation in the most specific domain that owns it. If a device dashboard starts showing
groups, it can use the existing group query from `Devices/DeviceGroups/deviceGroups.api.js`.
