const database = () => new Promise((resolve,reject) => {
  const request = indexedDB.open('tiksi.offline.v1',1);
  request.onupgradeneeded = () => request.result.createObjectStore('snapshot');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
export async function saveOfflineSnapshot(data) {
  const db = await database();
  try { await new Promise((resolve,reject) => { const tx=db.transaction('snapshot','readwrite');tx.objectStore('snapshot').put(structuredClone(data),'last');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error); }); }
  finally { db.close(); }
}
export async function readOfflineSnapshot() {
  const db=await database();
  try { return await new Promise((resolve,reject) => {const r=db.transaction('snapshot').objectStore('snapshot').get('last');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}); }
  finally { db.close(); }
}
