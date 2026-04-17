const { spawn, exec } = require('child_process');
const path = require('path');

console.log('Starting Fleet ORCA Automation Demo...\n');

// Start mock myORCA server
const orca = spawn('node', [path.join(__dirname, 'mock-orca', 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env }
});

// Start Fleet backend server
const fleet = spawn('node', [path.join(__dirname, 'fleet', 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env }
});

// Wait for servers to start, then open dashboard
setTimeout(() => {
  const dashboardUrl = 'http://localhost:3001';
  console.log(`\nDashboard: ${dashboardUrl}`);
  console.log('Mock myORCA: http://localhost:3000');
  console.log('\nPress Ctrl+C to stop.\n');

  // Open in default browser (macOS)
  if (process.platform === 'darwin') {
    exec(`open ${dashboardUrl}`);
  } else if (process.platform === 'linux') {
    exec(`xdg-open ${dashboardUrl}`);
  } else if (process.platform === 'win32') {
    exec(`start ${dashboardUrl}`);
  }
}, 2000);

// Handle shutdown
function cleanup() {
  console.log('\nShutting down...');
  orca.kill();
  fleet.kill();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
