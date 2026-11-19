'use strict';
// Ho Ho Hold'em: tournament engine (no dependencies).
// All state lives in one serialisable object (S) so it can be snapshotted to disk.
const crypto = require('crypto');

const CONFIG = {
  startStack: 10000,
  maxSeats: 9,            // players per table; 15 players = tables of 8 and 7
  levelMinutes: 5,        // blind level length (host can change live)
  actionSeconds: 20,      // decision clock (host can change live)
  lateRegLevels: 3,       // latecomers get a full stack during the first N levels
  prizePool: 100,        // total prize money in euros for the main event (host can change live)
  payouts: [0.5, 0.3, 0.2],
  losers: { sb: 100, bb: 200, ante: 25, buyin: 10000 }, // Naughty List table: fixed blinds, unlimited rebuys
  // [small blind, big blind, ante] : designed to finish 15 players in roughly 70 to 80 minutes
  levels: [
    [25, 50, 10], [50, 100, 15], [75, 150, 25], [100, 200, 25], [150, 300, 50],
    [200, 400, 50], [300, 600, 75], [400, 800, 100], [600, 1200, 150], [800, 1600, 200],
    [1000, 2000, 300], [1500, 3000, 400], [2000, 4000, 500], [3000, 6000, 1000],
    [4000, 8000, 1000], [6000, 12000, 2000], [10000, 20000, 3000], [15000, 30000, 5000],
  ],
};

let S = null;
let clock = () => Date.now();
const now = () => clock();
const rnd = (n) => crypto.randomInt(n);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmt = (n) => Number(n).toLocaleString('en-US');
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function newState() {
  return {
    phase: 'lobby', paused: false, pausedAt: 0, players: {}, pidSeq: 0, tables: {}, tableSeq: 0,
    level: 0, levelEndsAt: 0, levelMinutes: CONFIG.levelMinutes, actionSeconds: CONFIG.actionSeconds,
    prizePool: CONFIG.prizePool, feed: [], feedSeq: 0, handSeq: 0, finalTable: false, savedAt: 0,
  };
}
S = newState();

function feed(text, type) { S.feed.push({ id: ++S.feedSeq, text, type: type || 'info' }); if (S.feed.length > 80) S.feed.shift(); }

// ---------------------------------------------------------------- cards
const RANKS = '23456789TJQKA';
const rv = (c) => RANKS.indexOf(c[0]) + 2;
function newDeck() { const d = []; for (const r of RANKS) for (const s of 'shdc') d.push(r + s); return shuffle(d); }

// Best hand from any number of cards (2 to 7). Returns [category, tiebreakers...].
function evalHand(cards) {
  const ranks = cards.map(rv).sort((a, b) => b - a);
  const cnt = {}; for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const bySuit = {}; for (const c of cards) (bySuit[c[1]] = bySuit[c[1]] || []).push(rv(c));
  const straightHigh = (rs) => {
    const u = [...new Set(rs)].sort((a, b) => b - a); if (u[0] === 14) u.push(1);
    let run = 1;
    for (let i = 1; i < u.length; i++) { if (u[i] === u[i - 1] - 1) { run++; if (run >= 5) return u[i] + 4; } else run = 1; }
    return 0;
  };
  let flush = null;
  for (const s in bySuit) if (bySuit[s].length >= 5) flush = bySuit[s].sort((a, b) => b - a);
  if (flush) { const sf = straightHigh(flush); if (sf) return [8, sf]; }
  const groups = Object.keys(cnt).map(Number).sort((a, b) => cnt[b] - cnt[a] || b - a);
  const kick = (excl, n) => ranks.filter((r) => !excl.includes(r)).slice(0, n);
  if (cnt[groups[0]] === 4) return [7, groups[0], ...kick([groups[0]], 1)];
  const trips = groups.filter((g) => cnt[g] === 3), pairs = groups.filter((g) => cnt[g] === 2);
  if (trips.length && (trips.length > 1 || pairs.length)) return [6, trips[0], trips.length > 1 ? Math.max(trips[1], pairs[0] || 0) : pairs[0]];
  if (flush) return [5, ...flush.slice(0, 5)];
  const st = straightHigh(ranks); if (st) return [4, st];
  if (trips.length) return [3, trips[0], ...kick([trips[0]], 2)];
  if (pairs.length >= 2) return [2, pairs[0], pairs[1], ...kick([pairs[0], pairs[1]], 1)];
  if (pairs.length) return [1, pairs[0], ...kick([pairs[0]], 3)];
  return [0, ...ranks.slice(0, 5)];
}
function cmp(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }
const RN = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
function handName(e) {
  const n = (r) => RN[r], pl = (r) => (r === 6 ? 'Sixes' : RN[r] + 's');
  switch (e[0]) {
    case 8: return e[1] === 14 ? 'Royal Flush' : `Straight Flush, ${n(e[1])} high`;
    case 7: return `Four of a Kind, ${pl(e[1])}`;
    case 6: return `Full House, ${pl(e[1])} full of ${pl(e[2])}`;
    case 5: return `Flush, ${n(e[1])} high`;
    case 4: return `Straight, ${n(e[1])} high`;
    case 3: return `Three of a Kind, ${pl(e[1])}`;
    case 2: return `Two Pair, ${pl(e[1])} and ${pl(e[2])}`;
    case 1: return `Pair of ${pl(e[1])}`;
    default: return `${n(e[1])} high`;
  }
}
// Beginner hint for the two starting cards (Chen formula).
function preflopHint(h) {
  const a = rv(h[0]), b = rv(h[1]), hi = Math.max(a, b), lo = Math.min(a, b);
  const pts = (r) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let s = pts(hi);
  if (hi === lo) s = Math.max(5, s * 2);
  if (h[0][1] === h[1][1]) s += 2;
  if (hi !== lo) { const gap = hi - lo - 1; s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5; if (gap <= 1 && hi < 12) s += 1; }
  s = Math.ceil(s);
  if (s >= 10) return { text: 'Premium starting hand. Raise it!', tone: 'great' };
  if (s >= 7) return { text: 'Strong starting hand. Worth playing.', tone: 'good' };
  if (s >= 5) return { text: 'Playable hand, if it is cheap to see the flop.', tone: 'ok' };
  return { text: 'Weak starting hand. Folding is fine.', tone: 'weak' };
}

