const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let child, base, tmp;
async function waitReady() {
  for (let i=0;i<80;i++) {
    try { const r=await fetch(base+'/api/health'); if(r.ok) return; } catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Server did not start');
}
async function request(route, {method='GET',body,cookie}={}) {
  const r=await fetch(base+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  let data={}; try{data=await r.json()}catch{}
  return {status:r.status,data,cookie:r.headers.get('set-cookie')};
}
test('GestionPro RDC API integration simulation', {timeout:20000}, async t=>{
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gestionpro-test-'));
  const port=3190+Math.floor(Math.random()*500);
  base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_PATH:path.join(tmp,'test.sqlite')},stdio:['ignore','pipe','pipe']});
  let stderr=''; child.stderr.on('data',x=>stderr+=x.toString());
  t.after(()=>{if(child&&!child.killed)child.kill('SIGINT');try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}});
  await waitReady();
  let r=await request('/api/health'); assert.equal(r.status,200); assert.equal(r.data.ok,true);
  r=await request('/api/login',{method:'POST',body:{email:'demo@gestionpro.cd',password:'GestionPro2026!'}});assert.equal(r.status,200);const demoCookie=r.cookie.split(';')[0];
  r=await request('/api/me',{cookie:demoCookie});assert.equal(r.status,200);assert.equal(r.data.companyName,'Entreprise Démo RDC');
  r=await request('/api/inventory',{cookie:demoCookie});assert.equal(r.status,200);assert.ok(r.data.products.length>=4);assert.ok(r.data.warehouses.length>=2);
  const product=r.data.products[0], warehouse=r.data.warehouses[0];
  r=await request('/api/movements',{method:'POST',cookie:demoCookie,body:{productId:product.id,warehouseId:warehouse.id,reason:'PURCHASE',quantity:5,note:'Test automatisé'}});assert.equal(r.status,201);
  r=await request('/api/movements',{method:'POST',cookie:demoCookie,body:{productId:product.id,warehouseId:warehouse.id,reason:'ISSUE',quantity:999999,note:'Test stock insuffisant'}});assert.equal(r.status,409);
  r=await request('/api/transactions',{method:'POST',cookie:demoCookie,body:{kind:'INCOME',label:'Test automatisé',amount:123,currency:'USD',category:'Test'}});assert.equal(r.status,201);
  r=await request('/api/simulation',{method:'POST',cookie:demoCookie,body:{}});assert.equal(r.status,201);assert.equal(r.data.stock,17);
  r=await request('/api/dashboard',{cookie:demoCookie});assert.equal(r.status,200);assert.ok(Number(r.data.products)>=5);assert.ok(Number(r.data.vehicles)>=4);
  r=await request('/api/signup',{method:'POST',body:{name:'User Test',company:'Entreprise Test',email:'test@entreprise.cd',password:'MotDePasseSuperLong!'}});assert.equal(r.status,201);const newCookie=r.cookie.split(';')[0];
  r=await request('/api/inventory',{cookie:newCookie});assert.equal(r.status,200);assert.equal(r.data.products.length,0);assert.equal(r.data.warehouses.length,0);
  r=await request('/api/login',{method:'POST',body:{email:'test@entreprise.cd',password:'incorrect'}});assert.equal(r.status,401);
  r=await request('/api/logout',{method:'POST',cookie:newCookie,body:{}});assert.equal(r.status,200);
  r=await request('/api/me',{cookie:newCookie});assert.equal(r.status,401);
  assert.equal(stderr.includes('Error'),false,stderr);
});
