import esbuild from 'esbuild';
import fse, { move } from 'fs-extra';
import glob from 'glob';
import { exec } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { platform } from 'node:process';
import { copyFromTo } from './utils.js';

const entry = './src/index.ts';

/**
 * @param {string} cmd
 * @return {!Promise<string>}
 */
const execPromise = (cmd) => {
  return new Promise((res, rej) =>
    exec(cmd, (err, stdout) => {
      if (err) {
        console.log(stdout);
        return rej(err);
      }
      res(stdout);
    })
  );
}

/**
 * @param {!Object<string, string>} copyMap
 * @return {!Promise<*>}
 */
const copy = (copyMap) => {
  let promises = [];
  for (let [source, target] of Object.entries(copyMap)) {
    promises.push(
      fse.copy(source, target, {
        recursive: true,
        overwrite: true,
        dereference: true,
      })
    );
  }
  return Promise.all(promises);
}

const buildCloudflare = async () => {
  // prepare plonk_wasm.js with bundled wasm in function-wrapped form
  let bindings = await readFile(
    './src/bindings/compiled/web_bindings/plonk_wasm.js',
    'utf8'
  );
  bindings = rewriteWasmBindings(bindings);
  let tmpBindingsPath = 'src/bindings/compiled/web_bindings/plonk_wasm.tmp.js';
  await writeFile(tmpBindingsPath, bindings);
  await esbuild.build({
    entryPoints: [tmpBindingsPath],
    bundle: true,
    format: 'esm',
    outfile: tmpBindingsPath,
    target: 'esnext',
    plugins: [wasmPlugin()],
    allowOverwrite: true,
  });
  bindings = await readFile(tmpBindingsPath, 'utf8');
  bindings = rewriteBundledWasmBindings(bindings);
  await writeFile(tmpBindingsPath, bindings);

  // run typescript
  await execPromise('npx tsc -p tsconfig.cloudflare.json');

  // copy over pure js files
  await copy({
    './src/bindings/compiled/web_bindings/': './dist/cloudflare/web_bindings/',
    './src/snarky.d.ts': './dist/cloudflare/snarky.d.ts',
    './src/snarky.web.js': './dist/cloudflare/snarky.js',
    './src/bindings/js/web/': './dist/cloudflare/bindings/js/web/',
  });

  if (true) {
    let o1jsWebPath = './dist/cloudflare/web_bindings/o1js_web.bc.js';
    let o1jsWeb = await readFile(o1jsWebPath, 'utf8');
    let { code } = await esbuild.transform(o1jsWeb, {
      target: "esnext",
      logLevel: 'error',
      minify: true,
    });
    await writeFile(o1jsWebPath, code);
  }

  // overwrite plonk_wasm with bundled version
  await copy({ [tmpBindingsPath]: './dist/cloudflare/web_bindings/plonk_wasm.js' });
  await unlink(tmpBindingsPath);

  // move all .web.js files to their .js counterparts
  let webFiles = glob.sync('./dist/cloudflare/**/*.web.js');
  await Promise.all(
    webFiles.map((file) =>
      move(file, file.replace('.web.js', '.js'), { overwrite: true })
    )
  );

  // run esbuild on the js entrypoint
  let jsEntry = path.basename(entry).replace('.ts', '.js');
  await esbuild.build({
    entryPoints: [`./dist/cloudflare/${jsEntry}`],
    bundle: true,
    format: 'esm',
    outfile: 'dist/cloudflare/index.js',
    resolveExtensions: ['.js', '.ts'],
    plugins: [wasmPlugin(), srcStringPlugin()],
    dropLabels: ['CJS'],
    external: ['*.bc.js'],
    target: "esnext",
    allowOverwrite: true,
    logLevel: 'error',
    minify: true,
  });
}

