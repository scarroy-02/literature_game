const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Card & Pit Definitions ──────────────────────────────────────────────
const SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const SUIT_SYMBOLS = { Hearts: '♥', Diamonds: '♦', Clubs: '♣', Spades: '♠' };
const SUIT_COLORS = { Hearts: 'red', Diamonds: 'red', Clubs: 'black', Spades: 'black' };

function buildDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (let v = 2; v <= 14; v++) { // 2-10, J=11, Q=12, K=13, A=14
      if (v === 8) continue; // 8s go in special pit
      cards.push({ suit, value: v, id: `${v}-${suit}` });
    }
  }
  // 8s
  for (const suit of SUITS) {
    cards.push({ suit, value: 8, id: `8-${suit}` });
  }
  // Jokers
  cards.push({ suit: 'Joker', value: 0, id: 'Joker-Red' });
  cards.push({ suit: 'Joker', value: 1, id: 'Joker-Black' });
  return cards;
}

function getPitName(card) {
  if (card.suit === 'Joker' || card.value === 8) return 'Eights & Jokers';
  if (card.value >= 2 && card.value <= 7) return `Low ${card.suit}`;
  return `High ${card.suit}`;
}

function getPitCards(pitName) {
  const all = buildDeck();
  return all.filter(c => getPitName(c) === pitName);
}

const ALL_PIT_NAMES = [
  'Low Hearts', 'Low Diamonds', 'Low Clubs', 'Low Spades',
  'High Hearts', 'High Diamonds', 'High Clubs', 'High Spades',
  'Eights & Jokers'
];

