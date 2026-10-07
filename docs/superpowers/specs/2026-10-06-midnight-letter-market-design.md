# Midnight Letter Market — Design Spec

## Purpose

Build a playable, local-first real-time party game for 2–8 players. Players use separate browser devices to join a room by code, then compete in a pixel-art late-night game show auction. The first version should make the full core loop playable locally; visual polish can follow after the game can be tried.

## Agreed game concept

Each player receives a secret six-letter target, including possible repeated letters, and starts with $100. The Bank auctions letter lots in open, turn-by-turn auctions. Players infer what opponents need from their bids, decide when to spend, and collect matching letters. The first player to complete their target wins.

The presentation uses pixel-game styling throughout, including the lobby, game screen, and results. Controls and text must remain readable and usable on phones.

## Core rules

1. A room supports 2–8 players. One player creates the room and shares the displayed room code. Other players enter that code on their own devices. The room creator starts the match when at least two players have joined.
2. At match start, the server gives each player a private six-letter multiset target and $100. Targets are randomized with reasonable overlap so letter auctions can be contested. A player can see their own target and progress; opponents cannot see the target or exact collection.
3. Each round contains one letter lot per player, based on the player count at round start. Lots are drawn from letters that at least one player still needs. Repeated letters can be offered in separate lots. A lot is awarded to its winner; if the winner needs that letter, it fills one missing target slot. Otherwise it is a decoy and gives no progress. An unfilled target need can be offered again in a later round, so a decoy cannot make another player's target permanently impossible.
4. Each lot uses an open ascending auction. The first bid is at least $5; each new bid must exceed the current bid by at least $5 and cannot exceed the bidder's balance. Players act in a rotating order, choosing to raise or pass. Passing removes them from that lot. The last active bidder wins and pays their bid to the Bank. If everyone passes, the lot expires without a winner. Each turn has an 8-second timer; timeout counts as pass.
5. After all lots in a round, the server checks for completed targets. If one player completed their target during that round, they win. If multiple players completed during the round, compare remaining cash, then total cash spent during the match (lower wins), then who completed first. If all three comparisons are tied, the players share the win.
6. If nobody has completed a target, every player receives income equal to $10 plus 20% of their current cash, rounded to the nearest whole dollar. Cash carries over.

Opponent cash totals are not shown in the interface. Since bids and the income rule are public, players may be able to estimate them; this is a deliberate consequence of using open auctions.

## First-version scope

- A browser game with a create-room screen, join-by-code screen, lobby, game table, and round-end/winner state.
- Real-time room membership, player identity, private target delivery, auction turns and timers, cash, income, progress, and winner selection.
- The server is authoritative for all game state and legal actions. Each client receives only its own target and private progress; opponent targets and exact letter holdings are omitted from broadcasts.
- One self-contained Node.js application serves the browser client and handles WebSocket messages. Rooms live in server memory and are cleared when the server restarts. No external account or service configuration is required.
- The server starts locally and prints the URL to open. A browser on the same computer can test the core loop; other devices on the same network can join using the host computer's LAN address. Internet play requires deploying the server and is outside the local-first setup.
- Responsive pixel-art styling with readable type, large touch targets, and clear current-turn/timer/bid states. Art can be drawn with CSS and simple vector shapes; no external asset dependency is required.

## Screen flow

1. **Home:** create a room or join by code; show the 2–8 player limit.
2. **Lobby:** show room code, joined players, connection status, and a start button available to the room creator once two players are present.
3. **Game:** show the current lot, public auction state, whose turn it is, countdown, legal raise/pass controls, the local player's target/progress/cash, and a compact roster that does not expose opponent secrets or exact balances.
4. **Round transition:** show income or a completed-target reveal, then begin the next round or announce the winner.

## Real-time state and message flow

- A client connects to the server over WebSocket and requests a room creation or joins with a room code and display name.
- The server validates capacity, room state, player identity, bids, turn ownership, and timers. It generates targets and resolves auctions; clients never decide outcomes.
- Public room snapshots include room phase, player names/connectivity, current round and lot, current bid, active bidders, turn owner, deadline, and public auction history. Player-specific snapshots add only that player's target, matched letters, and cash.
- Client actions include create/join, ready/start, raise, pass, and reconnect/resume using a per-room player token held in that browser.
- Disconnects mark a player offline and allow 30 seconds to reconnect. A disconnected player's active turn times out as a pass. If the room creator disconnects before starting, the next connected player becomes creator. An active match ends cleanly if fewer than two players remain connected; the room can be recreated rather than persisting match state.

## Design constraints and defaults

- Auctions use a $5 minimum raise, an 8-second turn timer, and rotating first bidder. These defaults keep the interaction simple on mobile and allow a full room to keep moving.
- A round offers one lot per player who was in the room when that round began. Players who leave mid-round do not change the lot count.
- Targets are six letters long. Repeats are allowed. Target generation favors common letters and shared demand, while avoiding identical targets where possible.
- Target generation and auction inventory must not reveal a player's target through client payloads or public UI.
- An empty auction expires. It does not transfer a letter or charge anyone.
- If the server has no unmet target letters when selecting a lot, the match is resolved using the normal winner check; the next game can be started in a fresh room.

## Out of scope for the first version

- Accounts, persistent profiles, saved match history, matchmaking, chat, voice, spectators, custom target packs, monetization, and production deployment.
- Reconnecting across a server restart; live rooms are intentionally ephemeral.

## Acceptance criteria

- The app starts from a local command and prints a browser URL.
- One browser can create a room and another can join by room code.
- A room cannot start with fewer than two players or more than eight.
- A match deals private targets and starting cash and plays through timed auctions, round income, and a winner result.
- Invalid bids, out-of-turn actions, repeated passes, and late actions cannot corrupt server state.
- The server selects the winner consistently with the agreed completion and tie-break rules.
- The main flow is usable at phone width with legible text and tappable controls.
