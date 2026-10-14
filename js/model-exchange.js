// Static mesh interchange. No viewport helpers, private photos, scope or project metadata
// are written to exchange files. Save .tiksi separately to keep the editable floorplan.
import { nativeConvert } from './native-conversion.js';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { buildPropertyGroup, disposeBuilt } from './geometry.js';
import { getFile, materialById } from './store.js';
import { loadMesh, applyScanTransform, disposeScanObject } from './scans.js';
import { applyModelMaterials } from './model-materials.js';
import { pendingTextureJobs } from './textures.js';

const xml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export const EXCHANGE_FORMATS = [
  ['glb', 'GLB — Blender / current SketchUp / Rhino', 'Meshes, hierarchy, UVs and PBR textures; metres, Y-up. Best choice.'],
  ['blend', 'Blender project — native .blend', 'Editable native Blender scene with packed materials. Uses local Blender.'],
  ['ifc', 'IFC4 — BIM exchange', 'Classified static building meshes, colours, source IDs and hierarchy. Local IFC engine. Editable design stays in .tiksi.'],
  ['skp', 'SketchUp model — native .skp', 'Editable grouped faces, colours and diffuse textures. Uses local SketchUp SDK. PBR maps remain in GLB/source.'],
  ['dae', 'COLLADA ZIP — SketchUp / older modelers', 'Static triangles, names, diffuse textures and colours. PBR maps are reduced. Unzip before opening.'],
  ['obj', 'OBJ ZIP — broad mesh compatibility', 'Static triangles, names, normals, UVs and diffuse MTL textures. Metres, Y-up; unzip before opening.'],
  ['stl', 'STL — geometry only', 'Static triangles only. No materials, names or units; choose metres when opening.'],
];

async function meshForScan(scan) {
  if (scan.kind !== 'mesh') throw new Error('Only meshes can be edited as 3D models. Export point clouds/splats as their original files.');
  const rec = await getFile(scan.id);
  if (!rec?.buffer) throw new Error('Missing model bytes: ' + scan.name);
  const obj = await loadMesh(rec.buffer, scan.format);
  await applyModelMaterials(scan, obj);
  const wrapper = new THREE.Group(), inner = new THREE.Group();
  inner.add(obj); wrapper.add(inner); wrapper.userData.inner = inner;
  applyScanTransform(scan, wrapper);
  wrapper.visible=true; // Explicit exports can include a hidden before-state model.
  return wrapper;
}

function cleanExport(root) {
  const copyNode = source => {
    const data = source.userData;
    let copy;
    source.userData = {};
    try { copy = source.clone(false); } finally { source.userData = data; }
    copy.userData = { kind: data.kind, id: data.id, ...Object.fromEntries(['ifcGlobalId','ifcClass','ifcProperties','rhinoObjectId','tiksiElementId','tiksiElementKind'].filter(key=>data[key]!=null).map(key=>[key,data[key]])) };
    for (const child of source.children) copy.add(copyNode(child));
    return copy;
  };
  const clone = copyNode(root);
  clone.traverse(o => {
    const data = o.userData;
    if (data.kind && data.id) o.name = data.kind + ':' + data.id;
    const metadata=Object.fromEntries(['ifcGlobalId','ifcClass','ifcProperties','rhinoObjectId','tiksiElementId','tiksiElementKind'].filter(key=>data[key]!=null).map(key=>[key,data[key]]));
    o.userData = { ...metadata, ...(data.kind && data.id ? { tiksiElementId: data.id, tiksiElementKind: data.kind } : {}) };
    if (o.isMesh) {
      const material = m => {
        const copy = m.clone(), record = materialById(m.userData.materialId || m.userData.tiksiMaterialId);
        copy.name = record ? record.name + ' [' + record.id + ']' : m.name || 'Surface';
        copy.userData = record ? { tiksiMaterialId: record.id } : {};
        return copy;
      };
      o.material = Array.isArray(o.material) ? o.material.map(material) : material(o.material);
    }
  });
  return clone;
}