function cardDisplayName(card) {
  if (card.suit === 'Joker') return card.id === 'Joker-Red' ? 'Red Joker' : 'Black Joker';
  const names = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const vName = names[card.value] || card.value.toString();
  return `${vName}${SUIT_SYMBOLS[card.suit]}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Room & Game State ───────────────────────────────────────────────────
const rooms = new Map();

function createRoom(code) {
  return {
    code,
    players: [],        // [{id, name, socketId, team, seatIndex}]
    state: 'lobby',     // lobby | playing | finished
    hands: {},          // playerId -> [card]
    currentTurn: null,   // playerId
    claimedPits: {},    // pitName -> teamIndex (0 or 1)
    droppedOut: new Set(),
    lastCall: null,     // {callerId, targetId, card, success}
    lastPitClaim: null, // {pitName, team, claimerName, valid}
    log: [],
    turnOrder: [],      // ordered player ids around the circle
    continuePlaying: false, // when true, game continues past 5 pits
    pendingTurnChoice: null, // playerId who must choose a teammate for the turn
  };
}

function getRoom(code) { return rooms.get(code); }
function teamName(t) { return t === 0 ? 'Blue' : 'Red'; }

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function addLog(room, msg) {
  room.log.push({ msg, ts: Date.now() });
  if (room.log.length > 100) room.log.shift();
}

function getPlayerById(room, id) { return room.players.find(p => p.id === id); }

function teamPlayers(room, teamIdx) { return room.players.filter(p => p.team === teamIdx); }

function activeTeamPlayers(room, teamIdx) {
  return teamPlayers(room, teamIdx).filter(p => !room.droppedOut.has(p.id));
}

function getNextOpponentToLeft(room, playerId) {
  const player = getPlayerById(room, playerId);
  const idx = room.turnOrder.indexOf(playerId);
  for (let i = 1; i < room.turnOrder.length; i++) {
    const nextIdx = (idx + i) % room.turnOrder.length;
    const nextId = room.turnOrder[nextIdx];
    const nextPlayer = getPlayerById(room, nextId);
    if (nextPlayer.team !== player.team && !room.droppedOut.has(nextId) && (room.hands[nextId] || []).length > 0) {
      return nextId;
    }
  }
  return null;
}

function checkGameOver(room) {
  const claimed = Object.keys(room.claimedPits).length;
  if (claimed === 9) return true;

  // Check if a team has won 5 pits (majority)
  const scores = getScores(room);
  if (!room.continuePlaying && (scores[0] >= 5 || scores[1] >= 5)) return true;

  // Check if both teams still have active players
  const t0 = activeTeamPlayers(room, 0);
  const t1 = activeTeamPlayers(room, 1);
  if (t0.length === 0 && t1.length === 0) return true;

  return false;
}

function getScores(room) {
  let s = [0, 0];
  for (const pit in room.claimedPits) s[room.claimedPits[pit]]++;
  return s;
}

function handleDropOut(room, playerId) {
  room.droppedOut.add(playerId);
  const player = getPlayerById(room, playerId);
  addLog(room, `${player.name} has dropped out.`);
}

function checkPlayerShouldDropOut(room, playerId) {
  if (room.droppedOut.has(playerId)) return;
  const hand = room.hands[playerId] || [];
  if (hand.length === 0 && room.currentTurn !== playerId) {
    handleDropOut(room, playerId);
  }
}

// After a successful claim, if the claimer has 0 cards, handle turn passing
function handlePostClaim(room, playerId) {
  const hand = room.hands[playerId] || [];
  if (hand.length === 0) {
    const player = getPlayerById(room, playerId);
    const teammates = activeTeamPlayers(room, player.team)
      .filter(p => p.id !== playerId && (room.hands[p.id] || []).length > 0);
    handleDropOut(room, playerId);
    if (teammates.length === 1) {
      // Only one option — auto-assign
      room.currentTurn = teammates[0].id;
      addLog(room, `Turn passes to ${teammates[0].name}.`);
    } else if (teammates.length > 1) {
      // Let the player choose who gets the turn
      room.pendingTurnChoice = playerId;
      room.currentTurn = playerId; // keep turn on them until they choose
    } else {
      // No teammates with cards left, pass to opponent
      const opp = getNextOpponentToLeft(room, playerId);
      if (opp) {
        room.currentTurn = opp;
        addLog(room, `Turn passes to ${getPlayerById(room, opp).name}.`);
      }
    }
  }
}

// When entire team drops out
function handleTeamDropout(room) {
  const t0Active = activeTeamPlayers(room, 0);
  const t1Active = activeTeamPlayers(room, 1);

  if (t0Active.length === 0 && t1Active.length > 0) {
    // Team 0 dropped out, remaining pits need to be claimed by team 1
    autoClaimRemaining(room, 1);
  } else if (t1Active.length === 0 && t0Active.length > 0) {
    autoClaimRemaining(room, 0);
  }
}

function autoClaimRemaining(room, teamIdx) {
  // The current player must try to claim remaining pits
  // For simplicity, unclaimed pits where team has all cards are auto-claimed
  for (const pitName of ALL_PIT_NAMES) {
    if (room.claimedPits[pitName] !== undefined) continue;
    const pitCards = getPitCards(pitName);
    const teamIds = teamPlayers(room, teamIdx).map(p => p.id);
    const allInTeam = pitCards.every(pc =>
      teamIds.some(tid => (room.hands[tid] || []).some(c => c.id === pc.id))
    );
    if (allInTeam) {
      room.claimedPits[pitName] = teamIdx;
      addLog(room, `Team ${teamName(teamIdx)} claims ${pitName}!`);
    } else {
      // Award to the other team
      room.claimedPits[pitName] = 1 - teamIdx;
      addLog(room, `${pitName} awarded to Team ${teamName(1 - teamIdx)}.`);
    }
  }
}

function startGame(room) {
  const deck = shuffle(buildDeck());
  room.state = 'playing';
  room.hands = {};
  room.claimedPits = {};
  room.droppedOut = new Set();
  room.lastCall = null;
  room.lastPitClaim = null;
  room.continuePlaying = false;
  room.pendingTurnChoice = null;
  room.log = [];

  // Seat arrangement: alternate teams
  // Players are already assigned teams and seats
  room.turnOrder = room.players
    .sort((a, b) => a.seatIndex - b.seatIndex)
    .map(p => p.id);

  // Deal 9 cards each
  for (let i = 0; i < 6; i++) {
    const pid = room.players[i].id;
    room.hands[pid] = deck.slice(i * 9, (i + 1) * 9);
  }

  // Random starting player
  room.currentTurn = room.turnOrder[Math.floor(Math.random() * 6)];
  addLog(room, `Game started! ${getPlayerById(room, room.currentTurn).name} goes first.`);
}

// ── Socket.IO ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = null;

  socket.on('create-room', ({ playerName }, cb) => {
    const code = generateCode();
    const room = createRoom(code);
    playerId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    room.players.push({ id: playerId, name: playerName, socketId: socket.id, team: 0, seatIndex: 0 });
    rooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    cb({ success: true, code, playerId, room: sanitizeRoom(room, playerId) });
    io.to(code).emit('room-update', sanitizeRoomForAll(room));
  });

  socket.on('join-room', ({ code, playerName }, cb) => {
    code = code.toUpperCase();
    const room = getRoom(code);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.players.length >= 6) return cb({ success: false, error: 'Room is full.' });
    if (room.state !== 'lobby') return cb({ success: false, error: 'Game already in progress.' });

    playerId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const idx = room.players.length;
    // Alternate teams: seats 0,2,4 = team 0; seats 1,3,5 = team 1
    const team = idx % 2 === 0 ? 0 : 1;
    room.players.push({ id: playerId, name: playerName, socketId: socket.id, team, seatIndex: idx });
    currentRoom = code;
    socket.join(code);
    cb({ success: true, code, playerId, room: sanitizeRoom(room, playerId) });
    io.to(code).emit('room-update', sanitizeRoomForAll(room));
  });

  socket.on('swap-team', ({ targetPlayerId }, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'lobby') return cb({ success: false });
    // Any player can swap themselves; host can swap anyone
    const isHost = room.players[0].id === playerId;
    const isSelf = targetPlayerId === playerId;
    if (!isHost && !isSelf) return cb({ success: false, error: 'You can only swap yourself.' });

    const target = getPlayerById(room, targetPlayerId);
    if (!target) return cb({ success: false });
    target.team = target.team === 0 ? 1 : 0;

    // Reassign seat indices to maintain alternating pattern
    const t0 = room.players.filter(p => p.team === 0);
    const t1 = room.players.filter(p => p.team === 1);
    let seat = 0;
    for (let i = 0; i < Math.max(t0.length, t1.length); i++) {
      if (t0[i]) { t0[i].seatIndex = seat++; }
      if (t1[i]) { t1[i].seatIndex = seat++; }
    }

    cb({ success: true });
    io.to(currentRoom).emit('room-update', sanitizeRoomForAll(room));
  });

  socket.on('start-game', (_, cb) => {
    const room = getRoom(currentRoom);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.players.length !== 6) return cb({ success: false, error: 'Need exactly 6 players.' });
    if (room.players[0].id !== playerId) return cb({ success: false, error: 'Only host can start.' });

    const t0 = room.players.filter(p => p.team === 0);
    const t1 = room.players.filter(p => p.team === 1);
    if (t0.length !== 3 || t1.length !== 3) return cb({ success: false, error: 'Need 3 players per team.' });

    startGame(room);
    cb({ success: true });
    broadcastGameState(room);
  });

  socket.on('call-card', ({ targetPlayerId, cardId }, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing') return cb({ success: false, error: 'Game not in progress.' });
    if (room.currentTurn !== playerId) return cb({ success: false, error: 'Not your turn.' });

    const caller = getPlayerById(room, playerId);
    const target = getPlayerById(room, targetPlayerId);
    if (!target) return cb({ success: false, error: 'Invalid target.' });
    if (target.team === caller.team) return cb({ success: false, error: 'Cannot call from teammate.' });
    if (room.droppedOut.has(targetPlayerId)) return cb({ success: false, error: 'That player has dropped out.' });

    // Find the card definition
    const allCards = buildDeck();
    const card = allCards.find(c => c.id === cardId);
    if (!card) return cb({ success: false, error: 'Invalid card.' });

    const callerHand = room.hands[playerId] || [];
    const targetHand = room.hands[targetPlayerId] || [];
    const pitName = getPitName(card);

    // Validate: caller must NOT have the card
    if (callerHand.some(c => c.id === cardId)) {
      // Invalid call - caller has the card
      room.claimedPits[pitName] = target.team;
      room.lastPitClaim = { pitName, team: target.team, claimerName: caller.name, valid: false };
      addLog(room, `INVALID CALL by ${caller.name}! They already have ${cardDisplayName(card)}. ${pitName} goes to Team ${teamName(target.team)}.`);
      room.lastCall = { callerId: playerId, targetId: targetPlayerId, card, success: false, invalid: true };
      room.currentTurn = getNextOpponentToLeft(room, playerId);
      removePitCardsFromHands(room, pitName);
      checkAllDropouts(room);
      if (checkGameOver(room)) finishGame(room);
      cb({ success: true });
      broadcastGameState(room);
      return;
    }

    // Validate: caller must have at least one card from same pit
    if (!callerHand.some(c => getPitName(c) === pitName)) {
      // Invalid call
      room.claimedPits[pitName] = target.team;
      room.lastPitClaim = { pitName, team: target.team, claimerName: caller.name, valid: false };
      addLog(room, `INVALID CALL by ${caller.name}! They have no cards from ${pitName}. ${pitName} goes to Team ${teamName(target.team)}.`);
      room.lastCall = { callerId: playerId, targetId: targetPlayerId, card, success: false, invalid: true };
      room.currentTurn = getNextOpponentToLeft(room, playerId);
      removePitCardsFromHands(room, pitName);
      checkAllDropouts(room);
      if (checkGameOver(room)) finishGame(room);
      cb({ success: true });
      broadcastGameState(room);
      return;
    }

    // Valid call - check if target has the card
    const targetHasCard = targetHand.some(c => c.id === cardId);
    if (targetHasCard) {
      // Transfer card
      room.hands[targetPlayerId] = targetHand.filter(c => c.id !== cardId);
      room.hands[playerId] = [...callerHand, card];
      addLog(room, `${caller.name} asked ${target.name} for ${cardDisplayName(card)} — GOT IT!`);
      room.lastCall = { callerId: playerId, targetId: targetPlayerId, card, success: true };
      // Caller keeps turn
      checkPlayerShouldDropOut(room, targetPlayerId);
      checkAllDropouts(room);
      if (checkGameOver(room)) finishGame(room);
    } else {
      addLog(room, `${caller.name} asked ${target.name} for ${cardDisplayName(card)} — NOPE!`);
      room.lastCall = { callerId: playerId, targetId: targetPlayerId, card, success: false };
      room.currentTurn = targetPlayerId;
    }

    cb({ success: true });
    broadcastGameState(room);
  });

  socket.on('claim-pit', ({ pitName, assignments }, cb) => {
    // assignments: [{cardId, playerId}] — who has which card in the pit
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing') return cb({ success: false, error: 'Game not in progress.' });
    if (room.currentTurn !== playerId) return cb({ success: false, error: 'Not your turn.' });
    if (room.claimedPits[pitName] !== undefined) return cb({ success: false, error: 'Pit already claimed.' });

    const claimer = getPlayerById(room, playerId);
    const pitCards = getPitCards(pitName);

    // Check if all assigned cards are correct
    let valid = true;
    const teamIds = teamPlayers(room, claimer.team).map(p => p.id);

    // Verify all assignments are for team members
    for (const a of assignments) {
      if (!teamIds.includes(a.playerId)) { valid = false; break; }
    }

    if (valid && assignments.length === pitCards.length) {
      // Check each assignment
      for (const a of assignments) {
        const hand = room.hands[a.playerId] || [];
        if (!hand.some(c => c.id === a.cardId)) { valid = false; break; }
      }
      // Also check all pit cards are accounted for
      const assignedIds = new Set(assignments.map(a => a.cardId));
      for (const pc of pitCards) {
        if (!assignedIds.has(pc.id)) { valid = false; break; }
      }
    } else {
      valid = false;
    }

    if (valid) {
      room.claimedPits[pitName] = claimer.team;
      room.lastPitClaim = { pitName, team: claimer.team, claimerName: claimer.name, valid: true };
      addLog(room, `${claimer.name} correctly claimed ${pitName} for Team ${teamName(claimer.team)}!`);
      removePitCardsFromHands(room, pitName);
      checkAllDropouts(room);

      if (checkGameOver(room)) {
        finishGame(room);
      } else {
        handlePostClaim(room, playerId);
      }
    } else {
      const awardedTeam = 1 - claimer.team;
      room.claimedPits[pitName] = awardedTeam;
      room.lastPitClaim = { pitName, team: awardedTeam, claimerName: claimer.name, valid: false };
      addLog(room, `${claimer.name} made an INVALID claim for ${pitName}. Awarded to Team ${teamName(1 - claimer.team)}!`);
      removePitCardsFromHands(room, pitName);
      room.currentTurn = getNextOpponentToLeft(room, playerId);
      checkAllDropouts(room);
      if (checkGameOver(room)) finishGame(room);
    }

    cb({ success: true });
    broadcastGameState(room);
  });

  socket.on('pass-turn', ({ targetTeammateId }, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing') return cb({ success: false });
    if (room.currentTurn !== playerId) return cb({ success: false, error: 'Not your turn.' });

    const player = getPlayerById(room, playerId);
    const hand = room.hands[playerId] || [];
    if (hand.length !== 1) return cb({ success: false, error: 'Can only pass with exactly 1 card.' });

    const target = getPlayerById(room, targetTeammateId);
    if (!target || target.team !== player.team) return cb({ success: false, error: 'Must pass to a teammate.' });
    if (room.droppedOut.has(targetTeammateId)) return cb({ success: false, error: 'Teammate has dropped out.' });

    // Transfer card and turn
    const card = hand[0];
    room.hands[playerId] = [];
    room.hands[targetTeammateId] = [...(room.hands[targetTeammateId] || []), card];
    room.currentTurn = targetTeammateId;
    handleDropOut(room, playerId);
    addLog(room, `${player.name} passed the baton to ${target.name}.`);

    checkAllDropouts(room);
    if (checkGameOver(room)) finishGame(room);
    cb({ success: true });
    broadcastGameState(room);
  });

  socket.on('choose-turn', ({ targetTeammateId }, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing') return cb({ success: false, error: 'Game not in progress.' });
    if (room.pendingTurnChoice !== playerId) return cb({ success: false, error: 'Not your choice to make.' });

    const player = getPlayerById(room, playerId);
    const target = getPlayerById(room, targetTeammateId);
    if (!target || target.team !== player.team) return cb({ success: false, error: 'Must choose a teammate.' });
    if (room.droppedOut.has(targetTeammateId) || (room.hands[targetTeammateId] || []).length === 0) {
      return cb({ success: false, error: 'That teammate has no cards.' });
    }

    room.pendingTurnChoice = null;
    room.currentTurn = targetTeammateId;
    addLog(room, `${player.name} chose ${target.name} to take the turn.`);
    cb({ success: true });
    broadcastGameState(room);
  });

  socket.on('get-player-count', ({ targetPlayerId }, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing') return cb({ count: 0 });
    const hand = room.hands[targetPlayerId] || [];
    cb({ count: hand.length });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;

    if (room.state === 'lobby') {
      room.players = room.players.filter(p => p.id !== playerId);
      if (room.players.length === 0) {
        rooms.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('room-update', sanitizeRoomForAll(room));
      }
    } else if (room.state === 'playing') {
      // Mark as disconnected but don't remove
      const player = getPlayerById(room, playerId);
      if (player) {
        player.disconnected = true;
        io.to(currentRoom).emit('room-update', sanitizeRoomForAll(room));
      }
    }
  });

  socket.on('reconnect-room', ({ code, pid }, cb) => {
    code = code.toUpperCase();
    const room = getRoom(code);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.id === pid);
    if (!player) return cb({ success: false, error: 'Player not found in room.' });
    player.socketId = socket.id;
    player.disconnected = false;
    playerId = pid;
    currentRoom = code;
    socket.join(code);
    cb({ success: true, room: sanitizeRoom(room, pid) });
    broadcastGameState(room);
  });

  socket.on('continue-game', (_, cb) => {
    const room = getRoom(currentRoom);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.players[0].id !== playerId) return cb({ success: false, error: 'Only host can continue.' });
    if (room.state !== 'finished') return cb({ success: false, error: 'Game not finished.' });

    room.continuePlaying = true;
    room.state = 'playing';
    // If all pits claimed, truly done
    if (Object.keys(room.claimedPits).length === 9) {
      return cb({ success: false, error: 'All pits already claimed.' });
    }
    cb({ success: true });
    broadcastGameState(room);
  });

  socket.on('end-game', (_, cb) => {
    const room = getRoom(currentRoom);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.players[0].id !== playerId) return cb({ success: false, error: 'Only host can end the game.' });
    if (room.state !== 'playing') return cb({ success: false, error: 'Game is not in progress.' });

    addLog(room, 'Game ended early by the host.');
    finishGame(room);
    cb({ success: true });
    broadcastGameState(room);
  });

  // Debug: force a state where claimer has 0 cards after claiming
  socket.on('debug-force-claim', ({ pitName }, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing') return cb({ success: false });
    if (room.currentTurn !== playerId) return cb({ success: false, error: 'Not your turn.' });
    if (room.claimedPits[pitName] !== undefined) return cb({ success: false, error: 'Pit already claimed.' });

    const claimer = getPlayerById(room, playerId);

    // Claim the pit for the claimer's team
    room.claimedPits[pitName] = claimer.team;
    room.lastPitClaim = { pitName, team: claimer.team, claimerName: claimer.name, valid: true };
    addLog(room, `[DEBUG] ${claimer.name} force-claimed ${pitName}!`);
    removePitCardsFromHands(room, pitName);

    // Empty the claimer's hand entirely
    room.hands[playerId] = [];

    checkAllDropouts(room);
    if (checkGameOver(room)) {
      finishGame(room);
    } else {
      handlePostClaim(room, playerId);
    }

    cb({ success: true });
    broadcastGameState(room);
  });

  socket.on('new-game', (_, cb) => {
    const room = getRoom(currentRoom);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.players[0].id !== playerId) return cb({ success: false, error: 'Only host can start new game.' });

    // Reset to lobby, keep players
    room.state = 'lobby';
    room.hands = {};
    room.claimedPits = {};
    room.droppedOut = new Set();
    room.lastCall = null;
    room.lastPitClaim = null;
    room.log = [];
    room.turnOrder = [];
    room.continuePlaying = false;
    room.pendingTurnChoice = null;
    // Remove bots
    room.players = room.players.filter(p => !p.id.startsWith('bot_'));
    cb({ success: true });
    io.to(currentRoom).emit('room-update', sanitizeRoomForAll(room));
    // Also send game-state so clients switch screens
    for (const p of room.players) {
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('game-state', sanitizeRoom(room, p.id));
    }
  });

  // ── Dev mode: fill room with bots and start ──────────────────────────
  socket.on('dev-fill-bots', (_, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'lobby') return cb({ success: false, error: 'Not in lobby.' });

    const botNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];
    let botIdx = 0;
    while (room.players.length < 6 && botIdx < botNames.length) {
      const idx = room.players.length;
      const team = idx % 2 === 0 ? 0 : 1;
      const botId = `bot_${Date.now()}_${botIdx}`;
      room.players.push({
        id: botId, name: botNames[botIdx], socketId: null,
        team, seatIndex: idx
      });
      room.hands[botId] = room.hands[botId] || [];
      botIdx++;
    }

    // Balance teams to 3v3
    const t0 = room.players.filter(p => p.team === 0);
    const t1 = room.players.filter(p => p.team === 1);
    let seat = 0;
    for (let i = 0; i < Math.max(t0.length, t1.length); i++) {
      if (t0[i]) { t0[i].seatIndex = seat++; }
      if (t1[i]) { t1[i].seatIndex = seat++; }
    }

    startGame(room);
    cb({ success: true });
    broadcastGameState(room);
  });

  // ── Dev mode: play a bot turn (call random card) ────────────────────
  socket.on('dev-bot-turn', (_, cb) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing') return cb({ success: false, error: 'Not playing.' });

    const currentId = room.currentTurn;
    const currentPlayer = getPlayerById(room, currentId);
    if (!currentPlayer) return cb({ success: false });

    // Check if current turn is the human player
    const humanId = playerId;
    if (currentId === humanId) return cb({ success: false, error: 'It is your turn!' });

    const hand = room.hands[currentId] || [];
    if (hand.length === 0) return cb({ success: false, error: 'Bot has no cards.' });

    // Pick a random card from bot's hand to determine pit, then ask a random opponent for a card from that pit
    const randomCard = hand[Math.floor(Math.random() * hand.length)];
    const pitName = getPitName(randomCard);

    // Find all cards in that pit that the bot doesn't have
    const pitCards = getPitCards(pitName);
    const handIds = new Set(hand.map(c => c.id));
    const askable = pitCards.filter(c => !handIds.has(c.id));

    if (askable.length === 0) {
      // Bot should claim this pit - auto-assign
      const teamIds = teamPlayers(room, currentPlayer.team).map(p => p.id);
      const assignments = pitCards.map(c => {
        for (const tid of teamIds) {
          if ((room.hands[tid] || []).some(h => h.id === c.id)) {
            return { cardId: c.id, playerId: tid };
          }
        }
        return { cardId: c.id, playerId: currentId };
      });

      let valid = true;
      for (const a of assignments) {
        if (!teamIds.includes(a.playerId)) { valid = false; break; }
        if (!(room.hands[a.playerId] || []).some(c => c.id === a.cardId)) { valid = false; break; }
      }

      if (valid) {
        room.claimedPits[pitName] = currentPlayer.team;
        addLog(room, `${currentPlayer.name} correctly claimed ${pitName} for Team ${teamName(currentPlayer.team)}!`);
        removePitCardsFromHands(room, pitName);
        checkAllDropouts(room);
        if (checkGameOver(room)) {
          finishGame(room);
        } else {
          handlePostClaim(room, currentId);
          // Auto-resolve if bot needs to choose a teammate
          if (room.pendingTurnChoice === currentId) {
            const botPlayer = getPlayerById(room, currentId);
            const teammates = activeTeamPlayers(room, botPlayer.team)
              .filter(p => p.id !== currentId && (room.hands[p.id] || []).length > 0);
            if (teammates.length > 0) {
              room.pendingTurnChoice = null;
              room.currentTurn = teammates[0].id;
              addLog(room, `${botPlayer.name} chose ${teammates[0].name} to take the turn.`);
            }
          }
        }
      } else {
        const next = getNextOpponentToLeft(room, currentId);
        if (next) room.currentTurn = next;
      }

      cb({ success: true });
      broadcastGameState(room);
      return;
    }

    const cardToAsk = askable[Math.floor(Math.random() * askable.length)];

    // Find opponents
    const opponents = room.players.filter(p =>
      p.team !== currentPlayer.team && !room.droppedOut.has(p.id)
    );
    if (opponents.length === 0) return cb({ success: false });

    const target = opponents[Math.floor(Math.random() * opponents.length)];
    const targetHand = room.hands[target.id] || [];
    const targetHasCard = targetHand.some(c => c.id === cardToAsk.id);

    if (targetHasCard) {
      room.hands[target.id] = targetHand.filter(c => c.id !== cardToAsk.id);
      room.hands[currentId] = [...hand, cardToAsk];
      addLog(room, `${currentPlayer.name} asked ${target.name} for ${cardDisplayName(cardToAsk)} — GOT IT!`);
      room.lastCall = { callerId: currentId, targetId: target.id, card: cardToAsk, success: true };
      checkPlayerShouldDropOut(room, target.id);
    } else {
      addLog(room, `${currentPlayer.name} asked ${target.name} for ${cardDisplayName(cardToAsk)} — NOPE!`);
      room.lastCall = { callerId: currentId, targetId: target.id, card: cardToAsk, success: false };
      room.currentTurn = target.id;
    }

    checkAllDropouts(room);
    if (checkGameOver(room)) finishGame(room);
    cb({ success: true });
    broadcastGameState(room);
  });
});

function removePitCardsFromHands(room, pitName) {
  const pitCards = getPitCards(pitName);
  const pitIds = new Set(pitCards.map(c => c.id));
  for (const pid in room.hands) {
    room.hands[pid] = room.hands[pid].filter(c => !pitIds.has(c.id));
  }
}

function checkAllDropouts(room) {
  for (const p of room.players) {
    if (!room.droppedOut.has(p.id)) {
      const hand = room.hands[p.id] || [];
      if (hand.length === 0 && room.currentTurn !== p.id) {
        handleDropOut(room, p.id);
      }
    }
  }
  handleTeamDropout(room);
}

function finishGame(room) {
  room.state = 'finished';
  const scores = getScores(room);
  if (scores[0] > scores[1]) {
    addLog(room, `GAME OVER! Team 1 wins ${scores[0]}-${scores[1]}!`);
  } else if (scores[1] > scores[0]) {
    addLog(room, `GAME OVER! Team 2 wins ${scores[1]}-${scores[0]}!`);
  } else {
    addLog(room, `GAME OVER! It's a tie ${scores[0]}-${scores[1]}!`);
  }
}