// ---------------------------------------------------------------- players & tables
function blindsAt(i) {
  const L = CONFIG.levels;
  if (i < L.length) return { sb: L[i][0], bb: L[i][1], ante: L[i][2] };
  const k = 2 ** (i - L.length + 1), l = L[L.length - 1];
  return { sb: l[0] * k, bb: l[1] * k, ante: l[2] * k };
}
const blindsFor = (group) => (group === 'losers' ? CONFIG.losers : blindsAt(S.level));
const groupTables = (g) => Object.values(S.tables).filter((t) => t.group === g);
const mainCount = () => Object.values(S.players).filter((p) => p.group === 'main').length;
const byToken = (token) => Object.values(S.players).find((p) => p.token === token);

function newTable(group) {
  const id = 't' + (++S.tableSeq);
  const n = groupTables(group).length + 1;
  const t = { id, group, name: group === 'main' ? 'Table ' + n : 'Naughty List ' + n, seats: [], button: 0, hand: null, nextAt: 0, handNo: 0 };
  S.tables[id] = t; return t;
}
function seat(p) {
  const ts = groupTables(p.group).filter((t) => t.seats.length < CONFIG.maxSeats).sort((a, b) => a.seats.length - b.seats.length);
  const t = ts[0] || newTable(p.group);
  t.seats.push(p.id); p.tableId = t.id;
  if (!t.hand) t.nextAt = Math.max(t.nextAt, now() + 3000);
}
function unseat(p) {
  const t = S.tables[p.tableId]; p.tableId = null; if (!t) return;
  const i = t.seats.indexOf(p.id); if (i < 0) return;
  t.seats.splice(i, 1); if (i <= t.button) t.button--;
}
function enterLosers(p) {
  p.group = 'losers'; p.stack = CONFIG.losers.buyin; p.buyins = (p.buyins || 0) + 1; seat(p);
}
function addPlayer(name, opts) {
  const id = 'p' + (++S.pidSeq);
  const p = { id, token: crypto.randomBytes(12).toString('hex'), name, stack: 0, group: 'lobby', tableId: null, strikes: 0, bluffs: 0, place: null, buyins: 0, lastSeen: now(), isHost: false, bot: !!(opts && opts.bot), kicked: false };
  S.players[id] = p;
  if (S.phase === 'running') {
    if (S.level < CONFIG.lateRegLevels) { for (const x of Object.values(S.players)) if (x.place) x.place++; p.group = 'main'; p.stack = CONFIG.startStack; seat(p); feed(`${name} joins late with a full stack`); }
    else { enterLosers(p); feed(`${name} joins at the Naughty List table`); }
  } else if (S.phase !== 'lobby') p.group = 'out';
  return p;
}

