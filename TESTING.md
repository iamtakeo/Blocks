# Testing & Regression Prevention Guide

This document outlines the testing architecture, E2E test execution flow, constraints, and regression prevention rules for the Blocks sandbox environment.

---

## 1. Overview of the Testing Suite

The testing suite verifies the integrity of the 3D graphics rendering (BabylonJS), physics simulation, multiplayer synchronization (PartyKit / WebSockets), and user input handlers.

Tests are located under the `tests/` directory:
- **`tests/blocks.spec.js`**: Validates the core sandbox initialization, sky dome rendering parameters, voxel meshing, instanced rendering culling, block placements, and player physics (jump trajectory and double-jump prevention).
- **`tests/bot.spec.js`**: Simulates automated bot navigation (moving forward, right, jumping) to ensure progressive movement works without physics glitching.

---

## 2. Environment Setup & Execution

Since the E2E tests run in a real browser context using Playwright, you must have the local application services running before executing tests.

### Step 1: Start the Multiplayer Backend
The backend runs on PartyKit, managing player connections, room state, and SQLite persistence.
```bash
npm run party-dev
```
*Default port: `http://localhost:1999`*

### Step 2: Start the Frontend Dev Server
The frontend is compiled and served via Vite.
```bash
npm run dev
```
*Default port: `http://localhost:5173`*

### Step 3: Execute Playwright E2E Tests
Run the test suite sequentially:
```bash
npm run test
```

---

## 3. Worker Limit Constraints (`--workers=1`)

In `package.json`, the test script is configured to limit concurrency:
```json
"test": "playwright test --workers=1"
```

> [!IMPORTANT]  
> **You must never increase the worker count beyond 1.** Parallelizing tests in this environment will lead to catastrophic failures due to the following system constraints:

### A. WebGL/GPU Driver Stalls (Headless Contexts)
* **Resource Limits:** In headless CI and local environments, browsers rely on software rasterizers (e.g., SwiftShader) to emulate WebGL. Spawning multiple browser instances in parallel forces the CPU/GPU to allocate multiple concurrent WebGL context drivers.
* **Failure Modes:** Exceeding local GPU constraints causes `WebGL context lost` exceptions, shader compilation stalls, massive frame rate drops, and test timeouts. Limiting execution to a single worker ensures only one WebGL canvas is initialized at any given time.

### B. SQLite Write-Locks and DB Contention
* **Durable Object SQLite Storage:** The local PartyKit server persists voxel modifications to a local SQLite database using Cloudflare Durable Objects APIs. 
* **Write Contention:** Because SQLite enforces serialized single-writer database locks, concurrent tests writing updates (e.g., block placements) will trigger `SQLITE_BUSY` lock contention errors, leading to query failures and database corruption.

### C. Shared State & Room Concurrency
* **Namespace Collision:** Both E2E tests connect to the same default room at `http://localhost:5173/`. 
* **Race Conditions:** Running tests concurrently causes players to join the same room. A test modifying blocks at a specific voxel coordinate will conflict with another test attempting to read or assert state at those exact coordinates, causing flaky failures.

---

## 4. Test Suite Analysis & Assertions

### `tests/blocks.spec.js`
This file tests the integrity of the WebGL rendering engine and core physics engine.

1. **Sky Dome Configuration:**
   * Checks that the `skySphere` mesh is set to `infiniteDistance = true` (keeps the sky centered on the camera).
   * Verifies `isPickable = false` so users cannot click on or interact with the sky.
   * Asserts material rendering properties: `disableLighting = true`, `backFaceCulling = true`, and `disableDepthWrite = true` to optimize rendering pipelines.
2. **Voxel Templates & Instancing:**
   * Verifies the creation of exactly `10` template meshes (representing the 10 block types).
   * Confirms templates are metadata-only: `isVisible`, `checkCollisions`, and `isPickable` are all `false`.
   * Asserts `checkCollisions = false` on chunk meshes (custom voxel AABB queries handle collision resolution instead of the heavy default BabylonJS mesh collider).
3. **Flower Frustum Culling:**
   * Verifies that `alwaysSelectAsActiveMesh` is `false` or `undefined` on all `flower_` instance meshes. This ensures BabylonJS frustum culling remains active, keeping performance stable in dense areas.
4. **Block Placement Verification:**
   * Places blocks at a coordinate column (X=4, Z=0) and verifies that reading `getBlockId` locally after `100ms` returns the correct material IDs (`stone` = 4, `grass` = 1).
5. **Jump Trajectory & Double-Jump Prevention:**
   * Teleports player to height `Y = 6.6`, triggers a jump (`Space` keydown), and monitors camera positions over 24 ticks (each rendering 3 frames).
   * Verifies height gain: `peakY > startY + 0.15`.
   * Verifies descent: `finalY < peakY - 0.1`.
   * Verifies double-jump prevention: Attempts another jump mid-air (at step 4) and asserts that the maximum altitude `peakY` does not exceed `startY + 4.5` (a single-jump limit threshold).

### `tests/bot.spec.js`
This file tests navigation, gravity, and progressive movement mechanics.

1. **Movement Progression:**
   * Simulates continuous keyboard holding (`w` key) and validates that the player moves forward progressively (`status.z > previousZ + 0.1`).
   * Simulates lateral keyboard holding (`d` key) and validates lateral movement progression (`status.x > previousX + 0.1`).
2. **Mid-Flight Gravity Mechanics:**
   * Simulates a `Space` jump command during forward navigation and validates gravity flight conditions via `!status.grounded && status.vVel > 0.05`.

---

## 5. Regression Prevention Rules

To keep physics, graphics rendering, and networking stable, strictly adhere to these rules when making changes:

### Physics & Trajectory Changes
* Any changes to jump velocity, player gravity, or client-side coordinate ticking must be validated against the jump height assertion in `blocks.spec.js` (`peakY <= startY + 4.5`).
* If changing default scale or speed coefficients, update physics thresholds inside `tests/blocks.spec.js` and `tests/bot.spec.js` to prevent false test failures.

### BabylonJS Rendering Optimizations
* **Frustum Culling:** When introducing new instanced details (like grass blades, stones, or props), do not set `alwaysSelectAsActiveMesh = true` as this will disable frustum culling and degrade CPU/GPU efficiency.
* **Collision Overhead:** Never enable collision flags on the main chunk meshes. BabylonJS default collision calculations must be disabled (`checkCollisions = false` on all meshes matching `chunk_*`) to prevent rendering lag.

### Multiplayer Sync and State Isolation
* If tests are updated to write persistent changes to the database, ensure they cleanup after themselves or write to isolated room namespaces to prevent state leakage between runs.
* Do not bypass login flows. Always wait for the global handle `window.game && window.game.isWorldLoaded` before invoking WebGL queries or physics evaluations.
