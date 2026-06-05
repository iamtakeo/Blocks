const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

function findBrowser() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  console.log('1. Locating browser...');
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('No browser found.');
    process.exit(1);
  }

  console.log('2. Launching headless browser...');
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  
  // Log all console events
  page.on('console', msg => {
    console.log(`[Vercel Site Console - ${msg.type()}] ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.error('[Vercel Site Page Error]', err);
  });

  console.log('3. Navigating to Vercel production deployment...');
  await page.goto('https://blocks-sandy.vercel.app/', { waitUntil: 'networkidle2' });

  console.log('4. Waiting 3 seconds for load buffers...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('5. Evaluating BlocksAutomation script on production site...');
  try {
    await page.evaluate(() => {
      if (window.BlocksAutomation) {
        window.BlocksAutomation.runDemo('build_neon_tower');
      } else {
        console.error('window.BlocksAutomation is NOT defined on this page.');
      }
    });
  } catch (err) {
    console.error('Evaluation failed:', err.message);
  }

  console.log('6. Waiting 10 seconds to collect console messages...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  console.log('7. Closing browser...');
  await browser.close();
  console.log('Finished diagnostics.');
}

main();