function start() {
  if (S.phase !== 'lobby') return 'The game has already started';
  const ps = shuffle(Object.values(S.players).filter((p) => p.group === 'lobby'));
  if (ps.length < 2) return 'You need at least 2 players';
  const nT = Math.ceil(ps.length / CONFIG.maxSeats), ts = [];
  for (let i = 0; i < nT; i++) ts.push(newTable('main'));
  ps.forEach((p, i) => { p.group = 'main'; p.stack = CONFIG.startStack; const t = ts[i % nT]; t.seats.push(p.id); p.tableId = t.id; });
  S.phase = 'running'; S.level = 0; S.levelEndsAt = now() + S.levelMinutes * 60000;
  ts.forEach((t) => { t.nextAt = now() + 5000; t.button = rnd(t.seats.length); });
  if (nT === 1) { S.finalTable = true; ts[0].name = 'Final Table'; }
  feed('Shuffle up and deal! Good luck, and keep your scarves close.', 'big');
  return null;
}

// ---------------------------------------------------------------- hand flow
function put(h, id, amt, isBet) {
  const p = S.players[id], q = h.ps[id];
  const a = Math.max(0, Math.min(amt, p.stack));
  p.stack -= a; q.committed += a; if (isBet) q.bet += a;
  if (p.stack === 0) q.allin = true;
  return a;
}
const potTotal = (h) => h.order.reduce((s, id) => s + h.ps[id].committed, 0);

function startHand(t) {
  const ids = t.seats.filter((id) => S.players[id].stack > 0 && !S.players[id].kicked);
  if (ids.length < 2) return false;
  const n = t.seats.length;
  t.button = (((t.button + 1) % n) + n) % n;
  while (!ids.includes(t.seats[t.button])) t.button = (t.button + 1) % n;
  const bi = ids.indexOf(t.seats[t.button]);
  const order = ids.slice(bi + 1).concat(ids.slice(0, bi + 1)); // small blind first, button last
  const b = blindsFor(t.group), deck = newDeck(), k = order.length;
  const h = {
    no: ++S.handSeq, deck, board: [], street: 0, order, ps: {}, sb: b.sb, bb: b.bb, ante: b.ante,
    currentBet: 0, minRaise: b.bb, toAct: null, deadline: 0, turnStart: 0, lastAggr: null, aggrSeq: 0, seq: 0,
    stage: 'betting', pending: null, result: null, button: t.seats[t.button], show: {},
    sbId: k === 2 ? order[1] : order[0], bbId: k === 2 ? order[0] : order[1],
  };
  for (const id of order) h.ps[id] = { hole: [deck.pop(), deck.pop()], bet: 0, committed: 0, folded: false, allin: false, acted: false, start: S.players[id].stack, last: '', foldStreet: -1, foldSeq: 0 };
  if (b.ante) for (const id of order) put(h, id, b.ante, false);
  if (!h.ps[h.sbId].allin) put(h, h.sbId, b.sb, true);
  if (!h.ps[h.bbId].allin) put(h, h.bbId, b.bb, true);
  h.currentBet = b.bb;
  t.hand = h; t.handNo++;
  proceed(t, k === 2 ? 1 : 2 % k);
  return true;
}

function needsAct(h, id) { const q = h.ps[id]; return !q.folded && !q.allin && (!q.acted || q.bet < h.currentBet); }

function proceed(t, fromIdx) {
  const h = t.hand, k = h.order.length;
  const alive = h.order.filter((id) => !h.ps[id].folded);
  if (alive.length === 1) return winByFold(t, alive[0]);
  const can = alive.filter((id) => !h.ps[id].allin);
  let next = null;
  if (!(can.length === 1 && h.ps[can[0]].bet >= h.currentBet)) {
    for (let i = 0; i < k; i++) { const id = h.order[(fromIdx + i) % k]; if (needsAct(h, id)) { next = id; break; } }
  }
  if (next) { h.toAct = next; h.turnStart = now(); h.deadline = now() + S.actionSeconds * 1000; return; }
  endStreet(t);
}

function returnUncalled(h) {
  const bets = h.order.map((id) => h.ps[id].bet).sort((a, b) => b - a);
  if (bets.length > 1 && bets[0] > bets[1]) {
    const id = h.order.find((x) => h.ps[x].bet === bets[0]), d = bets[0] - bets[1], q = h.ps[id];
    q.bet -= d; q.committed -= d; S.players[id].stack += d; q.allin = false;
  }
}

