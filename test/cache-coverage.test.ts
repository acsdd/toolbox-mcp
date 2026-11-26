import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCatalog } from '../dist/context.js'
const model=(id:string,task:string)=>({id,task})
test('partial and old caches are not treated as complete catalogs', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lf-coverage-')), path=join(dir,'cache.json'), now=Date.now()
  let calls=0
  const ctx:any={deps:{cachePath:path,now:()=>now,fetchCatalog:async()=>{calls++;return [model('text','text-generation'),model('image','text-to-image')]} }}
  try {
    await writeFile(path,JSON.stringify({fetchedAt:now,coverage:['text-generation'],models:[model('text','text-generation')]}))
    const combined=await loadCatalog(ctx,{tasks:['text-generation','text-to-image']})
    assert.equal(combined.fromCache,false);assert.equal(combined.models.length,2);assert.equal(calls,1)
    const cached=await loadCatalog(ctx,{tasks:['text-generation','text-to-image']})
    assert.equal(cached.fromCache,true);assert.equal(calls,1)
    const full=await loadCatalog(ctx)
    assert.equal(full.fromCache,false);assert.equal(calls,2)
    const fullAgain=await loadCatalog(ctx)
    assert.equal(fullAgain.fromCache,true);assert.equal(calls,2)
    await writeFile(path,JSON.stringify({fetchedAt:now,models:[model('text','text-generation')]}))
    assert.equal((await loadCatalog(ctx)).fromCache,false);assert.equal(calls,3)
  } finally { await rm(dir,{recursive:true,force:true}) }
})


test('concurrent different task fetches retain both categories', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lf-concurrent-')), path=join(dir,'cache.json')
  const ctx:any={deps:{cachePath:path,fetchCatalog:async(options:any)=>{await new Promise(resolve=>setTimeout(resolve,30));return options.tasks.map((task:string)=>model(task,task))}}}
  try {
    await Promise.all([loadCatalog(ctx,{tasks:['text-generation']}),loadCatalog(ctx,{tasks:['text-to-image']})])
    const combined=await loadCatalog(ctx,{tasks:['text-generation','text-to-image']})
    assert.equal(combined.fromCache,true);assert.equal(combined.models.length,2)
  } finally {await rm(dir,{recursive:true,force:true})}
})
