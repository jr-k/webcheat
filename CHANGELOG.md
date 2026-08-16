# Changelog

## 0.1.0 — 2026-08-16

First public release.

### Scanning
- WebAssembly memory capture via hooks on `instantiate`, `instantiateStreaming`,
  `new Instance` and `new Memory`, plus a throttled global sweep for Emscripten
  modules created before the hooks landed.
- Exact / greater / less / between / unknown-initial-value first scans.
- Narrowing: changed, unchanged, increased, decreased, increased by N, decreased by N.
- All-types scan across `i8 · i16 · i32 · i64 · f32 · f64`, each result carrying its
  own type; lanes that cannot represent the value are pruned.
- Aligned fast path over typed arrays, unaligned byte-by-byte path via `DataView`.
- Chunked and cancellable, with progress reporting.
- Aborts loudly if WASM memory grows mid-scan instead of returning a partial result.
- Result cap of 4,000,000 addresses, reported rather than silently truncated.

### Editing
- Read, write and 60 Hz freeze on any address.
- Address list with per-row type, description and live values.

### Time control
- Virtual clock rescaling `performance.now`, `Date.now`, `requestAnimationFrame`
  timestamps and timer delays.
- 0.25x-8x presets, free slider, pause and single-frame step.
- Pure pass-through until the speed is changed, so normal browsing is unaffected.

### Targeting
- Frame-level target selection for games embedded in cross-origin iframes.
- Live region polling with automatic fallback to whichever frame holds the memory.
- Every tab is listed and labelled, including tabs with no agent or discarded by Chrome.
- 1.5s probe timeout so one hung tab can no longer block target discovery.

### Diagnostics
- Live panel readout of engine, fps, clock reads, shared memory and timer activity,
  explaining why time control is or is not taking effect.

### Testing
- 33 assertions running the scan engine against a synthetic 4 MB `WebAssembly.Memory`.