function legal(h, pid) {
  const p = S.players[pid], q = h.ps[pid];
  const toCall = Math.max(0, Math.min(h.currentBet - q.bet, p.stack));
  const maxTo = q.bet + p.stack;
  const others = h.order.filter((id) => id !== pid && !h.ps[id].folded && !h.ps[id].allin);
  const canRaise = p.stack > toCall && others.length > 0 && !(q.acted && q.bet < h.currentBet);
  return { toCall, canCheck: h.currentBet <= q.bet, canRaise, minTo: Math.min(h.currentBet + h.minRaise, maxTo), maxTo, pot: potTotal(h), currentBet: h.currentBet, bb: h.bb, myBet: q.bet };
}

function act(pid, type, amount, auto) {
  const p = S.players[pid]; if (!p) return 'Unknown player';
  const t = S.tables[p.tableId]; if (!t || !t.hand) return 'No hand in progress';
  const h = t.hand;
  if (S.paused) return 'The game is paused';
  if (h.toAct !== pid) return 'It is not your turn';
  const q = h.ps[pid], L = legal(h, pid);
  if (type === 'call' && L.toCall === 0) type = 'check';
  if (type === 'check') { if (!L.canCheck) return 'You cannot check, there is a bet to you'; q.last = 'Check'; }
  else if (type === 'fold') { q.folded = true; q.foldStreet = h.street; q.foldSeq = ++h.seq; q.last = auto ? 'Fold (time)' : 'Fold'; }
  else if (type === 'call') { put(h, pid, L.toCall, true); q.last = q.allin ? 'All-in' : 'Call ' + fmt(L.toCall); }
  else if (type === 'raise') {
    amount = Math.floor(Number(amount));
    if (!L.canRaise) return 'You cannot raise here';
    if (!(amount <= L.maxTo && (amount >= L.minTo || amount === L.maxTo))) return `Raise must be between ${fmt(L.minTo)} and ${fmt(L.maxTo)}`;
    const raiseBy = amount - h.currentBet, opening = h.currentBet === 0;
    put(h, pid, amount - q.bet, true);
    if (raiseBy >= h.minRaise) { h.minRaise = raiseBy; for (const id of h.order) if (id !== pid) h.ps[id].acted = false; }
    h.currentBet = amount; h.lastAggr = pid; h.aggrSeq = ++h.seq;
    q.last = q.allin ? 'All-in ' + fmt(amount) : (opening ? 'Bet ' : 'Raise to ') + fmt(amount);
  } else return 'Unknown action';
  q.acted = true; h.toAct = null;
  proceed(t, (h.order.indexOf(pid) + 1) % h.order.length);
  return null;
}

function endStreet(t) {
  const h = t.hand; h.toAct = null;
  returnUncalled(h);
  const alive = h.order.filter((id) => !h.ps[id].folded), can = alive.filter((id) => !h.ps[id].allin);
  for (const id of h.order) { const q = h.ps[id]; q.bet = 0; q.acted = false; q.last = q.folded ? 'Fold' : q.allin ? 'All-in' : ''; }
  h.currentBet = 0; h.minRaise = h.bb; h.lastAggr = null;
  if (h.street === 3) return showdown(t);
  if (can.length <= 1) { h.stage = 'runout'; alive.forEach((id) => { h.show[id] = true; }); h.pending = { type: 'deal', at: now() + 1500 }; }
  else h.pending = { type: 'deal', at: now() + 700 };
}

function deal(t) {
  const h = t.hand; h.pending = null; h.street++;
  h.deck.pop();
  if (h.street === 1) h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop()); else h.board.push(h.deck.pop());
  if (h.stage === 'runout') h.pending = { type: h.street === 3 ? 'showdown' : 'deal', at: now() + 1800 };
  else proceed(t, 0);
}

