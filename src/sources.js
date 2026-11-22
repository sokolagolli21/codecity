// Where cities come from: a GitHub repo (via the public API), a local folder, or a .zip.
// Local files are read in the browser and never uploaded anywhere.
import { extOf } from './languages.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache',
  '.pytest_cache', '.idea', '.gradle', '.terraform', 'bower_components', '__MACOSX',
]);
// Build output and caches: skipped for local folders, where they are almost never source.
const SKIP_DIRS_LOCAL = new Set([
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'target', 'bin', 'obj',
  '.cache', '.parcel-cache', '.turbo', 'vendor', '.expo', '.vs',
]);
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'uv.lock',
  'composer.lock', 'gemfile.lock', 'go.sum', 'pipfile.lock', '.ds_store', 'thumbs.db',
]);
const BINARY_EXT = new Set(`png jpg jpeg gif webp avif ico bmp tif tiff psd ai sketch fig xcf heic
  mp3 wav ogg flac aac m4a mp4 mov avi webm mkv m4v wmv
  zip gz tgz tar rar 7z bz2 xz zst jar war ear class dex apk ipa aab
  exe dll so dylib o a lib obj pdb bin dat db sqlite sqlite3 mdb
  woff woff2 ttf otf eot pdf doc docx xls xlsx ppt pptx key numbers pages
  pyc pyo wasm map node blend fbx glb gltf usdz stl 3ds onnx pt pth ckpt safetensors h5 npy npz pkl parquet`
  .split(/\s+/));

export function isSkippedDir(name) {
  return SKIP_DIRS.has(name) || SKIP_DIRS_LOCAL.has(name);
}

export function skipPath(path, local) {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (SKIP_DIRS.has(parts[i]) || (local && SKIP_DIRS_LOCAL.has(parts[i]))) return true;
  }
  const name = parts[parts.length - 1].toLowerCase();
  if (!name || SKIP_FILES.has(name)) return true;
  if (name.endsWith('.min.js') || name.endsWith('.min.css') || name.endsWith('.map')) return true;
  return BINARY_EXT.has(extOf(name));
}

const estimateLines = (bytes) => Math.max(1, Math.round(bytes / 32));

function countLines(text) {
  if (!text) return 0;
  let n = 1, i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
  if (text.endsWith('\n')) n--;
  return n;
}

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- GitHub

export const rate = { remaining: null, limit: null, reset: null };

export function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^?#]+))?/i);
  if (m) return { owner: m[1], repo: m[2], branch: m[3] ? decodeURIComponent(m[3]) : null };
  m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) return { owner: m[1], repo: m[2], branch: null };
  return null;
}

async function gh(url, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new Error('Could not reach GitHub. Check your connection.');
  }
  const rem = res.headers.get('x-ratelimit-remaining');
  if (rem !== null) {
    rate.remaining = Number(rem);
    rate.limit = Number(res.headers.get('x-ratelimit-limit'));
    rate.reset = Number(res.headers.get('x-ratelimit-reset'));
  }
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429) && rate.remaining === 0) {
      const mins = Math.max(1, Math.ceil((rate.reset * 1000 - Date.now()) / 60000));
      throw new Error(`GitHub's free limit is used up. Try again in about ${mins} min, or add a GitHub token.`);
    }
    if (res.status === 404) throw new Error(token ? 'Repository not found.' : 'Repository not found. If it is private, add a GitHub token.');
    if (res.status === 401) throw new Error('GitHub rejected that token.');
    let msg = '';
    try { msg = (await res.json()).message; } catch { /* no body */ }
    throw new Error(`GitHub error ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return res.json();
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

function withUrls(src) {
  return { ...src, fileUrl: (path) => `https://github.com/${src.name}/blob/${encPath(src.branch)}/${encPath(path)}` };
}

export async function loadGitHub(input, token, onProgress) {
  const p = parseRepo(input);
  if (!p) throw new Error('Enter a GitHub repo like "facebook/react" or paste its URL.');
  // Reloads in the same tab reuse the last download instead of spending API requests.
  const cacheKey = `codecity:${p.owner}/${p.repo}@${p.branch || ''}`.toLowerCase();
  try {
    const hit = sessionStorage.getItem(cacheKey);
    if (hit) return withUrls(JSON.parse(hit));
  } catch { /* storage unavailable */ }
  const src = await fetchGitHub(p, token, onProgress);
  try {
    const { fileUrl, ...plain } = src;
    sessionStorage.setItem(cacheKey, JSON.stringify(plain));
  } catch { /* too big for storage or blocked; fine */ }
  return src;
}