export async function exportModel(prop, { format = 'glb', source = 'design', scanId, includeModels = false } = {}) {
  if (!EXCHANGE_FORMATS.some(f => f[0] === format)) throw new Error('Unsupported export format');
  const root = new THREE.Group(), disposable = []; let built, clone;
  try {
    if (source === 'model') {
      const scan = (prop.scans || []).find(s => s.id === scanId);
      if (!scan) throw new Error('Select a model to export');
      const mesh = await meshForScan(scan); root.add(mesh); disposable.push(mesh);
    } else {
      built = buildPropertyGroup(prop); root.add(built);
      if (includeModels) for (const scan of prop.scans || []) if (scan.visible !== false) {
        if (scan.kind !== 'mesh') throw new Error('Visible point clouds/splats cannot be included in this mesh export. Hide them or export their originals.');
        const mesh = await meshForScan(scan); root.add(mesh); disposable.push(mesh);
      }
    }
    const deadline = performance.now() + 30000;
    while (pendingTextureJobs()) { if (performance.now() > deadline) throw new Error('Material textures are still loading. Retry when ready.'); await new Promise(r => setTimeout(r, 50)); }
    clone = cleanExport(root);
    let vertices = 0; clone.traverse(o => { if (o.isMesh) vertices += o.geometry.getAttribute('position')?.count || 0; });
    if (!vertices) throw new Error('There is no mesh geometry to export');
    const base = String(prop.name || 'model').replace(/[^\p{L}\p{N}_ -]/gu, '').trim() || 'model';
    if(format==='blend') {
      const glb=await new GLTFExporter().parseAsync(clone,{binary:true,maxTextureSize:Infinity});
      const converted=await nativeConvert(glb,'.glb','blend');
      return {name:base+'.blend',blob:new Blob([converted.buffer]),warnings:converted.warnings};
    }
    if(format==='skp' || format==='ifc') {
      const meshes=[];
      for(const part of triangles(clone)) {
        const c=part.m.color.clone().convertLinearToSRGB();
        const material={name:part.m.name,color:[c.r,c.g,c.b,part.m.opacity ?? 1]};
        if(format==='skp' && part.m.map) {const bytes=await textureBytes(part.m.map);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));material.texture=btoa(binary);}
        meshes.push({name:part.name,positions:part.p,uv:part.t,material,extras:part.extras});
      }
      const converted=await nativeConvert(new TextEncoder().encode(JSON.stringify({meshes})),'.json',format);
      return {name:base+'.'+format,blob:new Blob([converted.buffer]),warnings:converted.warnings};
    }
    if (format === 'glb') return { name: base + '.glb', blob: new Blob([await new GLTFExporter().parseAsync(clone, { binary: true, maxTextureSize: Infinity })], {type:'model/gltf-binary'}) };
    return exportStatic(clone, format, base);
  } finally {
    clone?.traverse(o => { for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) m.dispose(); });
    if (built) disposeBuilt(built);
    disposable.forEach(disposeScanObject);
  }
}