function winByFold(t, wid) {
  const h = t.hand; h.toAct = null;
  returnUncalled(h);
  const pot = potTotal(h), w = S.players[wid];
  w.stack += pot;
  h.result = { type: 'fold', winners: { [wid]: pot }, hands: {}, text: `${w.name} wins ${fmt(pot)}`, bluff: null };
  // The strike rule: postflop, the winner bet or raised, everyone folded, and the best
  // hand that folded to that bet was (right then) better than the winner's hand.
  if (h.street >= 1 && h.lastAggr === wid) {
    const cands = h.order.filter((id) => h.ps[id].folded && h.ps[id].foldStreet === h.street && h.ps[id].foldSeq > h.aggrSeq);
    const we = evalHand(h.ps[wid].hole.concat(h.board));
    let best = null;
    for (const id of cands) { const e = evalHand(h.ps[id].hole.concat(h.board)); if (!best || cmp(e, best.e) > 0) best = { id, e }; }
    if (best && cmp(best.e, we) > 0) {
      const v = S.players[best.id];
      w.bluffs++; v.strikes++;
      h.show[wid] = true; h.show[best.id] = true;
      h.result.bluff = {
        bluffer: { id: wid, name: w.name, cards: h.ps[wid].hole, hand: handName(we) },
        victim: { id: best.id, name: v.name, cards: h.ps[best.id].hole, hand: handName(best.e), strikes: v.strikes },
      };
      h.result.text = `BLUFF! ${w.name} wins ${fmt(pot)} with ${handName(we)}`;
      feed(`BLUFF! ${w.name} bluffed ${v.name} off ${handName(best.e)} with just ${handName(we)}. Strike ${v.strikes} for ${v.name}: one more piece of clothing!`, 'bluff');
    }
  }
  h.stage = 'done'; t.nextAt = now() + (h.result.bluff ? 9000 : 2800);
}

function showdown(t) {
  const h = t.hand; h.pending = null; h.toAct = null;
  const alive = h.order.filter((id) => !h.ps[id].folded);
  const ev = {}; alive.forEach((id) => { h.show[id] = true; ev[id] = evalHand(h.ps[id].hole.concat(h.board)); });
  const levels = [...new Set(alive.map((id) => h.ps[id].committed))].sort((a, b) => a - b);
  const pots = []; let prev = 0, used = 0;
  for (const L of levels) {
    const amt = h.order.reduce((s, id) => s + Math.min(h.ps[id].committed, L) - Math.min(h.ps[id].committed, prev), 0);
    pots.push({ amt, elig: alive.filter((id) => h.ps[id].committed >= L) }); used += amt; prev = L;
  }
  pots[pots.length - 1].amt += potTotal(h) - used;
  const won = {};
  for (const pot of pots) {
    let best = null; for (const id of pot.elig) if (!best || cmp(ev[id], best) > 0) best = ev[id];
    const ws = h.order.filter((id) => pot.elig.includes(id) && cmp(ev[id], best) === 0);
    const share = Math.floor(pot.amt / ws.length); let rest = pot.amt - share * ws.length;
    for (const id of ws) { const x = share + (rest > 0 ? 1 : 0); if (rest > 0) rest--; won[id] = (won[id] || 0) + x; S.players[id].stack += x; }
  }
  const hands = {}; alive.forEach((id) => { hands[id] = handName(ev[id]); });
  const top = Object.keys(won).sort((a, b) => won[b] - won[a]);
  const text = top.length === 1 ? `${S.players[top[0]].name} wins ${fmt(won[top[0]])} with ${hands[top[0]]}`
    : top.map((id) => `${S.players[id].name} ${fmt(won[id])}`).join(', ') + ` (${hands[top[0]]})`;
  h.result = { type: 'showdown', winners: won, hands, text, bluff: null };
  h.stage = 'done'; t.nextAt = now() + 6500;
}

function checkMainOver() {
  if (S.phase !== 'running') return;
  const left = Object.values(S.players).filter((p) => p.group === 'main');
  if (left.length <= 1) {
    if (left[0]) left[0].place = 1;
    S.phase = 'finishing';
    feed(left[0] ? `${left[0].name} wins the tournament!` : 'The tournament is over', 'big');
  }
}

function endHand(t) {
  const h = t.hand; t.hand = null;
  if (t.group === 'main') {
    const out = h.order.filter((id) => S.players[id].stack === 0 || S.players[id].kicked).sort((a, b) => h.ps[a].start - h.ps[b].start);
    for (const id of out) {
      const p = S.players[id];
      p.place = mainCount(); unseat(p); p.group = 'out'; p.stack = 0;
      if (!p.kicked) feed(`${p.name} is out of the main event in ${ord(p.place)} place`, 'out');
    }
    checkMainOver();
    for (const id of out) { const p = S.players[id]; if (!p.kicked && S.phase === 'running') { enterLosers(p); } }
  } else {
    for (const id of h.order) {
      const p = S.players[id];
      if (p.kicked) { unseat(p); p.group = 'out'; }
      else if (p.stack === 0) { p.stack = CONFIG.losers.buyin; p.buyins++; feed(`${p.name} rebuys at the Naughty List table (buy-in ${p.buyins})`); }
    }
  }
  if (rebalance(t) !== 'broken') t.nextAt = now() + 1500;
}

