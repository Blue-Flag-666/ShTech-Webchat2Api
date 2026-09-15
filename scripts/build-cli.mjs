import { spawnSync } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const extension = process.platform === 'win32' ? '.exe' : '';
const name = `shtech-webchat2api-${platform}-${process.arch}${extension}`;
const bundle = join(dist, 'cli.cjs');
const output = join(dist, name);
const config = join(dist, 'sea-config.json');

if (!['win32','linux'].includes(process.platform)) throw new Error('CLI 目前只打包 Windows 和 Linux');
if (!['x64','arm64'].includes(process.arch)) throw new Error('CLI 目前只打包 x64 和 arm64');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({ entryPoints: [join(root, 'src/cli.mjs')], outfile: bundle, bundle: true,
  platform: 'node', format: 'cjs', target: 'node26', minify: true, sourcemap: false });
await writeFile(config, JSON.stringify({ main: bundle, mainFormat: 'commonjs', output,
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: true }, null, 2));
const result = spawnSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Node SEA 构建失败，退出码 ${result.status}`);
if (process.platform !== 'win32') await chmod(output, 0o755);
await rm(bundle, { force: true });
await rm(config, { force: true });
console.log(output);
