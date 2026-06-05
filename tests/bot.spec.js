import { test, expect } from '@playwright/test';

test.describe('Blocks Bot Navigation E2E Tests', () => {
  test('should navigate bot forward, right, and jump, showing progressive movement', async ({ page }) => {
    test.setTimeout(60000);
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

    // Navigate to the game URL
    await page.goto('http://localhost:5173/');

    // Log in
    await page.fill('#usernameInput', 'PlaywrightBot');
    const swatch = page.locator(".color-swatch[data-color='#ec4899']");
    if (await swatch.count() > 0) {
      await swatch.click();
    }
    await page.click('#joinBtn');

    // Wait for canvas to be loaded and global references to be bound
    await page.waitForFunction(() => window.game && window.game.isWorldLoaded, { timeout: 15000 });

    // Focus on canvas
    await page.focus('#gameCanvas');

    // Expose keys trigger function
    await page.exposeFunction('triggerPlaywrightKey', async (type, code) => {
      let keyName = code;
      if (code.startsWith('Key')) {
        keyName = code.substring(3).toLowerCase();
      } else if (code === 'Space') {
        keyName = ' ';
      }
      if (type === 'keydown') {
        await page.keyboard.down(keyName);
      } else if (type === 'keyup') {
        await page.keyboard.up(keyName);
      }
    });

    // Teleport to starting location
    await page.evaluate(() => {
      window.game.teleportPlayer(0, 6.6, -4, 0);
    });

    let previousZ = -4.0;
    let previousX = 0.0;
    let hasMovedForward = false;
    let hasMovedRight = false;
    let hasJumped = false;

    // Simulate W key press to move forward
    await page.keyboard.down('w');
    
    // Check progress periodically
    for (let step = 0; step < 15; step++) {
      // Wait a bit
      await page.waitForTimeout(200);

      // Perform a jump around step 4
      if (step === 4) {
        await page.keyboard.down('Space');
        await page.waitForTimeout(100);
        await page.keyboard.up('Space');
      }

      // Check current position
      const status = await page.evaluate(() => {
        const g = window.game;
        if (!g || !g.camera) return null;
        return {
          x: g.camera.position.x,
          y: g.camera.position.y,
          z: g.camera.position.z,
          grounded: g.isPlayerGrounded(),
          vVel: g.verticalVelocity
        };
      });

      if (status) {
        if (status.z > previousZ + 0.1) hasMovedForward = true;
        if (!status.grounded && status.vVel > 0.05) hasJumped = true;
        previousZ = status.z;
      }
    }

    // Release W key
    await page.keyboard.up('w');

    // Simulate D key press to move right
    await page.keyboard.down('d');

    for (let step = 0; step < 10; step++) {
      await page.waitForTimeout(200);
      const status = await page.evaluate(() => {
        const g = window.game;
        if (!g || !g.camera) return null;
        return {
          x: g.camera.position.x,
          y: g.camera.position.y,
          z: g.camera.position.z
        };
      });

      if (status) {
        if (status.x > previousX + 0.1) hasMovedRight = true;
        previousX = status.x;
      }
    }

    // Release D key
    await page.keyboard.up('d');

    console.log(`Bot Navigation Test Results - Forward: ${hasMovedForward}, Right: ${hasMovedRight}, Jump: ${hasJumped}`);
    expect(hasMovedForward).toBe(true);
    expect(hasMovedRight).toBe(true);
    expect(hasJumped).toBe(true);
  });
});
