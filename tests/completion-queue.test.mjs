import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompletionQueue} from '../server/completion-queue.mjs';

test('two live completions hold real slots and an interactive waiter precedes queued background work',async()=>{
  const queue=createCompletionQueue(),first=await queue.acquire({priority:'background'}),second=await queue.acquire({priority:'background'}),order=[];
  const background=queue.acquire({priority:'background'}).then(release=>{order.push('background');return release;}),interactive=queue.acquire().then(release=>{order.push('interactive');return release;});
  assert.deepEqual(queue.status(),{active:2,waiting:2,concurrency:2,maxWaiting:12});first();const third=await interactive;assert.deepEqual(order,['interactive']);assert.equal(queue.status().active,2);third();const fourth=await background;assert.deepEqual(order,['interactive','background']);second();fourth();fourth();assert.equal(queue.status().active,0);
});

test('a cancelled queued call is removed before it can execute and never consumes a later lease',async()=>{
  const queue=createCompletionQueue(),first=await queue.acquire(),second=await queue.acquire(),controller=new AbortController();const pending=queue.acquire({signal:controller.signal});const rejected=assert.rejects(pending,{name:'AbortError',code:'request_cancelled'});controller.abort();await rejected;assert.equal(queue.status().waiting,0);first();const third=await queue.acquire();assert.equal(queue.status().active,2);second();third();
  const aborted=new AbortController();aborted.abort();await assert.rejects(queue.acquire({signal:aborted.signal}),{name:'AbortError'});assert.equal(queue.status().active,0);
});

test('waiting calls are bounded and observer failures cannot manufacture or leak slots',async()=>{
  const queue=createCompletionQueue({concurrency:1,maxWaiting:1}),first=await queue.acquire(),next=queue.acquire({onWait(){throw new Error('Observer failure');}});await assert.rejects(queue.acquire(),{code:'provider_busy',statusCode:429});first();const second=await next;assert.equal(queue.status().active,1);second();assert.equal(queue.status().active,0);await assert.rejects(queue.acquire({priority:'invented'}),TypeError);
});
