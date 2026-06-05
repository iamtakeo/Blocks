import { test, expect } from '@playwright/test';

test.describe('Blocks Chunk Mesh Winding Tests', () => {
  test('should verify all chunk mesh triangles have winding normals matching vertex normals', async ({ page }) => {
    test.setTimeout(60000);
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

    // Navigate to the game
    await page.goto('http://localhost:5173/');

    // Log in
    await page.fill('#usernameInput', 'WindingTester');
    const swatch = page.locator(".color-swatch[data-color='#8b5cf6']");
    if (await swatch.count() > 0) {
      await swatch.click();
    }
    await page.click('#joinBtn');

    // Wait for world load
    await page.waitForFunction(() => window.game && window.game.isWorldLoaded, { timeout: 15000 });

    // Run geometric winding assertions inside WebGL context
    const testResults = await page.evaluate(() => {
      const game = window.game;
      if (!game) return { success: false, error: "Game instance not found" };

      const chunkMeshes = game.scene.meshes.filter(m => m.name.startsWith("chunk_"));
      if (chunkMeshes.length === 0) {
        return { success: false, error: "No chunk meshes found in the scene" };
      }

      const windingErrors = [];

      for (const cm of chunkMeshes) {
        const positions = cm.getVerticesData("position");
        const indices = cm.getIndices();
        const normals = cm.getVerticesData("normal");

        if (!positions || !indices || !normals) continue;

        for (let t = 0; t < indices.length; t += 3) {
          const i0 = indices[t];
          const i1 = indices[t + 1];
          const i2 = indices[t + 2];

          // Vertex positions
          const v1 = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
          const v2 = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
          const v3 = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];

          // Vertex normals
          const n1 = [normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2]];
          const n2 = [normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2]];
          const n3 = [normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]];

          // Edge vectors
          const edge1 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
          const edge2 = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]];

          // Winding normal (cross product edge1 x edge2)
          const cross = [
            edge1[1] * edge2[2] - edge1[2] * edge2[1],
            edge1[2] * edge2[0] - edge1[0] * edge2[2],
            edge1[0] * edge2[1] - edge1[1] * edge2[0]
          ];

          // Average normal
          const avgN = [
            (n1[0] + n2[0] + n3[0]) / 3,
            (n1[1] + n2[1] + n3[1]) / 3,
            (n1[2] + n2[2] + n3[2]) / 3
          ];

          // Dot product
          const dot = cross[0] * avgN[0] + cross[1] * avgN[1] + cross[2] * avgN[2];

          if (dot <= 0.0001) {
            windingErrors.push({
              mesh: cm.name,
              triangleIndex: t / 3,
              v1, v2, v3,
              normal: avgN,
              cross,
              dot
            });
          }
        }
      }

      if (windingErrors.length > 0) {
        return {
          success: false,
          error: `Found ${windingErrors.length} triangles with incorrect winding order (culled). Examples: ` +
            JSON.stringify(windingErrors.slice(0, 3), null, 2)
        };
      }

      return { success: true };
    });

    if (!testResults.success) {
      console.error("Winding Test Failure Details:", testResults.error);
    }
    expect(testResults.success).toBe(true);
  });
});