// Keep tables even; break a main table when everyone fits on fewer tables.
function rebalance(t) {
  const g = t.group;
  if (g === 'main' && S.phase === 'running') {
    const ts = groupTables(g), N = ts.reduce((s, x) => s + x.seats.length, 0);
    const target = Math.max(1, Math.ceil(N / CONFIG.maxSeats));
    if (ts.length > target) {
      for (const id of shuffle(t.seats.slice())) {
        const dest = groupTables(g).filter((x) => x !== t).sort((a, b) => a.seats.length - b.seats.length)[0];
        dest.seats.push(id); S.players[id].tableId = dest.id;
        if (!dest.hand) dest.nextAt = Math.max(dest.nextAt, now() + 5000);
      }
      delete S.tables[t.id];
      if (target === 1) { const ft = groupTables(g)[0]; ft.name = 'Final Table'; S.finalTable = true; feed('We are down to the FINAL TABLE!', 'big'); }
      return 'broken';
    }
  }
  for (;;) {
    const m = groupTables(g).filter((x) => x !== t).sort((a, b) => a.seats.length - b.seats.length)[0];
    if (!m || t.seats.length - m.seats.length < 2) break;
    const p = S.players[t.seats[rnd(t.seats.length)]];
    unseat(p); m.seats.push(p.id); p.tableId = m.id;
    if (!m.hand) m.nextAt = Math.max(m.nextAt, now() + 3000);
    feed(`${p.name} moves to ${m.name}`);
  }
  return 'ok';
}

// ---------------------------------------------------------------- bots (for testing / practice)
function botAct(t) {
  const h = t.hand, id = h.toAct, L = legal(h, id), r = Math.random();
  const clamp = (x) => Math.min(L.maxTo, Math.max(L.minTo, Math.round(x / 25) * 25));
  if (L.canCheck) {
    if (L.canRaise && r < 0.28) return act(id, 'raise', clamp(L.currentBet + Math.max(L.bb, L.pot * (0.3 + Math.random() * 0.5))));
    return act(id, 'check');
  }
  const price = L.toCall / (L.pot + L.toCall);
  if (r < 0.12 + price * 0.9) return act(id, 'fold');
  if (L.canRaise && r > 0.9) return act(id, 'raise', Math.random() < 0.08 ? L.maxTo : clamp(L.currentBet * 2 + L.pot * 0.5));
  return act(id, 'call');
}

// ---------------------------------------------------------------- clock
function tick() {
  if (S.paused || S.phase === 'lobby' || S.phase === 'finished') return;
  const n = now();
  if (S.phase === 'running' && n >= S.levelEndsAt) {
    S.level++; S.levelEndsAt = Math.max(S.levelEndsAt + S.levelMinutes * 60000, n + 1000);
    const b = blindsAt(S.level); feed(`Blinds up! Level ${S.level + 1}: ${fmt(b.sb)}/${fmt(b.bb)}, ante ${fmt(b.ante)}`, 'level');
  }
  for (const t of Object.values(S.tables)) {
    if (!S.tables[t.id]) continue;
    const h = t.hand;
    if (!h) { if (S.phase === 'running' && n >= t.nextAt && t.seats.length >= 2) startHand(t); continue; }
    if (h.stage === 'done') { if (n >= t.nextAt) endHand(t); continue; }
    if (h.pending) { if (n >= h.pending.at) { if (h.pending.type === 'deal') deal(t); else showdown(t); } continue; }
    if (h.toAct) {
      const p = S.players[h.toAct];
      if (p.bot && !p.kicked) { if (n >= h.turnStart + (S.botDelay == null ? 1500 : S.botDelay)) botAct(t); continue; }
      const away = p.kicked || n - p.lastSeen > 8000;
      if (n >= h.deadline || (away && n >= h.turnStart + 3000)) {
        const L = legal(h, h.toAct);
        act(h.toAct, L.canCheck && !p.kicked ? 'check' : 'fold', 0, true);
      }
    }
  }
  if (S.phase === 'finishing' && Object.values(S.tables).every((t) => !t.hand)) S.phase = 'finished';
}

function shiftTimes(d) {
  S.levelEndsAt += d;
  for (const t of Object.values(S.tables)) { t.nextAt += d; const h = t.hand; if (h) { h.deadline += d; h.turnStart += d; if (h.pending) h.pending.at += d; } }
}

