// File extension -> [language name, color]. Colors loosely follow GitHub's linguist palette,
// brightened where needed so they still read at night.
const BY_EXT = {
  js: ['JavaScript', '#f1e05a'], mjs: ['JavaScript', '#f1e05a'], cjs: ['JavaScript', '#f1e05a'], jsx: ['JavaScript', '#f1e05a'],
  ts: ['TypeScript', '#3b82f6'], tsx: ['TypeScript', '#3b82f6'], mts: ['TypeScript', '#3b82f6'], cts: ['TypeScript', '#3b82f6'],
  py: ['Python', '#4b8bbe'], pyi: ['Python', '#4b8bbe'], ipynb: ['Jupyter', '#f37626'],
  java: ['Java', '#d9822b'], kt: ['Kotlin', '#a97bff'], kts: ['Kotlin', '#a97bff'], scala: ['Scala', '#dc322f'], groovy: ['Groovy', '#4298b8'],
  go: ['Go', '#00add8'], rs: ['Rust', '#dea584'],
  c: ['C', '#4fc1a6'], h: ['C/C++ Header', '#5b8fd9'],
  cpp: ['C++', '#f34b7d'], cc: ['C++', '#f34b7d'], cxx: ['C++', '#f34b7d'], hpp: ['C++', '#f34b7d'], hh: ['C++', '#f34b7d'], hxx: ['C++', '#f34b7d'],
  cs: ['C#', '#3fb950'], fs: ['F#', '#b845fc'], vb: ['Visual Basic', '#945db7'],
  swift: ['Swift', '#f05138'], m: ['Objective-C', '#438eff'], mm: ['Objective-C', '#438eff'],
  rb: ['Ruby', '#cc342d'], php: ['PHP', '#777bb4'], dart: ['Dart', '#00b4ab'], lua: ['Lua', '#5c6bc0'],
  r: ['R', '#198ce7'], jl: ['Julia', '#a270ba'], ex: ['Elixir', '#9b6bd6'], exs: ['Elixir', '#9b6bd6'], erl: ['Erlang', '#b83998'],
  hs: ['Haskell', '#7e6fc4'], clj: ['Clojure', '#63b132'], ml: ['OCaml', '#ef7a08'], mli: ['OCaml', '#ef7a08'],
  zig: ['Zig', '#ec915c'], nim: ['Nim', '#ffc200'], sol: ['Solidity', '#aa6746'], pl: ['Perl', '#39a7c6'],
  html: ['HTML', '#e34c26'], htm: ['HTML', '#e34c26'], css: ['CSS', '#8a63d2'], scss: ['SCSS', '#c6538c'], sass: ['SCSS', '#c6538c'], less: ['Less', '#5a8fd6'],
  vue: ['Vue', '#41b883'], svelte: ['Svelte', '#ff3e00'], astro: ['Astro', '#ff5d01'],
  json: ['JSON', '#9aa5b1'], jsonc: ['JSON', '#9aa5b1'], yaml: ['YAML', '#e06c75'], yml: ['YAML', '#e06c75'], toml: ['TOML', '#c27c4e'], xml: ['XML', '#3d9be9'],
  ini: ['Config', '#8b949e'], cfg: ['Config', '#8b949e'], conf: ['Config', '#8b949e'], env: ['Config', '#8b949e'],
  md: ['Markdown', '#e6edf3'], mdx: ['Markdown', '#e6edf3'], rst: ['Docs', '#d0d7de'], txt: ['Text', '#bfc7d1'],
  sh: ['Shell', '#89e051'], bash: ['Shell', '#89e051'], zsh: ['Shell', '#89e051'], fish: ['Shell', '#89e051'],
  ps1: ['PowerShell', '#5391fe'], psm1: ['PowerShell', '#5391fe'], bat: ['Batch', '#c1f12e'], cmd: ['Batch', '#c1f12e'],
  sql: ['SQL', '#e38c00'], graphql: ['GraphQL', '#e10098'], gql: ['GraphQL', '#e10098'], proto: ['Protobuf', '#5fb98f'],
  cmake: ['CMake', '#da3434'], gradle: ['Gradle', '#02a8a8'], tf: ['Terraform', '#7b42bc'], nix: ['Nix', '#7e9fd8'],
  s: ['Assembly', '#b08850'], asm: ['Assembly', '#b08850'], glsl: ['GLSL', '#5686a5'], wgsl: ['WGSL', '#4fc3f7'], hlsl: ['HLSL', '#aace60'],
  tex: ['TeX', '#6a9f3a'], csv: ['Data', '#6ea8a0'], tsv: ['Data', '#6ea8a0'],
};

const BY_NAME = {
  dockerfile: ['Docker', '#2496ed'], makefile: ['Makefile', '#6d9a2f'], 'cmakelists.txt': ['CMake', '#da3434'],
  gemfile: ['Ruby', '#cc342d'], rakefile: ['Ruby', '#cc342d'], license: ['Docs', '#d0d7de'], readme: ['Markdown', '#e6edf3'],
  kconfig: ['Config', '#8b949e'], kbuild: ['Makefile', '#6d9a2f'],
};

const OTHER = ['Other', '#8a8f98'];
const cache = new Map();

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function langOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const hit = BY_NAME[name] || BY_EXT[extOf(name)] || (name.startsWith('dockerfile') ? BY_NAME.dockerfile : OTHER);
  let lang = cache.get(hit[0]);
  if (!lang) { lang = { name: hit[0], color: hit[1] }; cache.set(hit[0], lang); }
  return lang;
}
