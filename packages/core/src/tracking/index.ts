/**
 * THE COMPANY'S OWN WEBSITE
 *
 * A snippet the company pastes into its site does four things: keeps a first
 * party visitor id on the company's own domain, records how the visitor
 * arrived, carries that onto the company's forms and booking links, and swaps
 * the phone number on the page for one from a pool so a call can be matched
 * back to the visit.
 *
 * The decisions live here and are pure: what a touch from the open internet
 * may contain, which pool number a visitor gets, when a lease lapses, which
 * session a call belongs to, and how a swapped number is written so it looks
 * like the one it replaced.
 *
 * WHAT A TOUCH FROM A WEBSITE MAY CARRY, AND WHY IT IS SO LITTLE. The endpoint
 * is public and the page it reads is the company's, which may have anything in
 * its address bar: a search box that puts somebody's question in the query, a
 * password reset link with a token in it, an email address a newsletter tool
 * appended. So the query is reduced to the attribution parameters this product
 * reads and nothing else, the page to its path, and the referrer is only ever
 * used for its host. Nothing personal arrives unless a person types it into a
 * form, which goes through the form's own endpoint and its own consent.
 */

/** The query parameters a touch keeps. Everything else on the landing URL is dropped. */
export const ATTRIBUTION_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "gbraid", "wbraid", "fbclid", "msclkid",
  /** A customer's referral code, from their shareable link. */
  "ref",
] as const;

/** The click ids an ads platform matches a conversion back on. */
export const CLICK_ID_PARAMS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid"] as const;

const MAX_VALUE = 300;

/**
 * The landing query, reduced to attribution and rebuilt.
 *
 * Hand parsed for the reason core's `parseQuery` gives: a query string that
 * will not decode must not throw and lose the visit. Values are clipped, so a
 * three kilobyte utm_content cannot be used to store anything here.
 */
