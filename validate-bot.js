import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

async function run() {
  console.log("Connecting to Chrome...");
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: { width: 1280, height: 720 }
  });

  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.stack || err.toString()));

  // Close all other tabs to prevent backgrounding and requestAnimationFrame throttling
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      if (p !== page) {
        await p.close();
      }
    }
  } catch (e) {
    console.warn("Failed to close other pages:", e);
  }

  await page.bringToFront();
  console.log("Navigating to http://localhost:5173/ ...");
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' });

  // Setup download behavior to save recorded webm gameplay locally first
  const downloadPath = path.join(process.cwd(), 'downloads');
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }
  console.log(`Setting download path to: ${downloadPath}`);
  
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath
  });

  console.log("Exposing triggerPuppeteerKey...");
  await page.exposeFunction('triggerPuppeteerKey', async (type, code) => {
    let keyName = code;
    if (code.startsWith('Key')) {
      keyName = code.substring(3).toLowerCase();
    } else if (code === 'Space') {
      keyName = ' ';
    }
    try {
      if (type === 'keydown') {
        await page.keyboard.down(keyName);
      } else if (type === 'keyup') {
        await page.keyboard.up(keyName);
      }
    } catch (e) {
      console.warn(`Failed to trigger key ${type} ${keyName}:`, e);
    }
  });

  console.log("Focusing canvas...");
  await page.focus('#gameCanvas');

  console.log("Waiting for BlocksAutomation API...");
  await page.waitForFunction(() => typeof window.BlocksAutomation !== 'undefined', { timeout: 10000 });

  console.log("Running scenario: navigate_world");
  await page.evaluate(() => {
    window.BlocksAutomation.runDemo("navigate_world");
  });

  console.log("Scenario started. Capturing screenshots and monitoring progress...");
  const targetDir = process.cwd();
  
  let step = 1;
  let previousZ = null;
  let previousX = null;
  let hasMovedForward = false;
  let hasMovedRight = false;
  let hasJumped = false;

  let lastLogTime = Date.now();

  // Poll until automation finishes
  while (true) {
    const isRunning = await page.evaluate(() => window.BlocksAutomation && window.BlocksAutomation.isRunning);
    if (step > 1 && !isRunning) break;

    const status = await page.evaluate(() => {
      const g = window.BlocksAutomation?.game;
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
      if (previousZ !== null && status.z > previousZ + 0.05) hasMovedForward = true;
      if (previousX !== null && status.x > previousX + 0.05) hasMovedRight = true;
      if (!status.grounded && status.vVel > 0.1) hasJumped = true;
      
      previousZ = status.z;
      previousX = status.x;

      const now = Date.now();
      if (now - lastLogTime >= 1000) {
        console.log(`[Step ${step}] Player state:`, status);
        const screenshotPath = path.join(targetDir, `screenshot-step-${step}.png`);
        await page.screenshot({ path: screenshotPath });
        console.log(`Saved screenshot ${step} to: ${screenshotPath}`);
        step++;
        lastLogTime = now;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log(`Validation Results - Forward: ${hasMovedForward}, Right: ${hasMovedRight}, Jump: ${hasJumped}`);
  if (!hasMovedForward || !hasMovedRight || !hasJumped) {
    console.error("ASSERTION FAILURE: Bot did not make the expected progress.");
    process.exit(1);
  } else {
    console.log("ASSERTIONS PASSED SUCCESSFULLY!");
  }

  console.log("Checking for downloaded files in: ", downloadPath);
  const files = fs.readdirSync(downloadPath);
  const videoFiles = files.filter(f => f.startsWith('blocks-gameplay-') && f.endsWith('.webm'));
  
  if (videoFiles.length > 0) {
    console.log("Validation SUCCESS: Video recording downloaded.");
    const latestFile = videoFiles.sort().reverse()[0];
    const sourceFilePath = path.join(downloadPath, latestFile);
    
    // Copy the file to the current directory
    const targetDir = process.cwd();
    const targetFilePath = path.join(targetDir, latestFile);
    fs.copyFileSync(sourceFilePath, targetFilePath);
    console.log(`Copied video to folder: ${targetFilePath}`);
    
    // Convert targetFilePath (webm) to mp4
    const ffmpegPath = 'C:\\Users\\Craig\\AppData\\Local\\Temp\\ffmpeg.exe';
    if (fs.existsSync(ffmpegPath)) {
      const mp4FilePath = targetFilePath.replace('.webm', '.mp4');
      console.log(`Converting webm video to mp4: ${mp4FilePath}`);
      try {
        const { execSync } = await import('child_process');
        execSync(`"${ffmpegPath}" -y -i "${targetFilePath}" -c:v libx264 -pix_fmt yuv420p -profile:v high -level:v 4.0 -c:a aac -b:a 128k "${mp4FilePath}"`, { stdio: 'ignore' });
        console.log(`Conversion successful! Saved to: ${mp4FilePath}`);
        console.log(`LATEST_VIDEO_FILE: ${mp4FilePath}`);
        // Clean up the webm file in target folder
        fs.unlinkSync(targetFilePath);
      } catch (e) {
        console.error("Failed to convert webm to mp4:", e);
        console.log(`LATEST_VIDEO_FILE: ${targetFilePath}`);
      }
    } else {
      console.warn("ffmpeg.exe not found at C:\\Users\\Craig\\AppData\\Local\\Temp\\ffmpeg.exe, keeping webm.");
      console.log(`LATEST_VIDEO_FILE: ${targetFilePath}`);
    }
    
    // Clean up local file
    fs.unlinkSync(sourceFilePath);
  } else {
    console.log("Validation WARNING: No video recording found in download path.");
  }

  console.log("Closing page...");
  await page.close();
  await browser.disconnect();
  console.log("Done!");
}

run().catch(err => {
  console.error("Error running validation script:", err);
  process.exit(1);
});
