import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { compressedBundle } from './bundle.mjs';

const root=resolve(import.meta.dirname,'..'),output=join(root,'dist','server.cjs');
await mkdir(dirname(output),{recursive:true});
await compressedBundle(join(root,'src','cli.mjs'),output);
console.log(output);
