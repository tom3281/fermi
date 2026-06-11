// Smoke test: 4 players.
// Round 1 = distinct guesses; recompute log-scale judging from the revealed
//           answer and check the server agrees. + secrecy / validation checks.
// Round 2 = everyone guesses the same → draw, nobody drinks.
// Usage: node test-flow.mjs [port]
const PORT = process.argv[2] || "8792";
const ROOM = "TEST1";

function client(name, id) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}&name=${name}&clientId=${id}`);
  const c = { name, id, ws, state: null };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello" })));
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") c.state = msg.state;
  });
  ws.addEventListener("close", (e) => console.log(`[${name}] closed ${e.code} ${e.reason}`));
  return c;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, desc, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error("timeout waiting for: " + desc);
}

const a = client("Alice", "aaaaaaaa-test-0001");
const b = client("Bob", "bbbbbbbb-test-0002");
const c = client("Carol", "cccccccc-test-0003");
const d = client("Dave", "dddddddd-test-0004");
const all = [a, b, c, d];

await waitFor(() => all.every(x => x.state && x.state.players.length === 4), "all in lobby");
console.log("LOBBY OK — host:", a.state.hostId);
const host = all.find(x => x.state.you === x.state.hostId);

// ===== Round 1 =====
host.ws.send(JSON.stringify({ type: "start" }));
await waitFor(() => all.every(x => x.state.phase === "guess" && x.state.topic), "guess phase 1");
console.log("GUESS OK — question:", a.state.topic.q, "/ unit:", a.state.topic.u);
if ("a" in a.state.topic) throw new Error("answer leaked in topic during GUESS phase");
if (!a.state.guessDeadline) throw new Error("guessDeadline should be set");

// Invalid guesses must be ignored.
a.ws.send(JSON.stringify({ type: "guess", value: 0 }));
a.ws.send(JSON.stringify({ type: "guess", value: -5 }));
a.ws.send(JSON.stringify({ type: "guess", value: "abc" }));
a.ws.send(JSON.stringify({ type: "guess", value: 1e22 }));
await sleep(300);
if (a.state.myGuess !== null) throw new Error("invalid guesses should be rejected");
console.log("VALIDATION OK — zero/negative/NaN/too-big rejected");

const guesses = { [a.id]: 1, [b.id]: 100, [c.id]: 10000, [d.id]: 100000000 };
a.ws.send(JSON.stringify({ type: "guess", value: guesses[a.id] }));
await waitFor(() => b.state.players.find(p => p.id === a.id)?.guessed, "Alice guessed flag");
const aliceFromBob = b.state.players.find(p => p.id === a.id);
if ("value" in aliceFromBob || "guess" in aliceFromBob) throw new Error("guess value leaked during GUESS phase");
console.log("SECRECY OK — guessed flag visible, value hidden");

// Lock-in is final.
a.ws.send(JSON.stringify({ type: "guess", value: 777 }));
await sleep(300);
if (a.state.myGuess !== 1) throw new Error("guess should be immutable after lock-in");
console.log("LOCK OK — second guess ignored");

b.ws.send(JSON.stringify({ type: "guess", value: guesses[b.id] }));
c.ws.send(JSON.stringify({ type: "guess", value: guesses[c.id] }));
d.ws.send(JSON.stringify({ type: "guess", value: guesses[d.id] }));

await waitFor(() => all.every(x => x.state.phase === "reveal" && x.state.result), "reveal 1");
const r1 = a.state.result;
const answer = r1.question.a;
console.log("RESULT 1: answer =", answer, r1.question.u,
  r1.entries.map(e => `${e.value}(×${e.factor}${e.crown ? ",👑" : ""}${e.loser ? ",🍺" : ""})`).join(" "));

// Recompute expected judging and compare with the server.
const dists = Object.fromEntries(Object.entries(guesses).map(([id, v]) =>
  [id, Math.abs(Math.log10(v) - Math.log10(answer))]));
const maxD = Math.max(...Object.values(dists));
const minD = Math.min(...Object.values(dists));
const expectLosers = new Set(Object.keys(dists).filter(id => dists[id] === maxD));
const expectCrowns = new Set(Object.keys(dists).filter(id => dists[id] === minD));
if (maxD === minD) {
  if (r1.outcome !== "draw") throw new Error("expected draw");
} else {
  if (r1.outcome !== "busted") throw new Error("expected busted outcome");
  const gotLosers = new Set(r1.losers);
  if (gotLosers.size !== expectLosers.size || [...expectLosers].some(id => !gotLosers.has(id)))
    throw new Error("server losers disagree with log-scale recomputation");
  for (const e of r1.entries) {
    if (e.crown !== expectCrowns.has(e.id)) throw new Error("crown mismatch for " + e.id);
  }
  for (const id of expectLosers) {
    const p = a.state.players.find(p => p.id === id);
    if (p.drinkCount !== 1) throw new Error("loser should have 1 drink");
  }
  // Entries must be sorted closest-first.
  for (let i = 1; i < r1.entries.length; i++) {
    if (dists[r1.entries[i - 1].id] > dists[r1.entries[i].id] + 1e-12)
      throw new Error("entries not sorted by distance");
  }
}
console.log("ROUND 1 OK — server judging matches log-scale recomputation");

// ===== Round 2: all same guess → draw =====
host.ws.send(JSON.stringify({ type: "start" }));
await waitFor(() => all.every(x => x.state.phase === "guess" && x.state.round === 2), "guess phase 2");
const q2 = a.state.topic.q;
if (q2 === r1.question.q) console.log("WARN: same question twice (deck should prevent this)");
for (const x of all) x.ws.send(JSON.stringify({ type: "guess", value: 555 }));

await waitFor(() => all.every(x => x.state.phase === "reveal" && x.state.result.round === 2), "reveal 2");
const r2 = a.state.result;
console.log("RESULT 2:", r2.outcome, "losers:", r2.losers.length);
if (r2.outcome !== "draw") throw new Error("all-same guesses should be a draw");
if (r2.losers.length !== 0) throw new Error("draw should have no losers");
console.log("ROUND 2 OK — draw, no drinks");

console.log("\nALL TESTS PASSED");
for (const x of all) x.ws.close(1000);
process.exit(0);
