// Builds dist/tally.mjs: the src/ modules concatenated into one ES module, dependencies first.
//
//   node scripts/build.mjs
//
// Relative imports are resolved inside the bundle and must name a module of src/ and names it exports; imports of
// node builtins are merged at the top. The bundle must parse (`node --check`). Pass or fail is the exit code.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';

const SRC = 'src';
const OUT = 'dist/tally.mjs';
const IMPORT = /^import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const DECLARED_EXPORT = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const LISTED_EXPORT = /^export\s*\{([^}]*)\}/gm;

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.js') ? [path] : [];
    })
    .sort();
}

// `{ a, b as c }` → [{ name: 'a', local: 'a' }, { name: 'b', local: 'c' }]; anything else is unsupported here.
function namedBindings(clause, where) {
  const match = /^\{([^}]*)\}$/.exec(clause.trim());
  if (!match) fail(`${where}: only named imports ({ a, b as c }) are supported, got ${clause.trim()}`);
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, local = name] = part.split(/\s+as\s+/).map((word) => word.trim());
      return { name, local };
    });
}

class Module {
  constructor(path) {
    this.path = path;
    this.text = readFileSync(path, 'utf8');
    this.imports = [...this.text.matchAll(IMPORT)].map(([statement, clause, specifier]) => ({
      statement,
      clause,
      specifier,
    }));
    this.exports = new Set([
      ...[...this.text.matchAll(DECLARED_EXPORT)].map((match) => match[1]),
      ...[...this.text.matchAll(LISTED_EXPORT)].flatMap((match) =>
        match[1]
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/).at(-1))
          .filter(Boolean),
      ),
    ]);
  }

  body() {
    return this.text.replace(IMPORT, '').replace(/^\n+/, '');
  }
}

const modules = new Map(sources(SRC).map((path) => [path, new Module(path)]));
if (modules.size === 0) fail(`no modules under ${SRC}/`);

const builtins = new Map(); // specifier → Map(local → name)
const dependencies = new Map(); // module path → module paths it imports
const aliases = new Map(); // module path → `const local = name;` lines
for (const module of modules.values()) {
  dependencies.set(module.path, []);
  aliases.set(module.path, []);
  for (const { clause, specifier } of module.imports) {
    const where = `${module.path} imports ${specifier}`;
    if (specifier.startsWith('node:')) {
      const bindings = builtins.get(specifier) ?? new Map();
      for (const { name, local } of namedBindings(clause, where)) {
        if (bindings.has(local) && bindings.get(local) !== name) fail(`${where}: ${local} is bound to two names`);
        bindings.set(local, name);
      }
      builtins.set(specifier, bindings);
      continue;
    }
    if (!specifier.startsWith('.')) fail(`${where}: only relative and node: imports can be bundled`);
    const target = posix.normalize(posix.join(posix.dirname(module.path), specifier));
    const imported = modules.get(target);
    if (!imported) fail(`${where}, which does not exist (${target})`);
    for (const { name, local } of namedBindings(clause, where)) {
      if (!imported.exports.has(name)) fail(`${where}, which does not export ${name}`);
      if (local !== name) aliases.get(module.path).push(`const ${local} = ${name};`);
    }
    dependencies.get(module.path).push(target);
  }
}

// Dependencies first; a cycle keeps the order in which it was met (function declarations hoist).
const ordered = [];
const seen = new Set();
const visit = (path) => {
  if (seen.has(path)) return;
  seen.add(path);
  for (const dependency of dependencies.get(path)) visit(dependency);
  ordered.push(modules.get(path));
};
for (const path of modules.keys()) visit(path);

const header = [...builtins]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([specifier, bindings]) => {
    const parts = [...bindings].map(([local, name]) => (local === name ? name : `${name} as ${local}`));
    return `import { ${parts.join(', ')} } from '${specifier}';`;
  });
const sections = ordered.map((module) =>
  [`// ---- ${module.path} ----`, ...aliases.get(module.path), module.body().trimEnd()].join('\n'),
);
const bundle = [`// Built by scripts/build.mjs from ${SRC}/; do not edit.`, ...header, '', sections.join('\n\n'), ''].join(
  '\n',
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle);
const parsed = spawnSync(process.execPath, ['--check', OUT], { encoding: 'utf8' });
if (parsed.status !== 0) fail(`${OUT} does not parse:\n${parsed.stderr}`);
console.log(`build: wrote ${OUT} from ${ordered.length} modules`);
