import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root=resolve(import.meta.dirname,'..'),output=join(root,'dist','server.cjs');
await mkdir(dirname(output),{recursive:true});
await build({entryPoints:[join(root,'src','cli.mjs')],outfile:output,bundle:true,platform:'node',format:'cjs',target:'node26',minify:true,sourcemap:false});
console.log(output);
