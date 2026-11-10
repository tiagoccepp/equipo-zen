// Idempotent: build.sh already compiled the frontend before pruning devDeps.
// If the marker exists, tauri reuses dist/ without tsc+vite.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

if (existsSync('dist/.bundle-fresh')) {
  console.log('[before-build] dist fresco, omito tsc+vite');
} else {
  execSync('npm run build', { stdio: 'inherit' });
}
