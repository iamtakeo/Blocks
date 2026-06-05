import { test, expect } from '@playwright/test';

test.describe('Blocks Sandbox E2E Tests', () => {
  test('should initialize game, place blocks, and verify physics kinematic behavior', async ({ page }) => {
    test.setTimeout(60000);
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

    // Navigate to the game URL
    await page.goto('http://localhost:5173/');

    // Log in
    await page.fill('#usernameInput', 'PlaywrightTester');
    const swatch = page.locator(".color-swatch[data-color='#8b5cf6']");
    if (await swatch.count() > 0) {
      await swatch.click();
    }
    await page.click('#joinBtn');

    // Wait for canvas to be loaded and global references to be bound
    await page.waitForFunction(() => window.game && window.game.isWorldLoaded, { timeout: 15000 });

    // Expose local assertions helper on the page to run assertions inside the WebGL context
    const testResults = await page.evaluate(async () => {
      const game = window.game;
      const multiplayer = window.multiplayer;
      if (!game) return { success: false, error: "Game instance not found" };

      // 1. Verify Sky Dome
      const sky = game.scene.getMeshByName("skySphere");
      if (!sky) return { success: false, error: "Sky dome mesh 'skySphere' not found" };
      if (sky.infiniteDistance !== true) return { success: false, error: "Sky dome infiniteDistance is not true" };
      if (sky.isPickable !== false) return { success: false, error: "Sky dome isPickable is not false" };
      if (!sky.material || sky.material.disableLighting !== true) return { success: false, error: "Sky dome material lighting is not disabled" };
      if (sky.material.backFaceCulling !== true) return { success: false, error: "Sky dome material backFaceCulling is not true" };
      if (sky.material.disableDepthWrite !== true) return { success: false, error: "Sky dome material disableDepthWrite is not true" };

      // 2. Verify Voxel Meshing and Instancing
      const meshes = game.scene.meshes;
      const templateMeshesCount = meshes.filter(m => m.name.startsWith("template_")).length;
      if (templateMeshesCount !== 10) {
        return { success: false, error: `Expected 10 template meshes, found ${templateMeshesCount}` };
      }

      const templates = meshes.filter(m => m.name.startsWith("template_"));
      for (const t of templates) {
        if (t.isVisible || t.checkCollisions || t.isPickable) {
          return { success: false, error: `Template mesh ${t.name} has incorrect collision/visibility/picking properties` };
        }
      }

      const chunkMeshes = meshes.filter(m => m.name.startsWith("chunk_"));
      if (chunkMeshes.length === 0) {
        return { success: false, error: "No chunk meshes found in the scene" };
      }
      for (const cm of chunkMeshes) {
        if (cm.checkCollisions !== false) {
          return { success: false, error: `Chunk mesh ${cm.name} checkCollisions is not false` };
        }
      }

      // 3. Flower Culling Check: alwaysSelectAsActiveMesh should not be true
      const flowerInstances = meshes.filter(m => m.name.startsWith("flower_") && m.isAnInstance);
      for (const inst of flowerInstances) {
        if (inst.alwaysSelectAsActiveMesh === true) {
          return { success: false, error: `Flower instance mesh ${inst.name} has alwaysSelectAsActiveMesh === true, expected false or undefined to enable frustum culling` };
        }
      }

      // 4. Place and verify blocks
      game.teleportPlayer(4, 6.6, 0, -Math.PI / 2);
      await new Promise(r => setTimeout(r, 150)); // Allow player position tick to sync to server

      multiplayer.sendBlockChange(4, 0, 0, "stone");
      multiplayer.sendBlockChange(4, 1, 0, "stone");
      multiplayer.sendBlockChange(4, 2, 0, "stone");
      multiplayer.sendBlockChange(4, 3, 0, "dirt");
      multiplayer.sendBlockChange(4, 4, 0, "grass");

      // Give a brief moment to apply blocks locally
      await new Promise(r => setTimeout(r, 100));

      const b0 = game.getBlockId(4, 0, 0);
      const b4 = game.getBlockId(4, 4, 0);
      if (b0 !== 4 || b4 !== 1) {
        return { success: false, error: `Placed block verification failed: block at (4,0,0) is ${b0}, (4,4,0) is ${b4}` };
      }

      // 5. Jump Trajectory and Double-Jump Prevention
      game.teleportPlayer(4, 6.6, 0, -Math.PI / 2);
      await new Promise(r => setTimeout(r, 100));

      const startY = game.camera.position.y;
      
      // Trigger Jump
      game._onKeyDown(new KeyboardEvent("keydown", { code: "Space" }));

      const heights = [];
      for (let i = 0; i < 24; i++) {
        game.scene.render();
        game.scene.render();
        game.scene.render();

        const curY = game.camera.position.y;
        heights.push(curY);

        if (i === 4) {
          // Attempt double jump mid-flight
          game._onKeyDown(new KeyboardEvent("keydown", { code: "Space" }));
        }

        await new Promise(r => setTimeout(r, 50));
      }

      const peakY = Math.max(...heights);
      const finalY = heights[heights.length - 1];

      // Jump verification
      if (peakY <= startY + 0.15) {
        return { success: false, error: `Jump did not register height gain (Start Y: ${startY}, Peak Y: ${peakY})` };
      }
      if (finalY >= peakY - 0.1) {
        return { success: false, error: `Player did not descend after reaching apex (Peak Y: ${peakY}, Final Y: ${finalY})` };
      }
      if (peakY > startY + 4.5) {
        return { success: false, error: `Double jump detected: Jump height exceeded single jump limit (Start Y: ${startY}, Peak Y: ${peakY})` };
      }

      return { success: true };
    });

    if (!testResults.success) {
      console.error("BLOCKS TEST FAILURE ERROR DETAILS:", testResults.error);
    }
    expect(testResults.success).toBe(true);
  });
});