function sanitizeRoom(room, forPlayerId) {
  // Each player only sees their own cards
  const result = {
    code: room.code,
    state: room.state,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      seatIndex: p.seatIndex,
      cardCount: (room.hands[p.id] || []).length,
      droppedOut: room.droppedOut.has(p.id),
      disconnected: p.disconnected || false,
      isYou: p.id === forPlayerId,
    })),
    myHand: (room.hands[forPlayerId] || []).map(c => ({
      ...c,
      pit: getPitName(c),
      display: cardDisplayName(c),
    })),
    currentTurn: room.currentTurn,
    claimedPits: room.claimedPits,
    lastCall: room.lastCall ? {
      callerName: getPlayerById(room, room.lastCall.callerId)?.name,
      targetName: getPlayerById(room, room.lastCall.targetId)?.name,
      cardDisplay: cardDisplayName(room.lastCall.card),
      success: room.lastCall.success,
      invalid: room.lastCall.invalid || false,
    } : null,
    lastPitClaim: room.lastPitClaim,
    pendingTurnChoice: room.pendingTurnChoice,
    log: room.log.slice(-20),
    scores: getScores(room),
    allPits: ALL_PIT_NAMES,
    hostId: room.players[0]?.id || null,
  };
  return result;
}

function sanitizeRoomForAll(room) {
  return {
    code: room.code,
    state: room.state,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      seatIndex: p.seatIndex,
      cardCount: (room.hands[p.id] || []).length,
      droppedOut: room.droppedOut.has(p.id),
      disconnected: p.disconnected || false,
    })),
    currentTurn: room.currentTurn,
    claimedPits: room.claimedPits,
    scores: getScores(room),
    log: room.log.slice(-20),
  };
}

function broadcastGameState(room) {
  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) {
      sock.emit('game-state', sanitizeRoom(room, p.id));
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Literature server running on http://localhost:${PORT}`));
