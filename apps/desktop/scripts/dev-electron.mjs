import { spawn } from 'node:child_process';
import process from 'node:process';

// pnpm resolves to pnpm.cmd on Windows; spawn() cannot exec a .cmd without
// a shell (observed live: `spawn pnpm ENOENT`, errno -4058). Same isWin
// handling release-win.mjs already uses for electron-builder.cmd.
const isWin = process.platform === 'win32';

const port = Number(process.env.ANTSEED_DESKTOP_RENDERER_PORT) || 5174;
let child = spawn('pnpm', [
  'exec',
  'wait-on',
  `tcp:${port}`,
  'file:dist/main/main.js',
  'file:dist/main/preload.cjs',
], { stdio: 'inherit', shell: isWin });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('exit', (code, signal) => {
  if (code !== 0) {
    process.exitCode = code ?? (signal ? 1 : 0);
    return;
  }
  child = spawn('pnpm', ['exec', 'electron', '.', ...process.argv.slice(2)], {
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}` },
    stdio: 'inherit',
    shell: isWin,
  });
  child.once('exit', (electronCode, electronSignal) => {
    process.exitCode = electronCode ?? (electronSignal ? 1 : 0);
  });
});
