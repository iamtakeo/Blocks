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
  const downloadPath = 'C:\\Users\\Craig\\AppData\\Local\\Temp\\blocks-downloads';
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }
  console.log(`Setting download path to: ${downloadPath}`);
  
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath
  });

  console.log("Waiting for BlocksAutomation API...");
  await page.waitForFunction(() => typeof window.BlocksAutomation !== 'undefined', { timeout: 10000 });

  console.log("Running scenario: navigate_world");
  await page.evaluate(() => {
    window.BlocksAutomation.runDemo("navigate_world");
  });

  console.log("Scenario started. Waiting 12 seconds for completion...");
  await new Promise(resolve => setTimeout(resolve, 12000));

  console.log("Checking for downloaded files in: ", downloadPath);
  const files = fs.readdirSync(downloadPath);
  const videoFiles = files.filter(f => f.startsWith('blocks-gameplay-') && f.endsWith('.webm'));
  
  if (videoFiles.length > 0) {
    console.log("Validation SUCCESS: Video recording downloaded.");
    const latestFile = videoFiles.sort().reverse()[0];
    const sourceFilePath = path.join(downloadPath, latestFile);
    
    // Copy the file to the current conversation's directory
    const targetDir = 'C:\\Users\\Craig\\.gemini\\antigravity\\brain\\2a754af4-90a4-43a1-9cfa-cdb7170e8da8';
    const targetFilePath = path.join(targetDir, latestFile);
    fs.copyFileSync(sourceFilePath, targetFilePath);
    console.log(`Copied video to conversation folder: ${targetFilePath}`);
    
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