// Expanded, world-space triangles keep group materials and baked texture UV transforms.
function triangles(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverseVisible(o => {
    if (!o.isMesh) return;
    if (o.isSkinnedMesh || o.morphTargetInfluences?.some(v => v !== 0)) throw new Error('Bake skinning/morphs in the source editor before static export. GLB can preserve the rig.');
    const g = o.geometry, pos = g.getAttribute('position'), uv = g.getAttribute('uv'), normal = g.getAttribute('normal'), idx = g.index;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{start:0,count:idx?.count || pos.count,materialIndex:0}];
    for (const group of groups) {
      const m = mats[group.materialIndex || 0]; if (!m) continue;
      m.map?.updateMatrix();
      const p = [], n = [], t = [], norm = new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
      const start = Math.max(group.start, g.drawRange.start), end = Math.min(group.start + group.count, g.drawRange.start + g.drawRange.count, idx?.count || pos.count);
      for (let i = start; i + 2 < end; i += 3) {
        const order = o.matrixWorld.determinant() < 0 ? [i, i + 2, i + 1] : [i, i + 1, i + 2];
        const coords = order.map(j => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(j) : j).applyMatrix4(o.matrixWorld));
        const face = new THREE.Vector3().subVectors(coords[1],coords[0]).cross(new THREE.Vector3().subVectors(coords[2],coords[0])).normalize();
        order.forEach((j,k) => {
          const v = idx ? idx.getX(j) : j;
          p.push(...coords[k].toArray()); n.push(...(normal ? new THREE.Vector3().fromBufferAttribute(normal,v).applyNormalMatrix(norm) : face).toArray());
          const u = uv ? new THREE.Vector2().fromBufferAttribute(uv,v) : new THREE.Vector2();
          if (m.map) u.applyMatrix3(m.map.matrix);
          t.push(u.x,u.y);
        });
      }
      if (p.length) parts.push({name:o.name || 'Mesh',m,p,n,t,extras:o.userData});
    }
  });
  return parts;
}
function textureBytes(map) {
  const img = map.image;
  if (!img) throw new Error('A diffuse texture has no image');
  const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  // glTF loaded textures use flipY=false; COLLADA/OBJ loaders use image-space UVs.
  if (!map.flipY) { ctx.translate(0,canvas.height); ctx.scale(1,-1); }
  ctx.drawImage(img,0,0);
  return fetch(canvas.toDataURL('image/png')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b));
}
async function exportStatic(root, format, base) {
  const parts = triangles(root);
  if (format === 'stl') {
    const count = parts.reduce((n,p)=>n+p.p.length/9,0), buffer = new ArrayBuffer(84 + count * 50), dv = new DataView(buffer); dv.setUint32(80,count,true); let offset=84;
    for (const part of parts) for(let i=0;i<part.p.length;i+=9) {
      const a=new THREE.Vector3(...part.p.slice(i,i+3)), b=new THREE.Vector3(...part.p.slice(i+3,i+6)), c=new THREE.Vector3(...part.p.slice(i+6,i+9));
      const normal=b.sub(a).cross(c.sub(a)).normalize();
      [...normal.toArray(),...part.p.slice(i,i+9)].forEach((v,j)=>dv.setFloat32(offset+j*4,v,true)); offset+=50;
    }
    return {name:base+'.stl',blob:new Blob([buffer],{type:'model/stl'})};
  }
  const files = {}, images = [], effects = [], materials = [], geometry = [], nodes = [], obj = ['mtllib model.mtl'], mtl = []; let vOffset=1;
  for (let i=0;i<parts.length;i++) {
    const {name,m,p,n,t}=parts[i], id='mesh'+i, mid='material'+i, tex=m.map ? 'textures/'+mid+'.png' : null;
    if (tex) files[tex]=await textureBytes(m.map);
    const color=m.color?.clone().convertLinearToSRGB() || new THREE.Color(1,1,1), rgba=[color.r,color.g,color.b,m.opacity ?? 1].join(' ');
    if (format === 'obj') {
      mtl.push('newmtl '+mid+'\n# '+m.name.replace(/[\r\n]/g,' ')+'\nKd '+[color.r,color.g,color.b].join(' ')+'\nd '+(m.opacity ?? 1)+(tex?'\nmap_Kd '+tex:''));
      obj.push('o '+name.replace(/[\s#]/g,'_')+'\nusemtl '+mid);
      for(let j=0;j<p.length;j+=3) obj.push('v '+p.slice(j,j+3).join(' '));
      for(let j=0;j<t.length;j+=2) obj.push('vt '+t.slice(j,j+2).join(' '));
      for(let j=0;j<n.length;j+=3) obj.push('vn '+n.slice(j,j+3).join(' '));
      for(let j=0;j<p.length/3;j+=3) obj.push('f '+[0,1,2].map(k=>{const v=vOffset+j+k;return v+'/'+v+'/'+v;}).join(' '));
      vOffset+=p.length/3; continue;
    }
    if(tex) images.push(`<image id="${mid}-image"><init_from>${tex}</init_from></image>`);
    const params=tex?`<newparam sid="surface"><surface type="2D"><init_from>${mid}-image</init_from></surface></newparam><newparam sid="sampler"><sampler2D><source>surface</source><wrap_s>WRAP</wrap_s><wrap_t>WRAP</wrap_t></sampler2D></newparam>`:'';
    effects.push(`<effect id="${mid}-effect"><profile_COMMON>${params}<technique sid="common"><lambert><diffuse>${tex?'<texture texture="sampler" texcoord="UVSET0"/>':`<color>${rgba}</color>`}</diffuse><transparent opaque="A_ONE"><color>1 1 1 ${m.opacity ?? 1}</color></transparent><transparency><float>1</float></transparency></lambert></technique></profile_COMMON></effect>`);
    materials.push(`<material id="${mid}" name="${xml(m.name)}"><instance_effect url="#${mid}-effect"/></material>`);
    const src=(suffix,data,stride,params)=>`<source id="${id}-${suffix}"><float_array id="${id}-${suffix}-array" count="${data.length}">${data.join(' ')}</float_array><technique_common><accessor source="#${id}-${suffix}-array" count="${data.length/stride}" stride="${stride}">${params.map(v=>`<param name="${v}" type="float"/>`).join('')}</accessor></technique_common></source>`;
    geometry.push(`<geometry id="${id}" name="${xml(name)}"><mesh>${src('pos',p,3,['X','Y','Z'])}${src('norm',n,3,['X','Y','Z'])}${src('uv',t,2,['S','T'])}<vertices id="${id}-vertices"><input semantic="POSITION" source="#${id}-pos"/></vertices><triangles material="${mid}" count="${p.length/9}"><input semantic="VERTEX" source="#${id}-vertices" offset="0"/><input semantic="NORMAL" source="#${id}-norm" offset="1"/><input semantic="TEXCOORD" source="#${id}-uv" offset="2" set="0"/><p>${Array.from({length:p.length/3},(_,j)=>`${j} ${j} ${j}`).join(' ')}</p></triangles></mesh></geometry>`);
    nodes.push(`<node id="node${i}" name="${xml(name)}"><instance_geometry url="#${id}"><bind_material><technique_common><instance_material symbol="${mid}" target="#${mid}"><bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/></instance_material></technique_common></bind_material></instance_geometry></node>`);
  }
  if(format==='obj') {files['model.obj']=strToU8(obj.join('\n'));files['model.mtl']=strToU8(mtl.join('\n'));}
  else {
    const now=new Date().toISOString();
    files['model.dae']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><authoring_tool>Tiksi</authoring_tool></contributor><created>${now}</created><modified>${now}</modified><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset><library_images>${images.join('')}</library_images><library_effects>${effects.join('')}</library_effects><library_materials>${materials.join('')}</library_materials><library_geometries>${geometry.join('')}</library_geometries><library_visual_scenes><visual_scene id="Scene" name="Scene">${nodes.join('')}</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>`);
  }
  files['README.txt']=strToU8('Tiksi mesh exchange. Unzip first, then import model.'+format+'. Coordinates: metres, Y-up. Static geometry, diffuse textures and colours only. PBR shading, procedural modeling, scope, budgets, photos and editable floorplan semantics do not travel in this format. Keep your .tiksi project.');
  return {name:base+'.'+format+'.zip',blob:new Blob([zipSync(files)],{type:'application/zip'})};
}