async function fetchGitHub(p, token, onProgress) {
  onProgress(`Looking up ${p.owner}/${p.repo}…`);
  const meta = await gh(`https://api.github.com/repos/${p.owner}/${p.repo}`, token);
  const branch = p.branch || meta.default_branch;
  onProgress('Downloading the file tree…');
  const tree = await gh(`https://api.github.com/repos/${meta.full_name}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
  const files = [];
  for (const t of tree.tree || []) {
    if (t.type === 'blob' && !skipPath(t.path, false)) {
      files.push({ path: t.path, size: t.size || 0, lines: estimateLines(t.size || 0), estimated: true });
    }
  }
  return withUrls({
    kind: 'github',
    name: meta.full_name,
    branch,
    stars: meta.stargazers_count,
    description: meta.description || '',
    truncated: !!tree.truncated,
    files,
  });
}

// Counts how often each file changed across the most recent commits.
// Costs one API request per commit, so callers should say so first.
export async function loadHotspots(source, token, count, onProgress) {
  const commits = await gh(
    `https://api.github.com/repos/${source.name}/commits?sha=${encodeURIComponent(source.branch)}&per_page=${count}`,
    token,
  );
  const heat = new Map();
  let done = 0;
  await pool(commits, 6, async (c) => {
    const detail = await gh(c.url, token);
    for (const f of detail.files || []) heat.set(f.filename, (heat.get(f.filename) || 0) + 1);
    onProgress(`Reading commit history ${++done}/${commits.length}…`);
  });
  let max = 0;
  for (const v of heat.values()) max = Math.max(max, v);
  const oldest = commits.length ? commits[commits.length - 1].commit?.author?.date : null;
  return { map: heat, max, commits: commits.length, since: oldest };
}

// ---------------------------------------------------------------- Local folder / zip

// entries: [{ path, file }] with paths relative to the project root
export async function loadLocal(entries, name, onProgress) {
  const kept = entries.filter((e) => !skipPath(e.path, true));
  if (kept.length > 150000) throw new Error('That folder has over 150,000 files. Try a smaller folder.');
  const files = [];
  let done = 0;
  await pool(kept, 24, async (e) => {
    let lines, estimated = false;
    if (e.file.size <= 1_500_000) {
      const text = await e.file.text();
      if (text.slice(0, 2000).includes('\u0000')) return; // binary
      lines = countLines(text);
    } else {
      lines = estimateLines(e.file.size);
      estimated = true;
    }
    files.push({ path: e.path, size: e.file.size, lines, estimated });
    if (++done % 250 === 0) onProgress(`Reading files… ${done.toLocaleString()} / ${kept.length.toLocaleString()}`);
  });
  return { kind: 'local', name, files, fileUrl: null };
}

let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszipPromise = null; reject(new Error('Could not load the zip reader.')); };
    document.head.appendChild(s);
  });
  return jszipPromise;
}

export async function loadZip(file, onProgress) {
  onProgress('Opening zip…');
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  // Zips made on Windows can use backslashes as separators.
  const all = Object.values(zip.files).filter((f) => !f.dir).map((f) => ({ f, path: f.name.replace(/\\/g, '/').replace(/^\/+/, '') }));
  const kept = all.filter((e) => e.path && !skipPath(e.path, true));
  const files = [];
  let done = 0;
  await pool(kept, 8, async ({ f, path }) => {
    const text = await f.async('string');
    if (text.slice(0, 2000).includes('\u0000')) return;
    files.push({ path, size: text.length, lines: countLines(text), estimated: false });
    if (++done % 250 === 0) onProgress(`Reading zip… ${done.toLocaleString()} / ${kept.length.toLocaleString()}`);
  });
  return { kind: 'local', name: file.name.replace(/\.zip$/i, ''), files, fileUrl: null };
}

// ---------------------------------------------------------------- Demo city for the landing page

export function demoSource() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const dirs = [
    ['src/components', 'tsx', 46], ['src/components/ui', 'tsx', 30], ['src/hooks', 'ts', 14], ['src/lib', 'ts', 22],
    ['src/api', 'ts', 18], ['src/pages', 'tsx', 20], ['src/styles', 'css', 10], ['server/routes', 'py', 16],
    ['server/models', 'py', 14], ['server/services', 'py', 20], ['server/tests', 'py', 18], ['engine/core', 'rs', 24],
    ['engine/render', 'rs', 18], ['engine/physics', 'cpp', 16], ['tools/cli', 'go', 15], ['docs', 'md', 16],
    ['scripts', 'sh', 9], ['config', 'yaml', 8], ['packages/sdk/src', 'ts', 26], ['packages/sdk/test', 'ts', 12],
  ];
  const files = [];
  for (const [dir, ext, n] of dirs) {
    for (let i = 0; i < n; i++) {
      const lines = Math.round(Math.min(6000, Math.exp(4.4 + 1.1 * gauss())));
      files.push({ path: `${dir}/file${i}.${ext}`, size: lines * 32, lines, estimated: false });
    }
  }
  return { kind: 'demo', name: 'demo', files, fileUrl: null };
}