function rewriteWasmBindings(src) {
  src = src
    .replace("new URL('plonk_wasm_bg.wasm', import.meta.url)", 'wasmCode')
    .replace('import.meta.url', '"/"');
  return `import wasmCode from './plonk_wasm_bg.wasm';
  let startWorkers, terminateWorkers;  
${src}`;
}
function rewriteBundledWasmBindings(src) {
  let i = src.indexOf('export {');
  let exportSlice = src.slice(i);
  let defaultExport = exportSlice.match(/\w* as default/)[0];
  exportSlice = exportSlice
    .replace(defaultExport, `default: __wbg_init`)
    .replace('export', 'return');
  src = src.slice(0, i) + exportSlice;

  src = src.replace('var startWorkers;\n', '');
  src = src.replace('var terminateWorkers;\n', '');
  return `import { startWorkers, terminateWorkers } from '../bindings/js/web/worker-helpers.js'
export {plonkWasm as default};
function plonkWasm() {
  ${src}
}
plonkWasm.deps = [startWorkers, terminateWorkers]`;
}

function wasmPlugin() {
  return {
    name: 'wasm-plugin',
    setup(build) {
      build.onLoad({ filter: /\.wasm$/ }, async ({ path }) => {
        return {
          contents: await readFile(path),
          loader: 'binary',
        };
      });
    },
  };
}

function srcStringPlugin() {
  return {
    name: 'src-string-plugin',
    setup(build) {
      build.onResolve(
        { filter: /^string:/ },
        async ({ path: importPath, resolveDir }) => {
          let absPath = path.resolve(
            resolveDir,
            importPath.replace('string:', '')
          );
          return {
            path: absPath,
            namespace: 'src-string',
          };
        }
      );

      build.onLoad(
        { filter: /.*/, namespace: 'src-string' },
        async ({ path }) => {
          return {
            contents: await readFile(path, 'utf8'),
            loader: 'text',
          };
        }
      );
    },
  };
}

const bindings = './src/bindings/compiled/node_bindings/'

const buildCloudflare2 = async () => {
  await copyFromTo(
    ['src/bindings/compiled/node_bindings/'],
    'node_bindings',
    '_node_bindings'
  );

  await execPromise('npx tsc -p tsconfig.cloudflare.json');

  await copyFromTo(
    [
      'src/snarky.d.ts',
      'src/bindings/compiled/_node_bindings',
      'src/bindings/compiled/node_bindings/plonk_wasm.d.cts',
    ],
    'src/',
    'dist/cloudflare/'
  );
  
  // bundle the index.js file with esbuild and create a new index.cjs file which conforms to CJS
  let jsEntry = path.resolve(
    'dist/cloudflare',
    path.basename(entry).replace('.ts', '.js')
  );
  await esbuild.build({
    entryPoints: [jsEntry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: jsEntry,
    target: "esnext",
    resolveExtensions: ['.node.js', '.ts', '.js'],
    allowOverwrite: true,
    plugins: [makeNodeModulesExternal(), makeJsooExternal()],
    dropLabels: ['CJS'],
    minify: false,
  });
}

function makeNodeModulesExternal() {
  let isNodeModule = /^[^./\\]|^\.[^./\\]|^\.\.[^/\\]/;
  return {
    name: 'plugin-external',
    setup(build) {
      build.onResolve({ filter: isNodeModule }, ({ path }) => ({
        path,
        external: !(platform === 'win32' && path.endsWith('index.js')),
      }));
    },
  };
}

function makeJsooExternal() {
  let isJsoo = /(bc.cjs|plonk_wasm.cjs)$/;
  return {
    name: 'plugin-external',
    setup(build) {
      build.onResolve({ filter: isJsoo }, ({ path: filePath, resolveDir }) => ({
        path:
          './' +
          path.relative(
            path.resolve('.', 'dist/cloudflare'),
            path.resolve(resolveDir, filePath)
          ),
        external: true,
      }));
    },
  };
}

console.log('using bindings from', bindings);
await buildCloudflare2();
console.log('finished build');
