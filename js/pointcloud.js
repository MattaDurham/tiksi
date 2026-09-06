// Point-cloud rendering: round, soft-edged, per-point coloured points with size attenuation
// and a screen-size clamp, three colour modes, and a uniform-stride decimator so huge
// clouds stay within a point budget without losing their colour alignment.

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec3 pcolor;
  uniform float uSize, uScale, uMinPx, uMaxPx, uMinY, uMaxY;
  uniform int uMode;
  uniform vec3 uSolid;
  varying vec3 vColor;
  #include <clipping_planes_pars_vertex>
  vec3 ramp(float t) {
    // Cool-to-warm height ramp that stays readable on the dark console.
    vec3 a = vec3(0.16, 0.36, 0.62), b = vec3(0.36, 0.72, 0.68), c = vec3(0.93, 0.78, 0.35), d = vec3(0.91, 0.35, 0.22);
    return t < 0.33 ? mix(a, b, t / 0.33) : (t < 0.66 ? mix(b, c, (t - 0.33) / 0.33) : mix(c, d, (t - 0.66) / 0.34));
  }
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float px = uSize * uScale / max(0.02, -mvPosition.z);
    gl_PointSize = clamp(px, uMinPx, uMaxPx);
    if (uMode == 1) {
      float wy = (modelMatrix * vec4(position, 1.0)).y;
      vColor = ramp(clamp((wy - uMinY) / max(0.001, uMaxY - uMinY), 0.0, 1.0));
    } else if (uMode == 2) {
      vColor = uSolid;
    } else {
      vColor = pow(pcolor, vec3(2.2));
    }
    #include <clipping_planes_vertex>
  }`;

const FRAG = /* glsl */`
  varying vec3 vColor;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float rim = 1.0 - smoothstep(0.14, 0.25, r2) * 0.4;
    gl_FragColor = vec4(vColor * rim, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const _size = new THREE.Vector2();
const _box = new THREE.Box3();

// data: { positions: Float32Array, colors: Uint8Array|null, count }
export function makePointCloud(data, scan) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  let colors = data.colors;
  if (!colors) {
    colors = new Uint8Array(data.count * 3);
    colors.fill(200);
  }
  geo.setAttribute('pcolor', new THREE.BufferAttribute(colors, 3, true));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, clipping: true,
    uniforms: {
      uSize: { value: scan.pointSize || 0.012 }, uScale: { value: 600 }, uMinPx: { value: 2 }, uMaxPx: { value: 22 },
      uMode: { value: 0 }, uSolid: { value: new THREE.Color('#e8973a') }, uMinY: { value: 0 }, uMaxY: { value: 1 },
    },
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = true;
  pts.userData = { pointCloud: true, count: data.count, hasColor: !!data.colors };
  // The perspective scale factor depends on the drawing buffer and the camera; refresh it per draw.
  pts.onBeforeRender = (renderer, scene, camera) => {
    renderer.getDrawingBufferSize(_size);
    const fov = camera.isPerspectiveCamera ? camera.fov : 50;
    mat.uniforms.uScale.value = _size.y / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
  };
  updatePointCloud(pts, scan);
  return pts;
}

export function updatePointCloud(pts, scan) {
  const u = pts.material.uniforms;
  u.uSize.value = scan.pointSize || 0.012;
  const mode = scan.pointColor === 'height' ? 1 : (scan.pointColor === 'solid' ? 2 : 0);
  u.uMode.value = pts.userData.hasColor || mode !== 0 ? mode : 1;   // colourless clouds default to the ramp
  if (u.uMode.value === 1) {
    pts.updateWorldMatrix(true, false);
    _box.copy(pts.geometry.boundingBox).applyMatrix4(pts.matrixWorld);
    u.uMinY.value = _box.min.y; u.uMaxY.value = _box.max.y;
  }
}

// Keep every k-th point so the cloud fits the budget; colours stay aligned with positions.
export function decimate(data, budget) {
  if (!budget || data.count <= budget) return data;
  const stride = Math.ceil(data.count / budget);
  const n = Math.floor(data.count / stride);
  const positions = new Float32Array(n * 3);
  const colors = data.colors ? new Uint8Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const s = i * stride * 3, d = i * 3;
    positions[d] = data.positions[s]; positions[d + 1] = data.positions[s + 1]; positions[d + 2] = data.positions[s + 2];
    if (colors) { colors[d] = data.colors[s]; colors[d + 1] = data.colors[s + 1]; colors[d + 2] = data.colors[s + 2]; }
  }
  return { positions, colors, count: n, hasColor: data.hasColor, decimatedFrom: data.count };
}

// Pull a plain {positions, colors, count} out of a BufferGeometry produced by a three loader
// (PCDLoader, XYZLoader, PLYLoader); float colours are converted to bytes.
export function fromGeometry(geo) {
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const positions = pos.array instanceof Float32Array && pos.itemSize === 3 ? pos.array.slice(0, count * 3) : new Float32Array(count * 3);
  if (!(pos.array instanceof Float32Array && pos.itemSize === 3)) for (let i = 0; i < count; i++) { positions[i * 3] = pos.getX(i); positions[i * 3 + 1] = pos.getY(i); positions[i * 3 + 2] = pos.getZ(i); }
  const col = geo.getAttribute('color');
  let colors = null;
  if (col) {
    colors = new Uint8Array(count * 3);
    const scale = col.normalized || col.array instanceof Uint8Array ? 1 : 255;
    for (let i = 0; i < count; i++) {
      colors[i * 3] = col.getX(i) * (col.array instanceof Uint8Array ? 1 : scale);
      colors[i * 3 + 1] = col.getY(i) * (col.array instanceof Uint8Array ? 1 : scale);
      colors[i * 3 + 2] = col.getZ(i) * (col.array instanceof Uint8Array ? 1 : scale);
    }
  }
  return { positions, colors, count, hasColor: !!colors };
}
