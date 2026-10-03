/**
 * THE SIGNATURE PAD
 *
 * A canvas in a web view, because a canvas already does exactly this: draw a
 * line under a finger and hand back a PNG. Written here rather than taken
 * from a package, because it is forty lines and a dependency for forty lines
 * is one more thing to keep up to date for every Expo release.
 *
 * It talks to the app with three messages: "empty" when cleared, "drawn"
 * after the first stroke, and the PNG as a data URL when asked to save. The
 * PNG is the canvas's own, white behind the ink, because a transparent
 * signature on a dark invoice background is a blank box.
 */
export const SIGNATURE_PAD_HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>html,body{margin:0;height:100%;background:#fff;overscroll-behavior:none}canvas{display:block;width:100%;height:100%;touch-action:none}</style>
</head><body><canvas id="pad"></canvas><script>
(function(){
  var canvas = document.getElementById("pad");
  var ctx = canvas.getContext("2d");
  var drawing = false, drawn = false, last = null;
  function post(m){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(m); }
  function size(){
    var r = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * r; canvas.height = canvas.clientHeight * r;
    ctx.setTransform(r,0,0,r,0,0); clear();
  }
  function clear(){
    ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle = "#111"; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    drawn = false; post("empty");
  }
  function point(e){ var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  canvas.addEventListener("pointerdown", function(e){ drawing = true; last = point(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", function(e){
    if (!drawing) return;
    var p = point(e); ctx.beginPath(); ctx.moveTo(last.x,last.y); ctx.lineTo(p.x,p.y); ctx.stroke(); last = p;
    if (!drawn) { drawn = true; post("drawn"); }
  });
  ["pointerup","pointercancel","pointerleave"].forEach(function(t){ canvas.addEventListener(t, function(){ drawing = false; }); });
  window.signatureClear = clear;
  window.signatureSave = function(){ post(drawn ? canvas.toDataURL("image/png") : "empty"); };
  window.addEventListener("resize", size);
  size();
})();
</script></body></html>`;