// ---------------------------------------------------------------- host commands
function host(cmd, a) {
  a = a || {};
  const p = a.pid && S.players[a.pid];
  switch (cmd) {
    case 'start': return start();
    case 'pause': if (!S.paused && S.phase === 'running') { S.paused = true; S.pausedAt = now(); feed('Game paused by the host'); } return null;
    case 'resume': if (S.paused) { S.paused = false; shiftTimes(now() - S.pausedAt); feed('Game resumed'); } return null;
    case 'nextLevel': if (S.phase === 'running') { S.level++; S.levelEndsAt = (S.paused ? S.pausedAt : now()) + S.levelMinutes * 60000; const b = blindsAt(S.level); feed(`Host moved blinds up to ${fmt(b.sb)}/${fmt(b.bb)}`, 'level'); } return null;
    case 'prevLevel': if (S.phase === 'running' && S.level > 0) { S.level--; S.levelEndsAt = (S.paused ? S.pausedAt : now()) + S.levelMinutes * 60000; const b = blindsAt(S.level); feed(`Host moved blinds back to ${fmt(b.sb)}/${fmt(b.bb)}`, 'level'); } return null;
    case 'levelMinutes': { const v = Number(a.value); if (!(v >= 1 && v <= 60)) return 'Level length must be 1 to 60 minutes'; S.levelMinutes = v; return null; }
    case 'actionSeconds': { const v = Number(a.value); if (!(v >= 5 && v <= 120)) return 'Decision clock must be 5 to 120 seconds'; S.actionSeconds = v; return null; }
    case 'prize': { const v = Number(a.value); if (!(v >= 0)) return 'Enter a prize amount'; S.prizePool = Math.round(v); return null; }
    case 'strike': if (!p) return 'Unknown player'; p.strikes = Math.max(0, p.strikes + (Number(a.delta) || 0)); return null;
    case 'bots': { const names = ['Rudolph', 'Dasher', 'Prancer', 'Vixen', 'Comet', 'Cupid', 'Donner', 'Blitzen', 'Frosty', 'Grinch', 'Scrooge', 'Elf', 'Krampus', 'Tiny Tim']; const used = new Set(Object.values(S.players).map((x) => x.name)); let k = Math.min(14, Number(a.value) || 1); for (const nm of names) { if (!k) break; if (used.has(nm + ' (bot)')) continue; addPlayer(nm + ' (bot)', { bot: true }); k--; } return null; }
    case 'kick': {
      if (!p) return 'Unknown player';
      const t = S.tables[p.tableId];
      if (S.phase === 'lobby') { delete S.players[p.id]; return null; }
      p.kicked = true; feed(`${p.name} was removed by the host`);
      if (t && t.hand && t.hand.ps[p.id]) return null; // folds on their turn, removed after the hand
      if (p.group === 'main') { p.place = mainCount(); unseat(p); p.group = 'out'; checkMainOver(); } else { unseat(p); p.group = 'out'; }
      return null;
    }
    case 'endNow': {
      if (S.phase !== 'running') return 'The game is not running';
      for (const t of Object.values(S.tables)) if (t.hand) { if (t.hand.stage !== 'done') for (const id of t.hand.order) S.players[id].stack += t.hand.ps[id].committed; t.hand = null; }
      Object.values(S.players).filter((x) => x.group === 'main').sort((x, y) => y.stack - x.stack).forEach((x, i) => { x.place = i + 1; });
      S.paused = false; S.phase = 'finished'; feed('The host ended the game. Final ranking by chips.', 'big'); return null;
    }
    case 'reset': S = newState(); return null;
    default: return 'Unknown command';
  }
}

// ---------------------------------------------------------------- views
function results() {
  const all = Object.values(S.players).filter((p) => !p.kicked), B = CONFIG.losers.buyin;
  return {
    podium: all.filter((p) => p.place && p.place <= 3).sort((a, b) => a.place - b.place).map((p) => ({ name: p.name, place: p.place, prize: Math.round(S.prizePool * (CONFIG.payouts[p.place - 1] || 0)) })),
    naughty: all.filter((p) => p.buyins > 0 && !(p.place && p.place <= 3)).map((p) => ({ name: p.name, net: p.stack - p.buyins * B, buyins: p.buyins })).sort((a, b) => b.net - a.net),
    bluffers: all.filter((p) => p.bluffs > 0).sort((a, b) => b.bluffs - a.bluffs).slice(0, 5).map((p) => ({ name: p.name, n: p.bluffs })),
    strikes: all.filter((p) => p.strikes > 0).sort((a, b) => b.strikes - a.strikes).map((p) => ({ name: p.name, n: p.strikes })),
  };
}

