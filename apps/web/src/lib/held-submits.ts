/**
 * FORMS SENT BEFORE THE PAGE IS READY
 *
 * Every office form posts to a server action, which works before React has
 * taken over the page: the browser sends the form itself and the server
 * answers with a whole page carrying the action's result. That answer is
 * where React then fails to match the page it rendered against the one the
 * server sent, throws away the server's copy, and draws its own, which no
 * longer carries "Saved" or the refusal under the form. The save happened;
 * the person was told nothing.
 *
 * It happens to anybody who presses a button in the second or so before a
 * slow phone has finished loading, which is when people press buttons.
 *
 * So a submit made before the page is ready is HELD, not lost and not sent
 * the old way, and sent through React the moment it is ready, with the same
 * button that was pressed. Without JavaScript none of this runs and the form
 * posts exactly as it always did.
 *
 * `HELD_SUBMITS_SCRIPT` runs in the head, before anything can be pressed;
 * `releaseHeldSubmits` runs once React has the page (`HeldSubmits`).
 */
export const HELD_SUBMITS_SCRIPT = `(function(){
var held=[];window.__otsHeld=held;
document.addEventListener("submit",function(e){
  if(window.__otsReady)return;
  var f=e.target;if(!f||f.tagName!=="FORM")return;
  e.preventDefault();held.push({form:f,submitter:e.submitter||null});
},true);
})();`;

interface HeldSubmit { form: HTMLFormElement; submitter: HTMLElement | null }

declare global {
  interface Window { __otsHeld?: HeldSubmit[]; __otsReady?: boolean }
}

/**
 * Mark the page ready and send what was held, in the order it was pressed.
 * A form that has left the page since is dropped: there is nothing on screen
 * left to tell the person about it.
 */
export function releaseHeldSubmits(win: Window = window): number {
  win.__otsReady = true;
  const held = win.__otsHeld ?? [];
  win.__otsHeld = [];
  let sent = 0;
  for (const { form, submitter } of held) {
    if (!form.isConnected) continue;
    const button = submitter && form.contains(submitter) ? submitter : undefined;
    form.requestSubmit(button);
    sent += 1;
  }
  return sent;
}
