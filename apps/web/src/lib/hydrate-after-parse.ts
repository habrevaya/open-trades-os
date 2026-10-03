/**
 * REACT TAKES OVER THE PAGE ONLY ONCE THE BROWSER HAS READ ALL OF IT
 *
 * Next starts React as soon as its own scripts have loaded, which on a busy
 * phone can be while the browser is still reading the page. React then
 * matches its tree against a page that is still being built, finds a
 * mismatch (error #418), throws the server's page away and draws its own.
 * Nothing is lost that the person can see, but every page load pays for a
 * second render, and anything typed in that moment is wiped.
 *
 * It was measured, not guessed: six browsers at a sixth of their speed on a
 * loaded machine, loading three office pages six times each. Eight to
 * eighteen loads failed, every one of them before `DOMContentLoaded`. With
 * this script, none did, across the same runs.
 *
 * HOW. Next runs the `beforeInteractive` scripts queued on `self.__next_s`
 * with `scripts.reduce(...)` and starts React when that chain settles
 * (next/dist/client/app-bootstrap.js). The queue is made here, before Next
 * looks at it, with one placeholder in it so it is never skipped as empty,
 * and with a `reduce` that waits for `DOMContentLoaded` and then runs
 * whatever Next really queued, in order. A Next that stops using the queue
 * this way loses only the wait: React starts as early as it did before.
 * test/hydrate-after-parse.test.ts reads Next's bootstrap so an upgrade that
 * changes it fails a test rather than quietly bringing the error back.
 *
 * It is in the head after Next's async script tags, which is early enough:
 * those cannot run before the parser has passed this one in the same chunk.
 */
export const HYDRATE_AFTER_PARSE_SCRIPT = `(function(){
var queued=self.__next_s||[];var q=[0];
for(var i=0;i<queued.length;i++)q.push(queued[i]);
q.reduce=function(step,start){var real=Array.prototype.slice.call(this,1);
return new Promise(function(done){if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){done();},{once:true});}else{done();}})
.then(function(){return Array.prototype.reduce.call(real,step,start);});};
self.__next_s=q;
})();`;
