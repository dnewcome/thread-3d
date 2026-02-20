import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const STATUS_EL = document.getElementById('status');
const CANVAS = document.getElementById('canvas');

// ─── LED addressing constants ─────────────────────────────────────────────────
const NUM_STRANDS = 12;
const LEDS_PER_STRAND = 600;
const TOTAL_LEDS = NUM_STRANDS * LEDS_PER_STRAND;
const LED_OFF_COLOR = new THREE.Color(0.04, 0.04, 0.04); // just above background (0x0a0a0a)

// ─── Three.js setup ───────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas: CANVAS, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, -60, 20);
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, CANVAS);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 3.5);
controls.update();

// Ambient + subtle directional for the structural model
scene.add(new THREE.AmbientLight(0x222222));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
dirLight.position.set(0, -1, 2);
scene.add(dirLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── STL binary parser ────────────────────────────────────────────────────────
// Returns { centroids: [{x,y,z}], geometry: THREE.BufferGeometry }
function parseSTL(buf) {
  const view = new DataView(buf);
  const numTri = view.getUint32(80, true);

  const centroids = [];
  const positions = new Float32Array(numTri * 9);
  const normals = new Float32Array(numTri * 9);

  let off = 84;
  for (let i = 0; i < numTri; i++) {
    const nx = view.getFloat32(off, true), ny = view.getFloat32(off + 4, true), nz = view.getFloat32(off + 8, true);
    off += 12;

    let sx = 0, sy = 0, sz = 0;
    for (let v = 0; v < 3; v++) {
      const base = (i * 3 + v) * 3;
      const vx = view.getFloat32(off, true);
      const vy = view.getFloat32(off + 4, true);
      const vz = view.getFloat32(off + 8, true);
      positions[base] = vx; positions[base + 1] = vy; positions[base + 2] = vz;
      normals[base] = nx; normals[base + 1] = ny; normals[base + 2] = nz;
      sx += vx; sy += vy; sz += vz;
      off += 12;
    }
    off += 2; // attribute bytes
    centroids.push({ x: sx / 3, y: sy / 3, z: sz / 3 });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

  return { centroids, geometry: geo };
}

// ─── LED position extraction ──────────────────────────────────────────────────
// The STL triangles are ordered: all triangles for strand 0, then strand 1, etc.
// Within each strand, triangles for each LED chip are consecutive.
//
// Strand boundaries: a large positional jump between consecutive triangle centroids.
// Within each strand: divide triangles evenly into LEDS_PER_STRAND groups and
// average their centroids. This is robust regardless of exact per-LED triangle count.
const STRAND_JUMP_THRESHOLD = 0.5; // mm — gap between last tri of one strand and first of next

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function extractLEDPositions(centroids) {
  // Split into strands by detecting large positional jumps
  const strandRanges = [];
  let strandStart = 0;
  for (let i = 1; i < centroids.length; i++) {
    if (dist3(centroids[i], centroids[i - 1]) > STRAND_JUMP_THRESHOLD) {
      strandRanges.push([strandStart, i]);
      strandStart = i;
    }
  }
  strandRanges.push([strandStart, centroids.length]);

  console.log(`Found ${strandRanges.length} strands`);

  const strandLEDs = [];
  for (let s = 0; s < strandRanges.length; s++) {
    const [start, end] = strandRanges[s];
    const triCount = end - start;

    // Divide triangles evenly into LEDS_PER_STRAND groups
    const ledPositions = [];
    for (let led = 0; led < LEDS_PER_STRAND; led++) {
      const triStart = start + Math.round(led * triCount / LEDS_PER_STRAND);
      const triEnd   = start + Math.round((led + 1) * triCount / LEDS_PER_STRAND);
      let sx = 0, sy = 0, sz = 0;
      const count = triEnd - triStart;
      for (let t = triStart; t < triEnd; t++) {
        sx += centroids[t].x; sy += centroids[t].y; sz += centroids[t].z;
      }
      ledPositions.push(new THREE.Vector3(sx / count, sy / count, sz / count));
    }

    console.log(`  Strand ${s}: ${ledPositions.length} LEDs from ${triCount} triangles`);
    strandLEDs.push(ledPositions);
  }

  return strandLEDs;
}

// ─── InstancedMesh for LEDs ───────────────────────────────────────────────────
let ledMesh = null;

function buildLEDMesh(strandLEDs) {
  // Size LEDs relative to the overall model bounds so they're visible at the
  // sculpture viewing distance, regardless of the model's unit scale.
  const box = new THREE.Box3();
  for (const strand of strandLEDs) for (const p of strand) box.expandByPoint(p);
  const ledSize = box.getSize(new THREE.Vector3()).length() / 300;

  const geo = new THREE.BoxGeometry(ledSize, ledSize, ledSize);
  // White base color; instance colors applied via setColorAt
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  let totalLEDs = 0;
  for (const strand of strandLEDs) totalLEDs += strand.length;

  const mesh = new THREE.InstancedMesh(geo, mat, totalLEDs);

  const dummy = new THREE.Object3D();
  const black = LED_OFF_COLOR.clone();
  let idx = 0;
  for (const strand of strandLEDs) {
    for (const pos of strand) {
      dummy.position.copy(pos);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      mesh.setColorAt(idx, black);
      idx++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;

  scene.add(mesh);
  return mesh;
}

// ─── Apply Art-Net color data to LED instances ────────────────────────────────
// colorsFloat32: Float32Array of length 7200*3, indexed as [globalLED*3 + channel]
// globalLED = strand*600 + ledInStrand  (with reversed strands already resolved by main.js)
function applyLEDColors(strandLEDs, colorsFloat32) {
  if (!ledMesh) return;
  const color = new THREE.Color();
  let globalOffset = 0;

  for (let s = 0; s < strandLEDs.length; s++) {
    const ledCount = strandLEDs[s].length;
    for (let li = 0; li < ledCount; li++) {
      const globalLED = s * LEDS_PER_STRAND + li;
      const r = colorsFloat32[globalLED * 3];
      const g = colorsFloat32[globalLED * 3 + 1];
      const b = colorsFloat32[globalLED * 3 + 2];
      if (r === 0 && g === 0 && b === 0) {
        color.copy(LED_OFF_COLOR);
      } else {
        color.setRGB(r, g, b);
      }
      ledMesh.setColorAt(globalOffset + li, color);
    }
    globalOffset += ledCount;
  }
  ledMesh.instanceColor.needsUpdate = true;
}

// ─── Background structural mesh from parsed geometry ─────────────────────────
function buildBackgroundMesh(geometry) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2e,
    roughness: 0.8,
    metalness: 0.2,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  scene.add(mesh);
  return mesh;
}

// ─── Main init ────────────────────────────────────────────────────────────────
let strandLEDs = null;

async function init() {
  STATUS_EL.textContent = 'Loading model…';

  // Read model file via IPC (avoids file:// fetch restrictions)
  const stlBuffer = await window.artnet.readModelFile();
  const { centroids, geometry } = parseSTL(stlBuffer);

  buildBackgroundMesh(geometry);

  STATUS_EL.textContent = 'Extracting LED positions…';
  strandLEDs = extractLEDPositions(centroids);

  ledMesh = buildLEDMesh(strandLEDs);

  // Center scene on model
  const box = new THREE.Box3();
  for (const strand of strandLEDs) for (const p of strand) box.expandByPoint(p);
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.set(center.x, center.y - 80, center.z + 20);
  controls.update();

  STATUS_EL.textContent = 'Art-Net: waiting…';

  // Listen for Art-Net LED updates from main process
  window.artnet.onLEDUpdate((colorsFloat32) => {
    STATUS_EL.textContent = `Art-Net: live`;
    STATUS_EL.className = 'active';
    applyLEDColors(strandLEDs, colorsFloat32);
  });
}

// ─── Render loop ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

init().catch(console.error);
animate();
