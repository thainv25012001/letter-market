# Midnight Letter Market

A real-time, 2–8 player letter-collection auction game. Each player gets a private six-letter target and $100. Win letters in timed auctions, manage your cash, and complete your target before the other contestants. The interface uses a high-contrast pixel game-show style and is designed for phone screens.

## Run locally

Requires Node.js 22 or newer.

```powershell
npm install
npm start
```

Open the local URL printed by the server, usually [http://localhost:3000](http://localhost:3000). Rooms live in the server process and reset when it stops.

To play on a second device on the same Wi-Fi network, open the LAN URL printed by the server on that device. Create a room on one screen, then enter its six-character code on each other screen. Network firewalls may need to allow connections to Node.js.

## Quick play-through

1. Enter a name and create a room.
2. On another device or browser tab, enter a name and the room code to join. Rooms support 2–8 players.
3. The host starts once at least two contestants are connected.
4. Bid at least $5, raise the current bid by at least $5, or pass before the 8-second timer ends. Bank lots only show letters that someone still needs; once all required copies are collected, the Bank stops offering that letter.
5. Every auction winner keeps the letter. Letters beyond their own target needs become surplus. Between Bank lots, one player gets a chance to sell a surplus letter; other players bid, and the winner pays the seller and receives the card. Each player gets at most one sale offer per round.
6. After the Bank lots and any player sales, anyone still collecting gets income of $10 plus 20% of current cash (rounded to the nearest dollar).
7. Keep playing until someone fills all six target slots. If players finish in the same round, the winner is decided by remaining cash, then lower total spend.

Targets and exact cash stay private during the show. The results screen reveals them after the match.
