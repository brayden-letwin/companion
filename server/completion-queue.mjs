const stopped=()=>Object.assign(new Error('Request stopped.'),{name:'AbortError',code:'request_cancelled',statusCode:499});

/** Bounded leases for actual model calls, shared by interactive turns and background work. */
export function createCompletionQueue({concurrency=2,maxWaiting=12}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>2||!Number.isInteger(maxWaiting)||maxWaiting<1||maxWaiting>12)throw new TypeError('Use a bounded model queue.');
  let active=0;const waiting=[];
  function grant(entry){
    entry.signal?.removeEventListener('abort',entry.cancel);active++;let released=false;
    entry.resolve(()=>{if(released)return;released=true;active--;drain();});
  }
  function drain(){
    while(active<concurrency&&waiting.length){const interactive=waiting.findIndex(item=>item.priority==='interactive'),entry=waiting.splice(interactive<0?0:interactive,1)[0];if(entry.signal?.aborted){entry.signal.removeEventListener('abort',entry.cancel);entry.reject(stopped());}else grant(entry);}
  }
  return{
    acquire({signal,priority='interactive',onWait}={}){
      if(!['interactive','background'].includes(priority))return Promise.reject(new TypeError('Choose an interactive or background model call.'));
      if(signal?.aborted)return Promise.reject(stopped());
      if(active>=concurrency&&waiting.length>=maxWaiting)return Promise.reject(Object.assign(new Error('The AI request queue is full. Stop work or try again shortly.'),{code:'provider_busy',statusCode:429}));
      return new Promise((resolve,reject)=>{
        const entry={signal,priority,resolve,reject,cancel:null};entry.cancel=()=>{const index=waiting.indexOf(entry);if(index>=0){waiting.splice(index,1);signal.removeEventListener('abort',entry.cancel);reject(stopped());}};
        if(active<concurrency&&!waiting.length){grant(entry);return;}
        waiting.push(entry);signal?.addEventListener('abort',entry.cancel,{once:true});if(signal?.aborted){entry.cancel();return;}
        try{onWait?.();}catch{/* An observer cannot change queue ownership. */}
      });
    },
    status(){return{active,waiting:waiting.length,concurrency,maxWaiting};},
  };
}
