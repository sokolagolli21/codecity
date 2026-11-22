import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildCity } from './layout.js';
import { langOf } from './languages.js';
import * as sources from './sources.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : fmt(n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// ------------------------------------------------------------------ renderer & scene

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x000000, 100, 1000);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 10000);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.screenSpacePanning = false;
controls.autoRotateSpeed = 0.5;

const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
scene.add(hemi, sun, sun.target);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.3, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function skyTexture(top, horizon) {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.75, horizon);
  g.addColorStop(1, horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const SKIES = { night: skyTexture('#02040a', '#16203f'), day: skyTexture('#7fb0e8', '#e6eef7') };

const THEMES = {
  night: {
    bg: 0x16203f, ground: 0x0c1222, sky: 0x8fa3dc, gnd: 0x10162a, hemi: 0.7, sunColor: 0xb8c6ff, sun: 0.75,
    glow: 1, day: 0, bloom: 0.5, exposure: 1.0, distA: 0x1a2441, distB: 0x3b4a75,
  },
  day: {
    bg: 0xe6eef7, ground: 0xdfe4ea, sky: 0xffffff, gnd: 0x8d96a3, hemi: 1.15, sunColor: 0xfff1dc, sun: 2.6,
    glow: 0, day: 1, bloom: 0, exposure: 1.0, distA: 0xc9d0da, distB: 0x8693a6,
  },
};

// Buildings: standard material plus procedural windows (lit at night) and glowing roofs.
function makeBuildingMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.08 });
  const uniforms = { uGlow: { value: 1 }, uLit: { value: 0.38 }, uDay: { value: 0 } };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vCityPos; varying vec3 vCityNormal; varying vec3 vCityCenter;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
{
  vec4 cp = vec4(transformed, 1.0);
  vec3 cn = objectNormal;
  vec3 cc = vec3(0.0);
  #ifdef USE_INSTANCING
    cp = instanceMatrix * cp; cn = mat3(instanceMatrix) * cn; cc = instanceMatrix[3].xyz;
  #endif
  cp = modelMatrix * cp;
  vCityPos = cp.xyz; vCityNormal = normalize(mat3(modelMatrix) * cn); vCityCenter = cc;
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCityPos; varying vec3 vCityNormal; varying vec3 vCityCenter;
uniform float uGlow; uniform float uLit; uniform float uDay;
float cityHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float side = 1.0 - step(0.6, abs(vCityNormal.y));
  float top = step(0.6, vCityNormal.y);
  float u = dot(vCityPos.xz, abs(vCityNormal.zx));
  vec2 cell = vec2(u * 0.62, vCityPos.y * 0.5);
  vec2 f = fract(cell);
  vec2 id = floor(cell);
  float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
  float rnd = cityHash(id + vCityCenter.xz * 0.731 + floor(vCityNormal.xz * 2.0 + 2.0) * 17.0);
  float lit = step(1.0 - uLit, rnd);
  vec2 fw = fwidth(cell);
  // Fade the pattern into its average before it gets small enough to shimmer.
  float detail = clamp(1.4 - max(fw.x, fw.y) * 3.0, 0.0, 1.0);
  float nightWin = mix(0.3 * uLit, win * lit, detail) * side;
  float dayWin = mix(0.3, win, detail) * side;
  vec3 warm = mix(vec3(1.0, 0.7, 0.36), diffuseColor.rgb, 0.25);
  totalEmissiveRadiance += warm * nightWin * uGlow * (0.55 + 0.8 * rnd);
  totalEmissiveRadiance += diffuseColor.rgb * uGlow * (0.04 + 0.22 * top);
  diffuseColor.rgb *= 1.0 - dayWin * 0.3 * uDay;
}`);
  };
  return mat;
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const buildingMat = makeBuildingMaterial();
const districtMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });

// ------------------------------------------------------------------ state

const state = {
  source: null, city: null, theme: 'night', colorMode: 'lang', heat: null, isolate: null,
  hovered: -1, selected: -1, busy: false, recording: null, landing: true,
};
let cityGroup = new THREE.Group();
scene.add(cityGroup);
let buildingMesh = null;
let districtMesh = null;
let flight = null; // active fly-through
let tween = null;  // active camera move

const WHITE = new THREE.Color(0xffffff);
const DIM = new THREE.Color(0x1c2233);
const DIM_DAY = new THREE.Color(0xd5dae2);
const HEAT_COLD = new THREE.Color(0x2b3245);
const HEAT_STOPS = ['#3b1f6b', '#b5367a', '#f2703c', '#fcd34d', '#fff7c2'].map((c) => new THREE.Color(c));
const langColors = new Map();
const colorFor = (lang) => {
  let c = langColors.get(lang.name);
  if (!c) { c = new THREE.Color(lang.color); langColors.set(lang.name, c); }
  return c;
};

// ------------------------------------------------------------------ building the city

function clearCity() {
  cityGroup.traverse((o) => {
    if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); }
  });
  buildingMesh?.dispose();
  districtMesh?.dispose();
  scene.remove(cityGroup);
  cityGroup = new THREE.Group();
  scene.add(cityGroup);
  buildingMesh = districtMesh = null;
}

function showCity(source) {
  clearCity();
  const city = buildCity(source.files);
  for (const b of city.buildings) { b.lang = langOf(b.file.path); b.color = colorFor(b.lang); }
  Object.assign(state, { source, city, heat: null, colorMode: 'lang', isolate: null, hovered: -1, selected: -1 });

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  buildingMesh = new THREE.InstancedMesh(boxGeo, buildingMat, Math.max(1, city.buildings.length));
  buildingMesh.count = city.buildings.length;
  city.buildings.forEach((b, i) => {
    buildingMesh.setMatrixAt(i, m.compose(p.set(b.x, b.y0, b.z), q, s.set(b.w, b.h, b.d)));
    buildingMesh.setColorAt(i, b.color);
  });
  buildingMesh.castShadow = buildingMesh.receiveShadow = true;
  buildingMesh.computeBoundingSphere();
  cityGroup.add(buildingMesh);

  districtMesh = new THREE.InstancedMesh(boxGeo, districtMat, Math.max(1, city.districts.length));
  districtMesh.count = city.districts.length;
  city.districts.forEach((d, i) => {
    districtMesh.setMatrixAt(i, m.compose(p.set(d.x, d.y0, d.z), q, s.set(d.w, d.h, d.d)));
    districtMesh.setColorAt(i, WHITE);
  });
  districtMesh.receiveShadow = true;
  districtMesh.computeBoundingSphere();
  cityGroup.add(districtMesh);

  addLabels(city);
  fitScene(city);
  applyTheme(state.theme);
  recolor();
}

function addLabels(city) {
  const total = city.size * city.size;
  const tops = city.districts
    .filter((d) => d.depth === 1 && d.w * d.d > total * 0.012)
    .sort((a, b) => b.w * b.d - a.w * a.d)
    .slice(0, 10);
  for (const d of tops) {
    let peak = 0;
    for (const b of city.buildings) {
      if (Math.abs(b.x - d.x) < d.w / 2 && Math.abs(b.z - d.z) < d.d / 2) peak = Math.max(peak, b.y0 + b.h);
    }
    const sprite = makeLabel(d.node.name, city.size);
    sprite.position.set(d.x, peak + city.size * 0.03, d.z);
    sprite.userData.label = d.node.name;
    cityGroup.add(sprite);
  }
}

function makeLabel(text, size) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const fs = 56;
  const font = `700 ${fs}px Inter, system-ui, sans-serif`;
  ctx.font = font;
  const label = text.length > 28 ? `…${text.slice(-27)}` : text;
  c.width = Math.ceil(ctx.measureText(label).width) + 52;
  c.height = fs + 36;
  ctx.font = font;
  ctx.fillStyle = 'rgba(8, 12, 24, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, c.height / 2);
  ctx.fill();
  ctx.fillStyle = '#c9d2e4'; // kept under the bloom threshold so labels stay crisp
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 26, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false, fog: false }));
  sprite.renderOrder = 10;
  const h = Math.max(1.5, size * 0.024);
  sprite.scale.set((h * c.width) / c.height, h, 1);
  return sprite;
}

function fitScene(city) {
  const S = Math.max(40, city.size);
  ground.scale.set(S * 10, S * 10, 1);
  scene.fog.near = S * 1.1;
  scene.fog.far = S * 4.2;
  camera.near = Math.max(0.1, S / 3000);
  camera.far = S * 14;
  camera.updateProjectionMatrix();
  sun.position.set(S * 0.45, S * 0.85, S * 0.3);
  sun.target.position.set(0, 0, 0);
  const sc = sun.shadow.camera;
  sc.left = -S * 0.72; sc.right = S * 0.72; sc.top = S * 0.72; sc.bottom = -S * 0.72;
  sc.near = S * 0.05; sc.far = S * 2.5;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = S * 0.0003;
  controls.maxDistance = S * 4;
  controls.minDistance = Math.max(2, S * 0.01);
}

function homeView() {
  const S = Math.max(40, state.city.size);
  return {
    pos: new THREE.Vector3(S * 0.68, S * 0.62, S * 0.86),
    target: new THREE.Vector3(0, state.city.maxHeight * 0.1, 0),
  };
}

// ------------------------------------------------------------------ colors & theme

function heatColor(t, out) {
  const x = Math.min(1, Math.max(0, t)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x));
  return out.copy(HEAT_STOPS[i]).lerp(HEAT_STOPS[i + 1], x - i);
}

const tmpColor = new THREE.Color();
function buildingColor(i, out) {
  const b = state.city.buildings[i];
  if (state.colorMode === 'heat' && state.heat) {
    const n = state.heat.map.get(b.file.path) || 0;
    if (n > 0) heatColor(Math.sqrt(n / state.heat.max), out);
    else out.copy(HEAT_COLD);
  } else {
    out.copy(b.color);
  }
  if (state.isolate && b.lang.name !== state.isolate) out.lerp(state.theme === 'day' ? DIM_DAY : DIM, 0.88);
  if (i === state.hovered || i === state.selected) out.lerp(WHITE, i === state.selected ? 0.75 : 0.5);
  return out;
}

function updateBuildingColor(i) {
  if (!buildingMesh || i < 0) return;
  buildingMesh.setColorAt(i, buildingColor(i, tmpColor));
  buildingMesh.instanceColor.needsUpdate = true;
}

function recolor() {
  if (!buildingMesh) return;
  const n = state.city.buildings.length;
  for (let i = 0; i < n; i++) buildingMesh.setColorAt(i, buildingColor(i, tmpColor));
  buildingMesh.instanceColor.needsUpdate = true;
}

function applyTheme(name) {
  state.theme = name;
  const T = THEMES[name];
  scene.background = SKIES[name];
  scene.fog.color.set(T.bg); // fog fades into the horizon color
  ground.material.color.set(T.ground);
  hemi.color.set(T.sky);
  hemi.groundColor.set(T.gnd);
  hemi.intensity = T.hemi;
  sun.color.set(T.sunColor);
  sun.intensity = T.sun;
  buildingMat.userData.uniforms.uGlow.value = T.glow;
  buildingMat.userData.uniforms.uDay.value = T.day;
  bloom.enabled = T.bloom > 0;
  bloom.strength = T.bloom;
  renderer.toneMappingExposure = T.exposure;
  if (districtMesh && state.city.districts.length) {
    const a = new THREE.Color(T.distA), b = new THREE.Color(T.distB);
    state.city.districts.forEach((d, i) => districtMesh.setColorAt(i, tmpColor.copy(a).lerp(b, Math.min(1, (d.depth - 1) / 5))));
    districtMesh.instanceColor.needsUpdate = true;
  }
  $('btn-theme').textContent = name === 'night' ? 'Day mode' : 'Night mode';
  if (state.isolate) recolor();
}

// ------------------------------------------------------------------ panel

function updatePanel() {
  const { source, city } = state;
  $('city-name').textContent = source.name;
  const meta = [];
  if (source.kind === 'github') {
    meta.push(`${source.branch}`);
    if (source.stars != null) meta.push(`★ ${short(source.stars)}`);
  } else {
    meta.push('Local folder · stays on your computer');
  }
  $('city-meta').textContent = meta.join(' · ');

  const estimated = source.files.some((f) => f.estimated);
  const tallest = city.buildings.reduce((a, b) => (b.file.lines > (a?.file.lines ?? -1) ? b : a), null);
  $('stats').innerHTML = `
    <div class="stat"><b>${fmt(city.buildings.length)}</b><span>buildings (files)</span></div>
    <div class="stat"><b>${estimated ? '~' : ''}${short(city.root.lines)}</b><span>lines of code${estimated ? ' (est.)' : ''}</span></div>
    <div class="stat"><b>${fmt(city.districts.length)}</b><span>districts (folders)</span></div>
    <div class="stat"><b>${fmt(new Set(city.buildings.map((b) => b.lang.name)).size)}</b><span>languages</span></div>
    ${tallest ? `<div class="stat wide"><span>Tallest tower</span><b>${esc(tallest.file.path)}</b></div>` : ''}`;

  $('btn-heat').hidden = source.kind !== 'github';
  $('btn-share').hidden = source.kind !== 'github';
  $('btn-heat').classList.toggle('on', state.colorMode === 'heat');
  $('btn-heat').textContent = state.colorMode === 'heat' ? 'Language colors' : 'Change hotspots';
  renderLegend();
  renderRate();
}

function renderLegend() {
  const legend = $('legend');
  if (state.colorMode === 'heat' && state.heat) {
    $('legend-title').textContent = 'Change hotspots';
    $('legend-hint').textContent = '';
    const since = state.heat.since ? new Date(state.heat.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    legend.innerHTML = `<li style="display:block;cursor:default">
      <div class="muted" style="font-size:12.5px">Files changed in the last ${state.heat.commits} commits${since ? ` (since ${since})` : ''}.</div>
      <div class="heat-ramp"></div>
      <div class="heat-labels"><span>untouched</span><span>changed ${state.heat.max}×</span></div></li>`;
    return;
  }
  $('legend-title').textContent = 'Languages';
  $('legend-hint').textContent = state.isolate ? 'click again to show all' : 'click to isolate';
  const byLang = new Map();
  for (const b of state.city.buildings) {
    const e = byLang.get(b.lang.name) || { lang: b.lang, lines: 0, files: 0 };
    e.lines += b.file.lines; e.files++;
    byLang.set(b.lang.name, e);
  }
  const total = state.city.root.lines || 1;
  const rows = [...byLang.values()].sort((a, b) => b.lines - a.lines).slice(0, 12);
  legend.innerHTML = rows.map((r) => {
    const pct = (100 * r.lines) / total;
    const cls = state.isolate === r.lang.name ? 'active' : state.isolate ? 'dim' : '';
    return `<li class="${cls}" data-lang="${esc(r.lang.name)}" title="${fmt(r.files)} files">
      <span class="swatch" style="background:${r.lang.color}"></span>
      <span style="width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.lang.name)}</span>
      <span class="bar"><i style="width:${Math.max(2, pct)}%;background:${r.lang.color}"></i></span>
      <span class="pct">${pct < 1 ? '<1' : Math.round(pct)}%</span></li>`;
  }).join('');
}

$('legend').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-lang]');
  if (!li) return;
  state.isolate = state.isolate === li.dataset.lang ? null : li.dataset.lang;
  recolor();
  renderLegend();
});

function renderRate() {
  const r = sources.rate;
  $('rate').textContent = r.remaining != null ? `GitHub API: ${r.remaining}/${r.limit} requests left this hour` : '';
}

// ------------------------------------------------------------------ selection, hover, tooltip

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDirty = false;
let pointerIn = false;
let mouse = { x: 0, y: 0 };
let downAt = null;

function setPointer(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  mouse = { x: e.clientX, y: e.clientY };
}

canvas.addEventListener('pointermove', (e) => { setPointer(e); pointerDirty = true; pointerIn = true; });
canvas.addEventListener('pointerleave', () => { pointerIn = false; setHover(null); });
canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  controls.autoRotate = false;
  if (tween) tween = null;
});
canvas.addEventListener('pointerup', (e) => {
  const start = downAt;
  downAt = null;
  if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
  if (state.landing || flight || state.recording) return;
  setPointer(e);
  const hit = pick();
  if (hit?.kind === 'b') select(hit.id);
  else if (hit?.kind === 'd') focusDistrict(hit.id);
  else select(-1);
});

function pick() {
  if (!buildingMesh) return null;
  raycaster.setFromCamera(pointer, camera);
  const hb = raycaster.intersectObject(buildingMesh, false)[0];
  const hd = districtMesh ? raycaster.intersectObject(districtMesh, false)[0] : null;
  if (hb && (!hd || hb.distance <= hd.distance + 0.01)) return { kind: 'b', id: hb.instanceId };
  if (hd) return { kind: 'd', id: hd.instanceId };
  return null;
}

function setHover(hit) {
  const tip = $('tooltip');
  const id = hit?.kind === 'b' ? hit.id : -1;
  if (id !== state.hovered) {
    const prev = state.hovered;
    state.hovered = id;
    updateBuildingColor(prev);
    updateBuildingColor(id);
  }
  if (!hit) { tip.hidden = true; canvas.style.cursor = ''; return; }
  canvas.style.cursor = 'pointer';
  if (hit.kind === 'b') {
    const b = state.city.buildings[hit.id];
    const heat = state.heat?.map.get(b.file.path);
    tip.innerHTML = `<b>${esc(b.file.path)}</b>
      <div class="row"><span class="swatch" style="background:${b.lang.color}"></span>${esc(b.lang.name)} · ${b.file.estimated ? '~' : ''}${fmt(b.file.lines)} lines${heat ? ` · changed ${heat}×` : ''}</div>`;
  } else {
    const d = state.city.districts[hit.id];
    tip.innerHTML = `<b>${esc(d.node.path)}/</b><div class="row">${fmt(d.node.fileCount)} files · ${short(d.node.lines)} lines</div>`;
  }
  tip.hidden = false;
  const x = Math.min(mouse.x + 16, innerWidth - tip.offsetWidth - 8);
  const y = Math.min(mouse.y + 16, innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function select(i) {
  const prev = state.selected;
  state.selected = i;
  updateBuildingColor(prev);
  updateBuildingColor(i);
  const card = $('selection');
  document.body.classList.toggle('has-selection', i >= 0);
  if (i < 0) { card.hidden = true; return; }
  const b = state.city.buildings[i];
  const parts = b.file.path.split('/');
  $('sel-swatch').style.background = b.lang.color;
  $('sel-lang').textContent = b.lang.name;
  $('sel-name').textContent = parts.pop();
  $('sel-path').textContent = parts.length ? `${parts.join('/')}/` : '/';
  const heat = state.heat?.map.get(b.file.path);
  $('sel-stats').innerHTML = `<span><b>${b.file.estimated ? '~' : ''}${fmt(b.file.lines)}</b> lines</span>
    <span><b>${b.file.size >= 1024 ? `${(b.file.size / 1024).toFixed(1)} KB` : `${b.file.size} B`}</b></span>
    ${heat != null ? `<span><b>${heat}×</b> changed</span>` : ''}`;
  const link = $('sel-open');
  if (state.source.fileUrl) { link.href = state.source.fileUrl(b.file.path); link.hidden = false; } else link.hidden = true;
  card.hidden = false;
  const target = new THREE.Vector3(b.x, b.y0 + b.h * 0.55, b.z);
  const dist = THREE.MathUtils.clamp(Math.max(b.h, b.w, b.d) * 3.2, 18, state.city.size * 0.6);
  moveCameraTo(target, dist);
}

function focusDistrict(i) {
  const d = state.city.districts[i];
  select(-1);
  moveCameraTo(new THREE.Vector3(d.x, d.y0, d.z), Math.max(d.w, d.d) * 1.25);
}

function moveCameraTo(target, dist) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.45) { dir.y = 0.45; dir.normalize(); }
  tween = {
    fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
    toPos: target.clone().addScaledVector(dir, dist), toTarget: target,
    t0: performance.now(), dur: 1100,
  };
}

$('sel-close').addEventListener('click', () => select(-1));

// ------------------------------------------------------------------ search

$('search').addEventListener('input', () => {
  const q = $('search').value.trim().toLowerCase();
  const ul = $('search-results');
  if (q.length < 2 || !state.city) { ul.innerHTML = ''; return; }
  const bs = state.city.buildings;
  const hits = [];
  for (let pass = 0; pass < 2 && hits.length < 8; pass++) {
    for (let i = 0; i < bs.length && hits.length < 8; i++) {
      const p = bs[i].file.path.toLowerCase();
      const name = p.slice(p.lastIndexOf('/') + 1);
      if (pass === 0 ? name.includes(q) : !name.includes(q) && p.includes(q)) hits.push(i);
    }
  }
  ul.innerHTML = hits.length
    ? hits.map((i) => {
      const p = bs[i].file.path; const k = p.lastIndexOf('/');
      return `<li data-i="${i}">${esc(p.slice(0, k + 1))}<b>${esc(p.slice(k + 1))}</b></li>`;
    }).join('')
    : '<li class="muted">No matching files</li>';
});
$('search-results').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) select(Number(li.dataset.i));
});

// ------------------------------------------------------------------ fly-through & recording

function buildFlight(fromCurrent) {
  const S = Math.max(40, state.city.size);
  const H = state.city.maxHeight;
  const low = Math.max(S * 0.11, H * 1.3) / S;
  // [angle (×π), radius (×S), height (×S)]
  const keys = [[0.15, 1.5, 1.0], [0.5, 1.05, 0.6], [0.85, 0.72, 0.3], [1.2, 0.52, low], [1.55, 0.55, low * 1.15], [1.9, 0.85, 0.45], [2.25, 1.3, 0.85]];
  const pos = keys.map(([a, r, h]) => new THREE.Vector3(Math.cos(a * Math.PI) * r * S, h * S, Math.sin(a * Math.PI) * r * S));
  const tgt = keys.map(([a, r], i) => {
    const lead = (a + 0.35) * Math.PI; // look slightly ahead of the camera's path
    const k = i === 0 || i === keys.length - 1 ? 0 : 0.18 * S * (1.1 - r);
    return new THREE.Vector3(Math.cos(lead) * k, H * 0.12, Math.sin(lead) * k);
  });
  if (fromCurrent) { pos.unshift(camera.position.clone()); tgt.unshift(controls.target.clone()); }
  return {
    pos: new THREE.CatmullRomCurve3(pos, false, 'centripetal'),
    tgt: new THREE.CatmullRomCurve3(tgt, false, 'centripetal'),
  };
}

function flythrough({ duration = 22000, fromCurrent = true } = {}) {
  return new Promise((resolve) => {
    select(-1);
    tween = null;
    controls.enabled = false;
    controls.autoRotate = false;
    const curves = buildFlight(fromCurrent);
    flight = { ...curves, t0: performance.now(), dur: duration, resolve };
    $('btn-fly').textContent = 'Stop';
    $('btn-fly').classList.add('on');
  });
}

function endFlight(completed) {
  if (!flight) return;
  const { resolve } = flight;
  flight = null;
  controls.enabled = true;
  controls.update();
  $('btn-fly').textContent = 'Fly-through';
  $('btn-fly').classList.remove('on');
  resolve(completed);
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) * 0.35 + t * 0.65;

function stepCamera(now) {
  if (flight) {
    const t = Math.min(1, (now - flight.t0) / flight.dur);
    const e = ease(t);
    camera.position.copy(flight.pos.getPointAt(e));
    controls.target.copy(flight.tgt.getPointAt(e));
    camera.lookAt(controls.target);
    if (t >= 1) endFlight(true);
    return;
  }
  if (tween) {
    const t = Math.min(1, (now - tween.t0) / tween.dur);
    const e = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    if (t >= 1) tween = null;
  }
  controls.update();
}

function fitCanvasForRecording(w, h) {
  const scale = Math.min((innerWidth - 40) / w, (innerHeight - 90) / h, 1);
  canvas.style.width = `${Math.round(w * scale)}px`;
  canvas.style.height = `${Math.round(h * scale)}px`;
}

function setRenderSize(w, h, pixelRatio) {
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);
  camera.aspect = w / h;
  updateViewOffset(w, h);
}

// Keep the city centered in the space left of the side panel (desktop only).
function updateViewOffset(w = innerWidth, h = innerHeight) {
  const panel = $('panel');
  const shift = !state.recording && !panel.hidden && innerWidth > 720
    ? Math.min(w * 0.25, (panel.getBoundingClientRect().width + 16) / 2)
    : 0;
  if (shift > 0) camera.setViewOffset(w, h, shift, 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}

function resize() {
  if (state.recording) { fitCanvasForRecording(state.recording.w, state.recording.h); return; }
  if (!innerWidth || !innerHeight) return; // hidden tab/iframe: keep the last good size
  canvas.style.width = '';
  canvas.style.height = '';
  setRenderSize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2));
}
addEventListener('resize', resize);

async function record() {
  if (!state.city || state.recording) return;
  if (!window.MediaRecorder || !canvas.captureStream) { toast('This browser cannot record video. Try Chrome or Edge.', 6000, true); return; }
  const [w, h] = $('rec-aspect').value.split('x').map(Number);
  const mime = ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((t) => MediaRecorder.isTypeSupported(t));
  state.recording = { w, h, cancelled: false };
  document.body.classList.add('recording');
  $('tooltip').hidden = true;
  setHover(null);
  setRenderSize(w, h, 1);
  fitCanvasForRecording(w, h);

  // Put the camera on the first frame before the recorder starts.
  const curves = buildFlight(false);
  camera.position.copy(curves.pos.getPointAt(0));
  controls.target.copy(curves.tgt.getPointAt(0));
  camera.lookAt(controls.target);
  await nextFrame();

  const stream = canvas.captureStream(60);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });
  $('rec-indicator').hidden = false;
  const started = performance.now();
  const timer = setInterval(() => {
    const s = Math.floor((performance.now() - started) / 1000);
    $('rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  rec.start(250);
  await new Promise((r) => setTimeout(r, 400));
  await flythrough({ duration: 20000, fromCurrent: false });
  await new Promise((r) => setTimeout(r, 600));
  rec.stop();
  await stopped;
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());

  const cancelled = state.recording.cancelled;
  state.recording = null;
  document.body.classList.remove('recording');
  $('rec-indicator').hidden = true;
  resize();
  if (cancelled) { toast('Recording cancelled.'); return; }
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  download(blob, `codecity-${slug(state.source.name)}-${w}x${h}.${ext}`);
  toast(`Saved a ${Math.round(blob.size / 1e6)} MB ${ext.toUpperCase()} to your downloads.`, 5000);
}

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.recording) state.recording.cancelled = true;
  if (flight) endFlight(false);
  else if (state.selected >= 0) select(-1);
});

// ------------------------------------------------------------------ export for Blender

function exportCity() {
  const { city, source } = state;
  const r = (n) => Math.round(n * 1000) / 1000;
  const palette = [];
  const index = new Map();
  const buildings = city.buildings.map((b) => {
    let k = index.get(b.lang.color);
    if (k == null) { k = palette.length; palette.push(b.lang.color); index.set(b.lang.color, k); }
    return [r(b.x), r(b.z), r(b.w), r(b.d), r(b.y0), r(b.h), k];
  });
  const labels = [];
  cityGroup.traverse((o) => {
    if (o.isSprite) labels.push({ text: o.userData.label, x: r(o.position.x), y: r(o.position.y), z: r(o.position.z) });
  });
  const data = {
    format: 'codecity-1', name: source.name, size: r(city.size), maxHeight: r(city.maxHeight), palette,
    buildings, districts: city.districts.map((d) => [r(d.x), r(d.z), r(d.w), r(d.d), r(d.y0), r(d.h), d.depth]),
    labels,
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `codecity-${slug(source.name)}.json`);
  toast('Exported. Open it in Blender with blender/build_city.py (see README).', 6000);
}

// ------------------------------------------------------------------ helpers

function slug(s) { return s.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'city'; }

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

let toastTimer = null;
function toast(msg, ms = 3500, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function showProgress(text) { $('progress').hidden = false; $('progress-text').textContent = text; }
function hideProgress() { $('progress').hidden = true; }

function token() {
  return $('token-input').value.trim();
}
try { $('token-input').value = sessionStorage.getItem('codecity-token') || ''; } catch { /* storage blocked */ }
$('token-input').addEventListener('change', () => {
  try { sessionStorage.setItem('codecity-token', token()); } catch { /* storage blocked */ }
});

// ------------------------------------------------------------------ loading flows

async function loadAndShow(loader) {
  if (state.busy) return;
  state.busy = true;
  try {
    showProgress('Starting…');
    const source = await loader();
    if (!source.files.length) throw new Error('No source files found there.');
    showProgress(`Building ${fmt(source.files.length)} buildings…`);
    await nextFrame();
    if (flight) endFlight(false);
    showCity(source);
    enterCity();
    const url = source.kind === 'github' ? `?repo=${source.name}` : location.pathname;
    history.replaceState(null, '', url);
    if (source.truncated) toast('This repo is huge, so GitHub only sent part of it. Some files are missing from the city.', 8000);
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 7000, true);
    renderRate();
  } finally {
    hideProgress();
    state.busy = false;
  }
}

function enterCity() {
  state.landing = false;
  document.body.classList.remove('landing');
  $('panel').hidden = false;
  const small = innerWidth <= 720; // on phones, keep the city visible and let people expand stats
  $('panel').classList.toggle('collapsed', small);
  $('panel-toggle').textContent = small ? '+' : '–';
  updateViewOffset();
  $('search').value = '';
  $('search-results').innerHTML = '';
  select(-1);
  updatePanel();
  controls.autoRotate = false;
  // Swoop in from high above.
  const home = homeView();
  const S = Math.max(40, state.city.size);
  camera.position.set(S * 1.3, S * 1.6, S * 1.6);
  controls.target.copy(home.target);
  tween = { fromPos: camera.position.clone(), fromTarget: home.target.clone(), toPos: home.pos, toTarget: home.target, t0: performance.now(), dur: 2200 };
}

function showLanding() {
  state.landing = true;
  document.body.classList.add('landing');
  $('panel').hidden = true;
  updateViewOffset();
  select(-1);
  controls.autoRotate = true;
  history.replaceState(null, '', location.pathname);
  setTimeout(() => $('hero-input').focus(), 50);
}

const loadRepo = (repo) => {
  if (!repo.trim()) { toast('Paste a GitHub repo first, like facebook/react.', 4000, true); return; }
  loadAndShow(() => sources.loadGitHub(repo, token(), showProgress));
};

$('hero-form').addEventListener('submit', (e) => { e.preventDefault(); loadRepo($('hero-input').value); });
$('bar-form').addEventListener('submit', (e) => { e.preventDefault(); loadRepo($('bar-input').value); $('bar-input').blur(); });
document.querySelectorAll('.examples button').forEach((b) => b.addEventListener('click', () => {
  $('hero-input').value = b.dataset.repo;
  loadRepo(b.dataset.repo);
}));

$('hero-folder').addEventListener('click', () => $('folder-input').click());
$('hero-zip').addEventListener('click', () => $('zip-input').click());
$('folder-input').addEventListener('change', (e) => {
  const list = [...e.target.files];
  e.target.value = '';
  if (!list.length) return;
  const name = list[0].webkitRelativePath.split('/')[0] || 'folder';
  const entries = list.map((file) => ({ path: file.webkitRelativePath.split('/').slice(1).join('/'), file }));
  loadAndShow(() => sources.loadLocal(entries, name, showProgress));
});
$('zip-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) loadAndShow(() => sources.loadZip(file, showProgress));
});

// Drag & drop anywhere
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  // Entries must be grabbed synchronously, before any await.
  const entries = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const first = e.dataTransfer.files[0];
  if (entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)) {
    loadAndShow(() => sources.loadZip(first, showProgress));
    return;
  }
  if (!entries.length) return;
  loadAndShow(async () => {
    const { name, list } = await collectEntries(entries);
    return sources.loadLocal(list, name, showProgress);
  });
});

function readAll(dir) {
  return new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
}

async function collectEntries(entries) {
  let name = 'files';
  let roots = entries;
  if (entries.length === 1 && entries[0].isDirectory) {
    name = entries[0].name;
    roots = await readAll(entries[0]);
  }
  const list = [];
  async function walk(entry, path) {
    if (entry.isDirectory) {
      if (sources.isSkippedDir(entry.name)) return;
      const kids = await readAll(entry);
      await Promise.all(kids.map((k) => walk(k, `${path}/${k.name}`)));
    } else if (!sources.skipPath(path, true)) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      list.push({ path, file });
      if (list.length % 500 === 0) showProgress(`Found ${fmt(list.length)} files…`);
    }
  }
  showProgress('Scanning folder…');
  await Promise.all(roots.map((r) => walk(r, r.name)));
  return { name, list };
}

// Panel buttons
$('btn-fly').addEventListener('click', () => { if (flight) endFlight(false); else flythrough(); });
$('btn-theme').addEventListener('click', () => applyTheme(state.theme === 'night' ? 'day' : 'night'));
$('btn-record').addEventListener('click', record);
$('btn-export').addEventListener('click', exportCity);
$('btn-new').addEventListener('click', showLanding);
$('brand').addEventListener('click', showLanding);
$('panel-toggle').addEventListener('click', () => {
  const c = $('panel').classList.toggle('collapsed');
  $('panel-toggle').textContent = c ? '+' : '–';
});
$('btn-share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?repo=${state.source.name}`;
  try { await navigator.clipboard.writeText(url); toast(`Link copied: ${url}`); } catch { toast(url, 8000); }
});
$('btn-heat').addEventListener('click', async () => {
  if (state.heat) {
    state.colorMode = state.colorMode === 'heat' ? 'lang' : 'heat';
    recolor(); updatePanel();
    return;
  }
  if (state.busy) return;
  const count = token() ? 100 : 30;
  if (sources.rate.remaining != null && sources.rate.remaining < count + 1) {
    toast(`Hotspots read the last ${count} commits, which takes ${count + 1} GitHub requests. You have ${sources.rate.remaining} left this hour. Add a token for more.`, 8000, true);
    return;
  }
  state.busy = true;
  try {
    showProgress('Reading commit history…');
    state.heat = await sources.loadHotspots(state.source, token(), count, showProgress);
    state.colorMode = 'heat';
    recolor(); updatePanel();
  } catch (err) {
    toast(err.message || String(err), 7000, true);
  } finally {
    hideProgress(); renderRate(); state.busy = false;
  }
});

// ------------------------------------------------------------------ main loop

function animate(now) {
  requestAnimationFrame(animate);
  stepCamera(now);
  if (pointerDirty && pointerIn && !state.landing && !flight && !state.recording && !downAt) {
    pointerDirty = false;
    setHover(pick());
  }
  composer.render();
}

// Debug/automation hook (used for testing and for scripted recordings).
window.codecity = { state, camera, controls, flythrough, exportCity, applyTheme, loadRepo };

resize();
showCity(sources.demoSource());
{
  const home = homeView();
  camera.position.copy(home.pos);
  controls.target.copy(home.target);
  controls.autoRotate = true;
}
requestAnimationFrame(animate);

const initial = new URLSearchParams(location.search).get('repo');
if (initial) {
  $('hero-input').value = initial;
  loadRepo(initial);
}
