/**
 * THE WEBSITE CHAT WIDGET
 *
 * What `/chat.js` serves, loaded by the website snippet only when the company
 * has its chat agent on. Dependency free and the same bytes for every visitor,
 * so it caches for an hour like the snippet does.
 *
 * Four things it does on purpose:
 *
 *   It SAYS IT IS AUTOMATED in its header, all the time, and the first message
 *   in every chat is the server's disclosure rather than anything a model
 *   wrote. A visitor never has to ask.
 *
 *   It lives in a SHADOW ROOT, so the company's own stylesheet cannot break it
 *   and it cannot break the company's page.
 *
 *   It writes every word with `textContent`. What a visitor, the assistant or
 *   a person in the office wrote is never parsed as markup on somebody else's
 *   website.
 *
 *   It keeps the chat's token in the browser's storage on the company's own
 *   site and sends it in a request body, never in an address, so a chat
 *   survives moving between pages and a reload, and a person's reply from the
 *   inbox appears while the visitor is still there.
 */
export function chatWidgetSource(input: { apiBase: string; companyKey: string }): string {
  const config = JSON.stringify({ api: input.apiBase, key: input.companyKey });
  return `/* OpenTradesOS website chat. Served by your own installation. */
(function(){"use strict";var C=${config};if(window.__otChat)return;window.__otChat=true;
var STORE="ot_chat_"+C.key,token=null,last=null,timer=null,open=false,seen={};
try{token=localStorage.getItem(STORE);}catch(e){}
function rid(){var a=new Uint8Array(12);(window.crypto||window.msCrypto).getRandomValues(a);var s="";for(var i=0;i<a.length;i++){s+=("0"+a[i].toString(16)).slice(-2);}return s;}
function cookie(name){var m=document.cookie.match(new RegExp("(?:^|; )"+name+"=([^;]*)"));return m?decodeURIComponent(m[1]):null;}
function req(method,path,body,key,done){var x=new XMLHttpRequest();x.open(method,C.api+path,true);x.setRequestHeader("Content-Type","application/json");if(key){x.setRequestHeader("Idempotency-Key",key);}
x.onload=function(){var d=null;try{d=JSON.parse(x.responseText);}catch(e){}done(x.status,d);};x.onerror=function(){done(0,null);};x.send(body?JSON.stringify(body):null);}
var host=document.createElement("div");host.setAttribute("data-ot-chat","host");var root=host.attachShadow({mode:"open"});
var css=":host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif}"
+".b{position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#111827;color:#fff;border:0;border-radius:999px;padding:12px 18px;font-size:15px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}"
+".p{position:fixed;right:20px;bottom:76px;z-index:2147483000;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 110px);background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:10px;display:none;flex-direction:column;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.2)}"
+".p.o{display:flex}.h{padding:12px 14px;border-bottom:1px solid #e5e7eb}.h strong{display:block;font-size:15px}.h span{display:block;font-size:12px;color:#4b5563;margin-top:2px}"
+".x{position:absolute;right:10px;top:8px;background:none;border:0;font-size:20px;line-height:1;color:#4b5563;cursor:pointer}"
+".l{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}.m{max-width:85%;padding:8px 11px;border-radius:9px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}"
+".m.v{align-self:flex-end;background:#111827;color:#fff}.m.a{align-self:flex-start;background:#f3f4f6}.m.n{align-self:flex-start;background:#e0f2fe}.w{font-size:11px;color:#4b5563;margin-bottom:2px}"
+".s{font-size:12px;color:#4b5563;padding:0 12px 6px}.f{display:flex;gap:6px;padding:10px;border-top:1px solid #e5e7eb}"
+".f input{flex:1;font-size:14px;padding:9px 10px;border:1px solid #d1d5db;border-radius:6px}.f button{background:#111827;color:#fff;border:0;border-radius:6px;padding:0 14px;font-size:14px;cursor:pointer}.f button:disabled{opacity:.6}";
var style=document.createElement("style");style.textContent=css;root.appendChild(style);
var button=document.createElement("button");button.className="b";button.type="button";button.textContent="Chat with us";button.setAttribute("aria-expanded","false");button.setAttribute("data-ot-chat","button");
var panel=document.createElement("div");panel.className="p";panel.setAttribute("role","dialog");panel.setAttribute("aria-label","Chat");panel.setAttribute("data-ot-chat","panel");
var head=document.createElement("div");head.className="h";var title=document.createElement("strong");title.textContent="Chat";var note=document.createElement("span");note.textContent="Automated assistant. Ask for a person at any time.";
var close=document.createElement("button");close.className="x";close.type="button";close.setAttribute("aria-label","Close chat");close.textContent="\\u00d7";head.appendChild(title);head.appendChild(note);head.appendChild(close);
var list=document.createElement("div");list.className="l";list.setAttribute("aria-live","polite");list.setAttribute("data-ot-chat","messages");
var status=document.createElement("div");status.className="s";status.setAttribute("data-ot-chat","status");
var form=document.createElement("form");form.className="f";var input=document.createElement("input");input.type="text";input.maxLength=2000;input.setAttribute("aria-label","Your message");input.placeholder="Type a message";input.setAttribute("data-ot-chat","input");
var send=document.createElement("button");send.type="submit";send.textContent="Send";send.setAttribute("data-ot-chat","send");form.appendChild(input);form.appendChild(send);
panel.appendChild(head);panel.appendChild(list);panel.appendChild(status);panel.appendChild(form);root.appendChild(button);root.appendChild(panel);
function add(m){if(seen[m.id])return;seen[m.id]=true;var d=document.createElement("div");d.className="m "+(m.from==="visitor"?"v":m.from==="person"?"n":"a");d.setAttribute("data-ot-chat","message");d.setAttribute("data-from",m.from);
if(m.from!=="visitor"){var w=document.createElement("div");w.className="w";w.textContent=m.from==="person"?"From the office":"Automated assistant";d.appendChild(w);}
var t=document.createElement("div");t.textContent=m.text;d.appendChild(t);list.appendChild(d);list.scrollTop=list.scrollHeight;if(!last||m.at>last){last=m.at;}}
function show(d){if(!d)return;for(var i=0;i<(d.messages||[]).length;i++){add(d.messages[i]);}
status.textContent=d.status==="handed_off"?"A person in the office has this conversation now and will reply here.":d.status==="closed"?"This chat has ended.":"";}
function startChat(done){var body={companyKey:C.key};var v=cookie("ot_vid");if(v&&/^[A-Za-z0-9_-]{12,64}$/.test(v)){body.visitorId=v;}
req("POST","/v1/public/chat/sessions",body,null,function(code,d){if(code===201&&d){token=d.token;try{localStorage.setItem(STORE,token);}catch(e){}show(d);done(true);}else{status.textContent=(d&&d.error)||"Chat is not available right now.";done(false);}});}
function poll(){if(!token)return;req("POST","/v1/public/chat/transcript",{companyKey:C.key,token:token,after:last||undefined},null,function(code,d){
if(code===404){token=null;try{localStorage.removeItem(STORE);}catch(e){}return;}if(code===200||code===201){show(d);}});}
function openPanel(){open=true;panel.className="p o";button.setAttribute("aria-expanded","true");if(token){poll();}else{startChat(function(){});}
if(!timer){timer=setInterval(function(){if(open&&!document.hidden)poll();},5000);}setTimeout(function(){input.focus();},0);}
function closePanel(){open=false;panel.className="p";button.setAttribute("aria-expanded","false");}
button.addEventListener("click",function(){if(open){closePanel();}else{openPanel();}});close.addEventListener("click",closePanel);
form.addEventListener("submit",function(e){e.preventDefault();var text=input.value.replace(/^\\s+|\\s+$/g,"");if(!text)return;
var go=function(){send.disabled=true;var key=rid();req("POST","/v1/public/chat/messages",{companyKey:C.key,token:token,text:text},key,function(code,d){send.disabled=false;
if(code===201||code===200){input.value="";show(d);}else if(code===404){token=null;try{localStorage.removeItem(STORE);}catch(e){}startChat(function(ok){if(ok)go();});}else{status.textContent=(d&&d.error)||"That did not send. Try again.";}});};
if(token){go();}else{startChat(function(ok){if(ok)go();});}});
req("GET","/v1/public/chat?companyKey="+encodeURIComponent(C.key),null,null,function(code,d){if(code!==200||!d||!d.enabled)return;title.textContent=d.companyName;document.body.appendChild(host);});
})();
`;
}
