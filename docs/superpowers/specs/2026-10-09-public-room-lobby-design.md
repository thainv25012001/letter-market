# Public Room Lobby and Spectator Viewing — Design Spec

## Purpose

Help players find people to play with by listing rooms hosted by the same running server. Players can join rooms that are waiting for contestants and watch rooms whose match has already started. Spectators do not become contestants and receive no private player data.

## Agreed understanding

- The home screen should show rooms currently held in the server's in-memory room map.
- A waiting room with an available seat can be joined directly from the list. Joining by room code remains available.
- A room whose match has started can be opened in read-only spectator mode.
- Spectators do not occupy one of the room's 2–8 contestant seats and cannot make game actions.
- Room state and the directory update in real time over the existing WebSocket connection.
- Public room and spectator data must not expose targets, balances, or other player-specific fields.
- Completed or ended rooms remain viewable while they remain in memory, using the existing results or ended state.

## Existing system

The Node.js server owns an in-memory `Map` of rooms in `src/room-manager.js`. WebSocket clients initially receive only a `connected` message. A client must create or join a lobby to receive room snapshots. Existing snapshots are personalized: they include `viewerId` and, for an active contestant, a `self` object containing the private target, progress, surplus letters, cash, and spend. Room membership and gameplay actions are bound to a player seat. The browser has home, lobby, game, intermission, and results screens; the game view currently assumes a contestant and renders its private collection panel.

The server clears its rooms when it restarts. The directory therefore describes rooms in the current process only.

## Chosen approach

Use the existing WebSocket connection for both directory delivery and spectator viewing. On connection, an unseated client receives a room-directory snapshot. The server broadcasts a fresh snapshot to unseated clients when a room is created, its joinable capacity or phase changes, or it is removed. A user can select an available room to join as a contestant or select an in-progress room to watch.

This keeps room discovery on the same transport as game state and avoids adding a separate polling API or another connection type.

## User experience

### Home screen directory

Add an “Open rooms” section to the home screen below the existing create and join-by-code controls. Each room entry shows:

- Room code.
- Host display name.
- Contestant seats in use out of eight.
- A clear room status.
- An action appropriate to the status.

Waiting rooms with fewer than eight occupied seats show **Join**. Lobby occupancy uses the room's reserved player seats, including disconnected seats during the existing reconnect window, because those seats still count toward the server's capacity check. Full waiting rooms have no join action. Rooms in auction, offer, or intermission show **Watch**. Completed rooms open their results; ended rooms show the existing ended message. The directory includes empty, loading/connecting, and no-rooms states and announces updates accessibly.

The existing display-name field is used for direct list joins just as it is for joining by code. The six-character code flow remains unchanged.

### Spectator screens

Spectators see the same public auction, contestant roster, public letter collections, auction history, and round transitions as players. The private target/cash panel is hidden and replaced with a view-only label. Bid, pass, and surplus-sale actions are hidden or disabled. A spectator never receives a player token, seat, or `self` snapshot.

Completed-room viewing uses the existing results screen, where targets and final balances are already revealed after the match. Ended-room viewing displays the existing ended status. Returning from a watched room takes the user back to the home screen and its directory.

## Server and message flow

1. On WebSocket connection, the server sends `connected` followed by a `roomDirectory` message containing public summaries for rooms in memory.
2. The room manager broadcasts a fresh `roomDirectory` snapshot to unseated, non-spectating sockets after room creation, contestant join, lobby occupancy changes, room phase changes, and room removal.
3. A list join uses the existing `{ type: "join", name, code }` message. The server rechecks phase and capacity at action time, so a stale directory cannot bypass room rules.
4. A watch action uses `{ type: "watch", code }`. The server verifies that the room still exists and has started or ended, then binds the socket as a spectator and sends a public-only room snapshot.
5. Room broadcasts include both contestants and connected spectators. The spectator snapshot is generated without a viewer/player identity and without private player data.
6. A spectator returning to the home screen sends `{ type: "unwatch" }`. The server removes the room subscription and responds with a fresh directory snapshot on the same socket.
7. On socket close, the spectator subscription is removed. Spectators do not enter the reconnect-seat lifecycle.
8. Unknown or stale room requests return a readable error; the browser keeps the user on the home screen and refreshes the directory after an error that may indicate stale state.

Directory summaries contain only room code, host display name, occupied seat count, capacity, and public phase/status. They do not contain player identifiers, targets, inventories, cash, spend, tokens, or private progress.

## Snapshot and privacy rules

- Continue using personalized snapshots for contestants.
- Add a public snapshot path for spectators that has no `self` object and no contestant `viewerId`.
- Public snapshot players may include only the existing public fields: name, connection state, host marker, and collected letters.
- During a match, targets, matched target slots, cash, spend, surplus options, and reconnect tokens stay private.
- At the completed phase, the existing results payload may reveal targets and final balances, matching the current player results screen.
- Spectator sockets are not recorded in `room.players`, do not affect minimum-player/start conditions, and cannot invoke `start`, `raise`, `pass`, `offer`, or `passOffer`.
- A socket watching a room must send `unwatch` and return to directory mode before it can create or join another room.

## Failure and lifecycle behavior

- A room can change between directory delivery and selection. The server is authoritative and rejects a stale join or watch request without changing room state.
- Joining a room that started in the meantime returns the existing “show already started” style error; the user can select **Watch** from the refreshed directory.
- A watched room that ends continues to broadcast its ended/results snapshot while it remains in memory.
- A watched room is no longer listed if it is removed from the server's room map.
- A lost spectator connection follows the normal browser reconnect behavior and returns to the directory, unless the user has a valid player seat resume record.

## Files expected to change

- `src/room-manager.js` — directory snapshots and broadcasts, spectator bindings, public spectator snapshots, and action authorization.
- `public/index.html` — home-screen room directory and spectator/view-only UI affordances.
- `public/client.js` — directory rendering, join/watch actions, spectator-aware screens, and navigation back to the directory.
- `public/styles.css` — responsive styling for room entries and view-only states.
- `README.md` — explain same-server room discovery and read-only viewing.

`src/game.js` does not need to change because spectator mode observes existing public game state without changing game rules.

## Acceptance criteria

1. A newly connected home-screen client receives a directory of rooms in the current server process.
2. Creating a room, joining a room, removal of an expired lobby seat, starting a match, and ending/removing a room update the directory for unseated clients.
3. A user can join a waiting room from the directory using the existing display-name input, and existing capacity and phase validation remain authoritative.
4. A user can watch a started room without consuming a contestant seat; the view updates with the same public state as the players.
5. A spectator sees no target, private progress, cash, spend, surplus choices, or enabled game actions during a live match.
6. Spectators can view completed results and ended-room status while those rooms remain in memory.
7. Spectators do not affect host permissions, connected contestant count, start eligibility, or game rules.
8. The room-code join flow continues to work.
9. Directory loading, empty, stale-room, full-room, and connection-loss states are understandable and usable on phone-width screens.

## Out of scope

- Internet-wide discovery across different server processes or persistent room listings.
- Accounts, matchmaking, chat, spectator interaction, or promotion from spectator to contestant after a match starts.
- Server persistence or a room-retention policy beyond the current in-memory lifecycle.
- Changes to auction rules or game balancing.
