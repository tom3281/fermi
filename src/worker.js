import { QUESTIONS } from "./questions.js";

// ===== Constants =====
const PHASES = {
  LOBBY: "lobby",
  GUESS: "guess",   // everyone secretly submits a positive number
  REVEAL: "reveal", // answer revealed, furthest (log scale) drinks
};
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2; // head-to-head works fine: further from the answer drinks
const GRACE_MS = 15_000;
const GUESS_MS = 75_000;  // a bit longer than other games — typing big numbers
const MAX_GUESS = 1e21;

// ===== Worker entry =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(room)) {
        return new Response("Invalid room code", { status: 400 });
      }
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ===== GameRoom Durable Object =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
    this.players = new Map(); // playerId -> { name, drinkCount, removeTimer, guess }
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    this.round = 0;
    this.question = null;     // current QUESTIONS entry
    this.guessDeadline = null;
    this.deck = [];           // shuffled question indices; refilled when empty
    this.timers = [];
    this.lastResult = null;
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 20);
    const clientId = (url.searchParams.get("clientId") || "").trim();
    if (!name) return new Response("Missing name", { status: 400 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) {
      return new Response("Missing or invalid clientId", { status: 400 });
    }

    const existing = this.players.get(clientId);

    let rejectCode = 0;
    let rejectReason = "";
    if (!existing) {
      if (this.players.size >= MAX_PLAYERS) {
        rejectCode = 4030; rejectReason = "Room full";
      } else if (this.phase === PHASES.GUESS) {
        // New players can join in LOBBY and between rounds (REVEAL).
        rejectCode = 4023; rejectReason = "Round in progress";
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (rejectCode) {
      try { server.close(rejectCode, rejectReason); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    if (existing) {
      if (existing.removeTimer) {
        clearTimeout(existing.removeTimer);
        existing.removeTimer = null;
      }
      existing.name = name;
    } else {
      this.players.set(clientId, {
        name,
        drinkCount: 0,
        removeTimer: null,
        guess: null,
      });
      if (!this.hostId) this.hostId = clientId;
    }

    const prior = existing ? this.sessions.get(clientId) : null;
    this.sessions.set(clientId, { ws: server, playerId: clientId });

    server.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      await this.handleMessage(clientId, msg);
    });
    const onClose = () => {
      const sess = this.sessions.get(clientId);
      if (sess && sess.ws === server) this.handleDisconnect(clientId);
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    if (prior) {
      try { prior.ws.close(4002, "Replaced by new connection"); } catch {}
    }

    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(playerId, msg) {
    switch (msg.type) {
      case "ping": {
        const sess = this.sessions.get(playerId);
        if (sess) {
          try { sess.ws.send(JSON.stringify({ type: "pong" })); } catch {}
        }
        break;
      }
      case "hello": {
        const sess = this.sessions.get(playerId);
        if (sess) {
          try { sess.ws.send(JSON.stringify(this.viewForPlayer(playerId))); } catch {}
        }
        break;
      }
      case "start":
        if (playerId === this.hostId
            && (this.phase === PHASES.LOBBY || this.phase === PHASES.REVEAL)) {
          if (this.players.size < MIN_PLAYERS) return;
          this.startRound();
        }
        break;
      case "guess": {
        if (this.phase !== PHASES.GUESS) return;
        const p = this.players.get(playerId);
        if (!p || p.guess) return; // lock-in is final
        const v = Number(msg.value);
        // Must be a positive finite number (log scale → zero is meaningless).
        if (!Number.isFinite(v) || v <= 0 || v > MAX_GUESS) return;
        p.guess = { value: v };
        if (this.allGuessed()) {
          this.resolveRound();
        } else {
          this.broadcast();
        }
        break;
      }
    }
  }

  handleDisconnect(clientId) {
    this.sessions.delete(clientId);
    const player = this.players.get(clientId);
    if (!player) return;

    if (this.phase === PHASES.LOBBY) {
      this.removePlayer(clientId);
      this.broadcast();
      return;
    }

    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      player.removeTimer = null;
      if (this.sessions.has(clientId)) return; // reconnected during grace
      this.removePlayerFromGame(clientId);
    }, GRACE_MS);
    this.broadcast();
  }

  removePlayerFromGame(clientId) {
    this.removePlayer(clientId);
    if (this.players.size < MIN_PLAYERS) {
      this.resetToLobby();
      return;
    }
    if (this.phase === PHASES.GUESS && this.allGuessed()) {
      this.resolveRound();
      return;
    }
    this.broadcast();
  }

  removePlayer(clientId) {
    this.players.delete(clientId);
    if (this.hostId === clientId) {
      this.hostId = this.players.keys().next().value || null;
    }
  }

  allGuessed() {
    for (const p of this.players.values()) {
      if (!p.guess) return false;
    }
    return this.players.size > 0;
  }

  nextQuestion() {
    if (this.deck.length === 0) {
      this.deck = [...QUESTIONS.keys()];
      // Fisher–Yates
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
      }
      // After a reshuffle, don't repeat the question we just played.
      if (this.question && QUESTIONS[this.deck[this.deck.length - 1]] === this.question) {
        this.deck.unshift(this.deck.pop());
      }
    }
    return QUESTIONS[this.deck.pop()];
  }

  startRound() {
    this.clearTimers();
    this.phase = PHASES.GUESS;
    this.round += 1;
    this.question = this.nextQuestion();
    this.guessDeadline = Date.now() + GUESS_MS;
    this.lastResult = null;
    for (const p of this.players.values()) p.guess = null;
    this.timers.push(setTimeout(() => {
      if (this.phase === PHASES.GUESS) this.resolveRound();
    }, GUESS_MS));
    this.broadcast();
  }

  resolveRound() {
    this.clearTimers();

    // Anyone with no guess by now ran out the clock.
    for (const p of this.players.values()) {
      if (!p.guess) p.guess = { abstain: true };
    }

    const submitted = []; // { id, value }
    const abstainIds = [];
    for (const [id, p] of this.players) {
      if (p.guess.abstain) abstainIds.push(id);
      else submitted.push({ id, value: p.guess.value });
    }

    // Log-scale judging: dist = |log10(guess) - log10(answer)| so being 10×
    // over and 10× under are equally wrong. Furthest drinks 1 (ties all
    // drink), closest gets the crown. All-equidistant → draw. Fewer than 2
    // guesses → no contest → draw. Abstainers always drink 1.
    const answer = this.question.a;
    const losers = new Set(abstainIds);
    let outcome, entries = [];
    if (submitted.length < 2) {
      outcome = "draw";
      entries = submitted.map(s => ({ ...s, dist: 0, loser: false, crown: false }));
    } else {
      entries = submitted.map(s => ({
        ...s,
        dist: Math.abs(Math.log10(s.value) - Math.log10(answer)),
      }));
      entries.sort((x, y) => x.dist - y.dist);
      const minDist = entries[0].dist;
      const maxDist = entries[entries.length - 1].dist;
      if (maxDist === minDist) {
        outcome = "draw";
        for (const e of entries) { e.loser = false; e.crown = false; }
      } else {
        outcome = "busted";
        for (const e of entries) {
          e.crown = e.dist === minDist;
          e.loser = e.dist === maxDist;
          if (e.loser) losers.add(e.id);
        }
      }
    }
    for (const id of losers) {
      const p = this.players.get(id);
      if (p) p.drinkCount += 1;
    }

    this.phase = PHASES.REVEAL;
    this.guessDeadline = null;
    this.lastResult = {
      round: this.round,
      outcome,                 // "busted" | "draw"
      question: this.question, // q + a + u + n all revealed now
      entries: entries.map(e => ({
        id: e.id,
        value: e.value,
        // ×factor off the answer; 10^dist, rounded for display
        factor: Math.round(Math.pow(10, e.dist) * 100) / 100,
        loser: !!e.loser,
        crown: !!e.crown,
      })),
      abstain: abstainIds,
      losers: [...losers],
    };
    this.broadcast();
  }

  resetToLobby() {
    this.clearTimers();
    this.phase = PHASES.LOBBY;
    this.question = null;
    this.guessDeadline = null;
    this.lastResult = null;
    for (const p of this.players.values()) p.guess = null;
    this.broadcast();
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  broadcast() {
    for (const [, session] of this.sessions) {
      try {
        session.ws.send(JSON.stringify(this.viewForPlayer(session.playerId)));
      } catch {}
    }
  }

  viewForPlayer(playerId) {
    const players = [...this.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      drinkCount: p.drinkCount,
      isYou: id === playerId,
      // Guesses stay secret until REVEAL — only the fact of submission leaks.
      guessed: !!p.guess,
      connected: this.sessions.has(id),
    }));
    const me = this.players.get(playerId);
    return {
      type: "state",
      state: {
        phase: this.phase,
        players,
        hostId: this.hostId,
        you: playerId,
        round: this.round,
        // During GUESS only the question text + unit go out — never the answer.
        topic: this.phase === PHASES.GUESS
          ? { q: this.question.q, u: this.question.u }
          : null,
        guessDeadline: this.phase === PHASES.GUESS ? this.guessDeadline : null,
        myGuess: (me && me.guess && typeof me.guess.value === "number") ? me.guess.value : null,
        result: this.phase === PHASES.REVEAL ? this.lastResult : null,
      },
    };
  }
}
