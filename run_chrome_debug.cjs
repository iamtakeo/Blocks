const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const userDataDir = 'C:\\Users\\Craig\\AppData\\Local\\Google\\Chrome\\User Data';

if (!fs.existsSync(userDataDir)) {
  fs.mkdirSync(userDataDir, { recursive: true });
}

console.log('Spawning Chrome debugging instance...');
const chrome = spawn(chromePath, [
  '--remote-debugging-port=9222',
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox'
]);

chrome.stderr.on('data', (data) => {
  console.log(`[Chrome Stderr] ${data.toString().trim()}`);
});

chrome.stdout.on('data', (data) => {
  console.log(`[Chrome Stdout] ${data.toString().trim()}`);
});

chrome.on('close', (code) => {
  console.log(`Chrome process exited with code ${code}`);
});

// Write DevToolsActivePort file
const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
fs.writeFileSync(activePortPath, '9222\n/devtools/browser/\n');
console.log(`Wrote DevToolsActivePort to ${activePortPath}`);

// Keep this parent script alive to keep Chrome alive
setInterval(() => {
  // heartbeat
}, 5000);