export function attributionQuery(raw: string | null | undefined): string {
  if (!raw) return "";
  const kept = new Map<string, string>();
  for (const pair of raw.replace(/^[?#]/, "").split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const key = decode(at === -1 ? pair : pair.slice(0, at)).trim().toLowerCase();
    if (!(ATTRIBUTION_PARAMS as readonly string[]).includes(key) || kept.has(key)) continue;
    const value = decode(at === -1 ? "" : pair.slice(at + 1)).trim().slice(0, MAX_VALUE);
    if (value !== "") kept.set(key, value);
  }
  return [...kept].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/** The path of a page, without its query or fragment, or null for something that is not a URL. */
export function pathOf(page: string | null | undefined): string | null {
  if (!page) return null;
  const afterHost = page.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  const path = afterHost.split(/[?#]/)[0] ?? "";
  if (path === "") return "/";
  return path.startsWith("/") ? path.slice(0, 500) : null;
}

/** The value in an attribution query, by name. */
export function paramOf(query: string, name: string): string | null {
  for (const pair of query.split("&")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at) === name) return decode(pair.slice(at + 1));
  }
  return null;
}

/**
 * A visitor id the snippet minted: random, url safe, and nothing else.
 *
 * Checked because it is a string from the open internet that becomes a key in
 * the touch table. Anything shaped otherwise (an email, a long blob) is not a
 * visitor id and is refused rather than stored.
 */
export const isVisitorId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{12,64}$/.test(value);

export type PublicTouch =
  | { ok: true; visitorId: string; query: string; landingPath: string | null; referrer: string | null }
  | { ok: false; reason: string };

/**
 * A touch posted by the snippet, checked and reduced.
 *
 * The referrer is passed on whole only for its host to be read; the touch
 * table keeps the host and never the full URL, which is where a search
 * engine or a webmail client puts what somebody typed.
 */
export function checkPublicTouch(input: {
  visitorId: unknown; page?: unknown; referrer?: unknown; query?: unknown;
}): PublicTouch {
  if (!isVisitorId(input.visitorId)) return { ok: false, reason: "That is not a visitor id this snippet makes." };
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.length <= max ? value : null;
  const page = text(input.page, 2000);
  const query = attributionQuery(text(input.query, 4000) ?? queryOf(page));
  const referrer = text(input.referrer, 2000);
  return {
    ok: true,
    visitorId: input.visitorId,
    query,
    landingPath: pathOf(page),
    referrer: referrer && /^https?:\/\//i.test(referrer) ? referrer : null,
  };
}

const queryOf = (page: string | null): string | null => {
  if (!page) return null;
  const at = page.indexOf("?");
  return at === -1 ? null : page.slice(at + 1).split("#")[0] ?? null;
};

/* ------------------------------------------------------- number insertion */

export const DEFAULT_IDLE_MINUTES = 30;
export const MIN_IDLE_MINUTES = 5;
export const MAX_IDLE_MINUTES = 240;

export interface TrackingSettings {
  /** How long a visitor may be quiet before their pool number goes back. */
  idleMinutes: number;
}

export type SettingsCheck = { ok: true; settings: TrackingSettings } | { ok: false; reason: string };

export function checkTrackingSettings(input: { idleMinutes?: unknown }): SettingsCheck {
  const idle = input.idleMinutes === undefined ? DEFAULT_IDLE_MINUTES : Number(input.idleMinutes);
  if (!Number.isInteger(idle) || idle < MIN_IDLE_MINUTES || idle > MAX_IDLE_MINUTES) {
    return {
      ok: false,
      reason: `A number is held for a quiet visitor between ${MIN_IDLE_MINUTES} and ${MAX_IDLE_MINUTES} minutes. `
        + "Shorter and a visitor reading a long page loses their number; longer and the pool runs out.",
    };
  }
  return { ok: true, settings: { idleMinutes: idle } };
}

/** When a lease lapses: idle for the company's idle time since the visitor was last seen. */
export const lapsesAt = (lastSeenAt: Date, idleMinutes: number): Date =>
  new Date(lastSeenAt.getTime() + idleMinutes * 60_000);

export interface Lease {
  id: string;
  phoneNumberId: string;
  assignedAt: Date;
  lastSeenAt: Date;
  releasedAt: Date | null;
}

/**
 * The visit a call on a pool number belongs to.
 *
 * The lease that held the number at the moment the call started. A lease
 * still live covers the call up to its idle lapse; a released one covers it up
 * to the moment it was released, which is when it lapsed rather than when
 * somebody noticed. Of two that both cover the time (which the live index
 * makes impossible for live leases, and a clock skew can make possible for a
 * released one), the one assigned last wins, because it is the visitor who
 * was looking at the number most recently.
 */
export function leaseAt<T extends Lease>(leases: readonly T[], at: Date, idleMinutes: number): T | null {
  let best: T | null = null;
  for (const lease of leases) {
    const until = lease.releasedAt ?? lapsesAt(lease.lastSeenAt, idleMinutes);
    if (lease.assignedAt.getTime() > at.getTime() || until.getTime() < at.getTime()) continue;
    if (!best || lease.assignedAt.getTime() > best.assignedAt.getTime()) best = lease;
  }
  return best;
}

/**
 * Which pool number to offer, if any is free.
 *
 * The one free longest, so a number is rested between visitors as long as the
 * pool allows: a caller who wrote a number down yesterday and rings it today
 * is more likely to be matched to the right visit if nobody else has been
 * shown it since.
 */
export function choosePoolNumber<T extends { id: string; lastLeasedAt: Date | null }>(
  pool: readonly T[],
  leased: ReadonlySet<string>,
): T | null {
  const free = pool.filter((number) => !leased.has(number.id));
  free.sort((a, b) => (a.lastLeasedAt?.getTime() ?? 0) - (b.lastLeasedAt?.getTime() ?? 0));
  return free[0] ?? null;
}

/**
 * The number to show when the pool is empty.
 *
 * The tracking number for the visitor's own source when the company has one
 * (a Google Ads visitor sees the Google Ads number, which still credits the
 * right channel even without a session), else the main number. A swapped
 * number that credits the wrong channel is worse than the main number, which
 * credits nothing and says so.
 */
export function fallbackNumber(input: {
  source: string | null;
  statics: readonly { e164: string; source: string | null }[];
  main: string | null;
}): string | null {
  const match = input.source ? input.statics.find((s) => s.source === input.source) : undefined;
  return match?.e164 ?? input.main;
}

/** The digits of a phone number, without a North American leading 1. */
export function nationalDigits(text: string): string {
  const digits = text.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/**
 * A number written the way the one it replaces was written.
 *
 * "(512) 555-0100" swapped for +15125550199 reads "(512) 555-0199", and
 * "512.555.0100" reads "512.555.0199". The digits of the new number are poured
 * into the old one's shape, digit for digit; a leading +1 or 1 in the original
 * is kept. A sample whose shape cannot hold the new number (a different count
 * of digits) is written in the plain national form rather than mangled.
 *
 * The snippet carries this same function as source (see `SNIPPET_HELPERS`),
 * and a test runs both against the same cases, so the page and the server
 * cannot drift.
 */
export function formatLike(sample: string, e164: string): string {
  const next = nationalDigits(e164);
  const old = sample.replace(/\D/g, "");
  const national = old.length === 11 && old.startsWith("1") ? old.slice(1) : old;
  if (national.length !== next.length) {
    return next.length === 10 ? `(${next.slice(0, 3)}) ${next.slice(3, 6)}-${next.slice(6)}` : e164;
  }
  let skip = old.length - national.length;
  let i = 0;
  let out = "";
  for (const ch of sample) {
    if (/\d/.test(ch)) {
      if (skip > 0) { skip -= 1; out += ch; continue; }
      out += next[i] ?? "";
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * The snippet's helpers, as the source the browser runs.
 *
 * Plain ES5, no dependencies, and the SAME logic as `formatLike` and
 * `attributionQuery` above; `tracking.test.ts` evaluates this text and checks
 * it against the TypeScript on the same inputs.
 */
export const SNIPPET_HELPERS = String.raw`
function otNational(t){var d=String(t).replace(/\D/g,"");return d.length===11&&d.charAt(0)==="1"?d.slice(1):d;}
function otFormatLike(sample,e164){var next=otNational(e164);var old=sample.replace(/\D/g,"");
var nat=old.length===11&&old.charAt(0)==="1"?old.slice(1):old;
if(nat.length!==next.length){return next.length===10?"("+next.slice(0,3)+") "+next.slice(3,6)+"-"+next.slice(6):e164;}
var skip=old.length-nat.length,i=0,out="";for(var k=0;k<sample.length;k++){var ch=sample.charAt(k);
if(/\d/.test(ch)){if(skip>0){skip--;out+=ch;continue;}out+=next.charAt(i);i++;}else{out+=ch;}}return out;}
var OT_PARAMS=["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","gbraid","wbraid","fbclid","msclkid","ref"];
function otDecode(t){try{return decodeURIComponent(t.replace(/\+/g," "));}catch(e){return t;}}
function otAttribution(raw){if(!raw)return "";var kept={},order=[];var parts=raw.replace(/^[?#]/,"").split("&");
for(var p=0;p<parts.length;p++){var pair=parts[p];if(!pair)continue;var at=pair.indexOf("=");
var key=otDecode(at===-1?pair:pair.slice(0,at)).replace(/^\s+|\s+$/g,"").toLowerCase();
if(OT_PARAMS.indexOf(key)===-1||kept.hasOwnProperty(key))continue;
var val=otDecode(at===-1?"":pair.slice(at+1)).replace(/^\s+|\s+$/g,"").slice(0,300);if(val!==""){kept[key]=val;order.push(key);}}
var out=[];for(var j=0;j<order.length;j++){out.push(order[j]+"="+encodeURIComponent(kept[order[j]]));}return out.join("&");}
`;

/**
 * The whole script a company pastes, for one company.
 *
 * Small, dependency free, and cache friendly: nothing per visitor is in it,
 * so the same bytes serve every page view and a browser or CDN may hold them
 * for an hour. Everything per visitor comes from the two public endpoints.
 *
 *   1. The visitor id: `ot_vid`, a first party cookie on the company's own
 *      domain, a random value and never a fingerprint, kept for a year.
 *   2. The arrival: attribution parameters, the path and the referrer, kept
 *      for the session in `ot_arrival` so a visitor who lands on a tagged
 *      link and clicks to the contact page still carries the tag.
 *   3. A touch, posted once per arrival that says something (a tag, a click
 *      id, a referral code or another site's referrer), and once on a first
 *      visit.
 *   4. Links to this app's booking page and hosted forms get the visitor id
 *      and the arrival appended; forms on the page get hidden fields.
 *   5. The number swap: the page's numbers matching the company's main or
 *      tracking numbers are replaced with the visitor's pool number, written
 *      the way the original was, in text and in `tel:` links. A number a
 *      page builder split across several text nodes (React does, with comment
 *      markers between them) is matched on its element's whole text. The page asks
 *      again every few minutes while it is open, which is what keeps the
 *      lease alive, and stops when it is hidden.
 */
export function snippetSource(input: { apiBase: string; appBase: string; companyKey: string }): string {
  const config = JSON.stringify({ api: input.apiBase, app: input.appBase, key: input.companyKey });
  return `/* OpenTradesOS website snippet. Served by your own installation. */
(function(){"use strict";var C=${config};
${SNIPPET_HELPERS}
function cookie(name){var m=document.cookie.match(new RegExp("(?:^|; )"+name+"=([^;]*)"));return m?decodeURIComponent(m[1]):null;}
function setCookie(name,value,days){var d=new Date();d.setTime(d.getTime()+days*864e5);
document.cookie=name+"="+encodeURIComponent(value)+"; expires="+d.toUTCString()+"; path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");}
function rid(){var a=new Uint8Array(16);(window.crypto||window.msCrypto).getRandomValues(a);var s="";for(var i=0;i<a.length;i++){s+=("0"+a[i].toString(16)).slice(-2);}return s;}
var vid=cookie("ot_vid");var first=false;if(!vid||!/^[A-Za-z0-9_-]{12,64}$/.test(vid)){vid=rid();first=true;}setCookie("ot_vid",vid,365);
var q=otAttribution(location.search);var ref=document.referrer||"";var own=ref&&ref.indexOf(location.protocol+"//"+location.host)===0;
var stored=null;try{stored=JSON.parse(sessionStorage.getItem("ot_arrival")||"null");}catch(e){}
var fresh=q!==""||(ref&&!own);var arrival=fresh||!stored?{q:q,r:own?"":ref,p:location.pathname}:stored;
try{sessionStorage.setItem("ot_arrival",JSON.stringify(arrival));}catch(e){}
function post(path,body){try{var x=new XMLHttpRequest();x.open("POST",C.api+path,true);x.setRequestHeader("Content-Type","application/json");x.send(JSON.stringify(body));}catch(e){}}
if(fresh||first){post("/v1/public/touches",{companyKey:C.key,visitorId:vid,page:location.pathname+(arrival.q?"?"+arrival.q:""),query:arrival.q,referrer:arrival.r||undefined});}
function decorate(url){var sep=url.indexOf("?")===-1?"?":"&";return url+sep+"otv="+encodeURIComponent(vid)+(arrival.q?"&"+arrival.q:"");}
function links(){var as=document.getElementsByTagName("a");for(var i=0;i<as.length;i++){var h=as[i].getAttribute("href")||"";
if(h.indexOf(C.app+"/book/")===0||h.indexOf(C.app+"/f/")===0){if(h.indexOf("otv=")===-1){as[i].setAttribute("href",decorate(h));}}}
var fs=document.getElementsByTagName("form");for(var f=0;f<fs.length;f++){var add={ot_visitor_id:vid,ot_landing_query:arrival.q,ot_referrer:arrival.r||""};
for(var k in add){if(!fs[f].querySelector("input[name='"+k+"']")){var inp=document.createElement("input");inp.type="hidden";inp.name=k;inp.value=add[k];fs[f].appendChild(inp);}}}}
var targets=[],shown=null;
function swapText(node){if(!shown)return;var t=node.nodeValue;var out=swapIn(t);if(out!==t)node.nodeValue=out;}
function swapIn(t){var re=/\\+?1?[\\s.(-]*\\d{3}[\\s.)-]*\\d{3}[\\s.-]*\\d{4}/g;return t.replace(re,function(m){return targets.indexOf(otNational(m))!==-1?otFormatLike(m,shown):m;});}
function walk(el){if(!el)return;var w=document.createTreeWalker(el,4,null,false);var n;while((n=w.nextNode())){var p=n.parentNode&&n.parentNode.nodeName;if(p!=="SCRIPT"&&p!=="STYLE")swapText(n);}
var all=el.getElementsByTagName?el.getElementsByTagName("*"):[];for(var e=0;e<all.length;e++){var kids=all[e].childNodes;if(kids.length<2||all[e].nodeName==="SCRIPT"||all[e].nodeName==="STYLE")continue;var onlyText=true;for(var c=0;c<kids.length;c++){if(kids[c].nodeType!==3&&kids[c].nodeType!==8){onlyText=false;break;}}
if(onlyText){var whole=all[e].textContent,next=swapIn(whole);if(next!==whole)all[e].textContent=next;}}
var as=el.getElementsByTagName?el.getElementsByTagName("a"):[];for(var i=0;i<as.length;i++){var h=as[i].getAttribute("href")||"";
if(h.indexOf("tel:")===0&&targets.indexOf(otNational(h))!==-1){as[i].setAttribute("href","tel:"+shown);}}}
function ask(){var x=new XMLHttpRequest();x.open("GET",C.api+"/v1/public/dni?companyKey="+encodeURIComponent(C.key)+"&visitorId="+vid+(arrival.q?"&query="+encodeURIComponent(arrival.q):"")+(arrival.r?"&referrer="+encodeURIComponent(arrival.r):"")+"&page="+encodeURIComponent(arrival.p||"/"),true);
x.onload=function(){if(x.status!==200)return;var d;try{d=JSON.parse(x.responseText);}catch(e){return;}
targets=[];for(var i=0;i<(d.targets||[]).length;i++){targets.push(otNational(d.targets[i]));}
if(d.number){var was=shown;if(was){targets.push(otNational(was));}shown=d.number;if(was!==shown)walk(document.body);}};x.send();}
function start(){links();ask();setInterval(function(){if(!document.hidden)ask();},180000);}
function later(){var go=function(){if(window.requestIdleCallback){window.requestIdleCallback(start,{timeout:2000});}else{setTimeout(start,1);}};if(document.readyState==="complete"){go();}else{window.addEventListener("load",go);}}
later();
})();
`;
}