function view(pid, viewTid) {
  const me = S.players[pid], real = now(), n = S.paused ? S.pausedAt : real, B = CONFIG.losers.buyin;
  me.lastSeen = real;
  const com = {};
  for (const t of Object.values(S.tables)) if (t.hand && t.hand.stage !== 'done') for (const id of t.hand.order) com[id] = t.hand.ps[id].committed;
  const players = Object.values(S.players).filter((p) => !p.kicked).map((p) => {
    const total = p.stack + (com[p.id] || 0);
    return { id: p.id, name: p.name, group: p.group, stack: total, strikes: p.strikes, bluffs: p.bluffs, place: p.place, tableId: p.tableId, on: p.bot || real - p.lastSeen < 8000, buyins: p.buyins, net: p.group === 'losers' ? total - p.buyins * B : 0, host: p.isHost };
  });
  const own = S.tables[me.tableId];
  const t = S.tables[viewTid] || own || groupTables('main')[0] || null;
  let table = null, actions = null, hint = null;
  if (t) {
    const h = t.hand;
    table = {
      id: t.id, name: t.name, group: t.group, mine: t === own,
      board: h ? h.board : [], pot: h ? potTotal(h) : 0, toAct: h ? h.toAct : null,
      timeLeft: h && h.toAct ? Math.max(0, h.deadline - n) : 0, timeTotal: S.actionSeconds * 1000,
      handNo: h ? h.no : 0, stage: h ? h.stage : 'idle', result: h ? h.result : null,
      blinds: h ? { sb: h.sb, bb: h.bb, ante: h.ante } : blindsFor(t.group),
      seats: t.seats.map((id) => {
        const p = S.players[id], q = h && h.ps[id];
        return {
          id, name: p.name, stack: p.stack, strikes: p.strikes, on: p.bot || real - p.lastSeen < 8000, inHand: !!q,
          bet: q ? q.bet : 0, folded: q ? q.folded : false, allin: q ? q.allin && !q.folded : false, last: q ? q.last : '',
          cards: q ? (id === pid || h.show[id] ? q.hole : q.folded ? null : 'back') : null,
          btn: !!h && h.button === id, sb: !!h && h.sbId === id, bb: !!h && h.bbId === id,
          win: h && h.result ? h.result.winners[id] || 0 : 0, hand: h && h.result ? h.result.hands[id] || '' : '',
        };
      }),
    };
    if (h && h.ps[pid] && t === own) {
      const q = h.ps[pid];
      hint = h.board.length ? { text: 'You have: ' + handName(evalHand(q.hole.concat(h.board))), tone: 'ok' } : preflopHint(q.hole);
      if (q.folded) hint = { text: 'You folded this hand.', tone: 'weak' };
    }
  }
  if (own && own.hand && own.hand.toAct === pid) actions = legal(own.hand, pid);
  const b = blindsAt(S.level), nb = blindsAt(S.level + 1);
  return {
    you: { id: me.id, name: me.name, isHost: me.isHost, group: me.group, tableId: me.tableId, place: me.place, strikes: me.strikes, token: me.token },
    phase: S.phase, paused: S.paused, yourTurn: !!actions, finalTable: S.finalTable,
    level: { n: S.level + 1, sb: b.sb, bb: b.bb, ante: b.ante, left: Math.max(0, S.levelEndsAt - n), next: nb },
    prizePool: S.prizePool, payouts: CONFIG.payouts.map((x) => Math.round(S.prizePool * x)),
    settings: { levelMinutes: S.levelMinutes, actionSeconds: S.actionSeconds, startStack: CONFIG.startStack, losers: CONFIG.losers },
    players, tables: Object.values(S.tables).map((x) => ({ id: x.id, name: x.name, group: x.group, n: x.seats.length })),
    table, actions, hint, feed: S.feed.slice(-30), results: S.phase === 'finished' ? results() : null,
  };
}

module.exports = {
  CONFIG, addPlayer, byToken, act, tick, host, view, results, evalHand, handName, cmp,
  state: () => S,
  save: () => { S.savedAt = now(); return JSON.stringify(S); },
  load: (json) => { S = JSON.parse(json); if (S.phase !== 'lobby' && !S.paused && S.savedAt) shiftTimes(now() - S.savedAt); },
  setClock: (fn) => { clock = fn; },
};
