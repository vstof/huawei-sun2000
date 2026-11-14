// -----------------------------------------------------------------------------
// Build the integration image with the manifest baked into it.
//
// Gladys installs an integration "by image" (dev mode) by reading the manifest
// from the image label `io.gladysassistant.manifest` — a plain `docker build`
// would produce an image Gladys refuses with MANIFEST_NOT_FOUND.
//
//   npm run build:image              # builds manifest.docker_image
//   node scripts/build.js me/huawei:1.1.0
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MANIFEST_LABEL = 'io.gladysassistant.manifest';
const root = fileURLToPath(new URL('..', import.meta.url));

const manifest = JSON.parse(readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'));
const image = process.argv[2] || manifest.docker_image;
const args = ['build', '--label', `${MANIFEST_LABEL}=${JSON.stringify(manifest)}`, '-t', image, root];

console.log(`Building ${image} (${MANIFEST_LABEL} from gladys-assistant-integration.json)...`);
const result = spawnSync('docker', args, { stdio: 'inherit', cwd: root });

if (result.error) {
  console.error(`Unable to run docker: ${result.error.message}`);
  console.error('Is the container engine running (Rancher Desktop / Docker Desktop) ?');
  process.exit(1);
}
process.exit(result.status ?? 1);
