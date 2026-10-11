// GET /api/money  -> real money totals from Mercury, split by business.
// Needs Vercel env vars: MERCURY_API_TOKEN, APP_PASSCODE (and CRON_SECRET for the daily keep-alive).

// Which deposits belong to which business. Matched against the sender name, bank description and note.
// Edit these any time; anything that doesn't match shows up as "Unsorted" so you can add a rule.
const RULES = [
  { biz: "cards",   test: /whatnot|ebay|tcgplayer|mercari|collectr/i },
  { biz: "stripe",  test: /stripe/i },            // Pantreo + Muir Web Co. (split once Stripe is connected)
  { biz: "clips",   test: /whop|tiktok|youtube|google|meta|instagram|vizard|clip/i },
  { biz: "muir",    test: /muir|boom concrete|marli|kyla/i }
];
const SKIP_KINDS = /internaltransfer|treasury/i;
const TZ = "America/Denver";

function send(res, code, obj){ res.setHeader("Cache-Control", "no-store"); res.status(code).json(obj); }
function authorized(req){
  const pass = process.env.APP_PASSCODE || "", cron = process.env.CRON_SECRET || "";
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  const got = String(req.headers["x-passcode"] || "");
  return !!pass && got.length === pass.length && [...pass].every((c, i) => c === got[i]);
}

// local (Utah) calendar helpers
function parts(ms){
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" });
  const o = {}; f.formatToParts(new Date(ms)).forEach(p => o[p.type] = p.value);
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, dow: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(o.weekday) };
}
function localMidnight(y, m, d){ // UTC ms of 00:00 Utah time on y-m-d
  let guess = Date.UTC(y, m - 1, d, 7);
  for (let i = 0; i < 3; i++) { const p = parts(guess); if (p.h === 0 && p.d === d) break; guess -= (p.h === 0 ? 0 : p.h > 12 ? p.h - 24 : p.h) * 3600e3; }
  return guess;
}
function ranges(now){
  const p = parts(now), day = 864e5;
  const today = localMidnight(p.y, p.m, p.d);
  const week = today - ((p.dow + 6) % 7) * day;              // since Monday
  const month = localMidnight(p.y, p.m, 1);
  const pm = p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 };
  const prevMonth = localMidnight(pm.y, pm.m, 1);
  return { now, today, yesterday: today - day, week, prevWeek: week - 7 * day, month, prevMonth, monthSpan: now - month };
}

async function mercury(path){
  const r = await fetch("https://api.mercury.com/api/v1" + path, { headers: { Authorization: `Bearer ${process.env.MERCURY_API_TOKEN}`, accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("Mercury rejected the token. Make a new Read Only token and update MERCURY_API_TOKEN in Vercel.");
  if (!r.ok) throw new Error(`Mercury error ${r.status}`);
  return r.json();
}
function ymd(ms){ const p = parts(ms); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }

export default async function handler(req, res){
  if (!process.env.MERCURY_API_TOKEN || !process.env.APP_PASSCODE) return send(res, 500, { error: "Add MERCURY_API_TOKEN and APP_PASSCODE in Vercel > Settings > Environment Variables, then redeploy." });
  if (!authorized(req)) return send(res, 401, { error: "Wrong or missing passcode." });
  try {
    const R = ranges(Date.now());
    const { accounts = [] } = await mercury("/accounts");
    const since = ymd(R.prevMonth);
    const deposits = [];
    for (const acct of accounts) {
      for (let offset = 0; offset < 5000; offset += 500) {
        const page = await mercury(`/account/${acct.id}/transactions?start=${since}&limit=500&offset=${offset}`);
        const tx = page.transactions || [];
        tx.forEach(t => {
          const amt = Number(t.amount);
          if (!(amt > 0) || /failed|cancel/i.test(t.status || "") || SKIP_KINDS.test(t.kind || "")) return;
          const text = [t.counterpartyName, t.bankDescription, t.note, t.externalMemo].filter(Boolean).join(" ");
          const rule = RULES.find(r => r.test.test(text));
          deposits.push({ amt, at: Date.parse(t.postedAt || t.createdAt), from: t.counterpartyName || t.bankDescription || "Deposit", biz: rule ? rule.biz : "unsorted", account: acct.name });
        });
        if (tx.length < 500) break;
      }
    }
    const sum = (from, to, biz) => Math.round(deposits.filter(d => d.at >= from && d.at < to && (!biz || d.biz === biz)).reduce((a, d) => a + d.amt, 0) * 100) / 100;
    const bizKeys = ["muir", "cards", "stripe", "clips", "unsorted"];
    const by = {};
    bizKeys.forEach(k => {
      by[k] = {
        today: sum(R.today, R.now, k), week: sum(R.week, R.now, k), month: sum(R.month, R.now, k),
        prevWeek: sum(R.prevWeek, R.week, k), prevMonthSamePoint: sum(R.prevMonth, R.prevMonth + R.monthSpan, k),
        last: (deposits.filter(d => d.biz === k).sort((a, b) => b.at - a.at)[0] || {}).at || null
      };
    });
    send(res, 200, {
      live: true, asOf: R.now,
      total: { today: sum(R.today, R.now), yesterday: sum(R.yesterday, R.today), week: sum(R.week, R.now), prevWeek: sum(R.prevWeek, R.week), month: sum(R.month, R.now), prevMonthSamePoint: sum(R.prevMonth, R.prevMonth + R.monthSpan) },
      by,
      recent: deposits.sort((a, b) => b.at - a.at).slice(0, 20),
      accounts: accounts.map(a => ({ name: a.name, balance: a.availableBalance }))
    });
  } catch (e) {
    send(res, 500, { error: e.message || String(e) });
  }
}
