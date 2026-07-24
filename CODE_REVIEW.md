# Code Review Notes

## What improved

- Replaced the fragile Unicode power glyph with an inline SVG power icon so browser rendering is consistent.
- Switched mobile zone icon editing to a bottom-sheet picker, which is more reliable on touch devices.
- Added serial-open timeout protection so API calls fail cleanly with HTTP 503 when the USB serial device is unavailable.
- Added reconciliation polling to keep zone state aligned with external keypad changes.
- Suppressed no-op volume writes so unchanged slider values do not generate unnecessary serial traffic.
- Preserved per-zone auto-off behavior, including Zone 6 defaulting to 120 minutes.

## Recommended next steps

1. Add websocket or Server-Sent Events updates so the frontend can receive state changes immediately instead of polling.
2. Harden `parseZoneStatus()` against firmware variations by making field parsing more explicit per protocol revision.
3. Split the frontend into smaller modules or add a lightweight build step if the UI keeps growing.
4. Add API validation for zone numbers and payload ranges such as volume/source bounds.
5. Add a small integration test harness that replays captured serial responses from the amplifier.
6. Persist last-known live zone state separately from user config so diagnostics are easier.
