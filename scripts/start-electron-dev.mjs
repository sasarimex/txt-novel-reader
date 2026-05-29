import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const devServerUrl = 'http://127.0.0.1:5173';

const vitePackageJson = require.resolve('vite/package.json');
const viteBin = path.join(path.dirname(vitePackageJson), 'bin', 'vite.js');
const electronBin = require('electron');

const childProcesses = [];

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  childProcesses.push(child);
  return child;
}

function cleanup() {
  for (const child of childProcesses) {
    if (!child.killed) {
      child.kill();
    }
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw new Error(`Vite dev server did not start at ${url}`);
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

const vite = spawnChild(process.execPath, [
  viteBin,
  '--host',
  '127.0.0.1',
  '--port',
  '5173',
  '--strictPort',
]);

vite.on('exit', (code) => {
  if (code !== 0) {
    cleanup();
    process.exit(code ?? 1);
  }
});

await waitForServer(devServerUrl);

const electron = spawnChild(electronBin, [path.join(projectRoot, 'electron', 'main.cjs')], {
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});

electron.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
