// Same-origin, local native conversion. The service retains uploads and diagnostics
// in private instance state; the browser also carries successful originals in .tiksi.
let capabilities;
export async function converterCapabilities() {
  const response=await fetch('/api/model-conversion/capabilities');
  if(!response.ok) throw new Error('Native conversion needs the local Tiksi server. Open this project in the local branch preview.');
  capabilities=await response.json();return capabilities;
}
export async function nativeConvert(buffer,extension,target='glb') {
  const cap=capabilities || await converterCapabilities();
  const response=await fetch('/api/model-conversion/convert',{method:'POST',headers:{'X-Tiksi-Token':cap.token,'X-Model-Extension':extension,'X-Model-Target':target,'Content-Type':'application/octet-stream'},body:buffer});
  if(!response.ok){const info=await response.json();const error=new Error(info.error);error.jobId=info.jobId;throw error;}
  return {buffer:await response.arrayBuffer(),format:response.headers.get('X-Tiksi-Format'),warnings:JSON.parse(response.headers.get('X-Tiksi-Warnings')||'[]'),conversionJobId:response.headers.get('X-Tiksi-Job')};
}
export async function conversionJobs() {
  const cap=capabilities || await converterCapabilities();
  const response=await fetch('/api/model-conversion/jobs',{headers:{'X-Tiksi-Token':cap.token}});
  if(!response.ok)throw new Error('Could not read conversion history');return (await response.json()).jobs;
}
export async function conversionPacket(id,remove=false) {
  const cap=capabilities || await converterCapabilities();
  const response=await fetch('/api/model-conversion/jobs/'+encodeURIComponent(id),{method:remove?'DELETE':'GET',headers:{'X-Tiksi-Token':cap.token}});
  if(!response.ok)throw new Error('Could not '+(remove?'delete':'download')+' conversion handoff');return remove?null:response.blob();
}

export async function cancelConversion() { const cap=capabilities || await converterCapabilities();await fetch('/api/model-conversion/cancel',{method:'POST',headers:{'X-Tiksi-Token':cap.token}}); }
