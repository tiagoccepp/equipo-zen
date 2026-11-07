// Idempotente: build.sh ya compiló el frontend antes de podar devDeps.
// Si el marcador existe, tauri reutiliza dist/ sin tsc+vite.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

if (existsSync('dist/.bundle-fresh')) {
  console.log('[before-build] dist fresco, omito tsc+vite');
} else {
  execSync('npm run build', { stdio: 'inherit' });
}
