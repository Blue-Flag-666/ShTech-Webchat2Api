import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

// Keep the complete bundle in memory: no extraction directory or extra runtime
// files are needed by either the container or the single-file executable.
export async function compressedBundle(entry, output) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node26', minify: true, sourcemap: false });
  const source = result.outputFiles[0].text.replace(/^#![^\n]*\n/, '');
  const payload = gzipSync(source, { level: 9 }).toString('base64');
  const loader = `const source=require('node:zlib').gunzipSync(Buffer.from('${payload}','base64')).toString('utf8');\nrequire('node:vm').runInThisContext('(function(require,module,exports,__filename,__dirname){'+source+'\\n})',{filename:__filename})(require,module,exports,__filename,__dirname);\n`;
  await writeFile(output, loader);
  console.log(`Application bundle: ${Buffer.byteLength(source)} -> ${Buffer.byteLength(loader)} bytes`);
}
