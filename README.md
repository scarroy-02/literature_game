# Literature (Card Game) Online

A web-based multiplayer version of the **Literature** card game (also known as *Fish*) for 6 players in 2 teams of 3.

<!-- ## Quick Start

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

Then open **http://localhost:3000** in your browser. -->

## Playing with Friends Online

To play this directly: https://literature.rohitroy.me/

<!-- ### Option 1: ngrok (easiest)
```bash
# Install ngrok from https://ngrok.com
ngrok http 3000
```
Share the ngrok URL with your friends.

### Option 2: Deploy to a cloud platform
Deploy to **Railway**, **Render**, **Fly.io**, or any Node.js hosting:
- Just push this folder to a Git repo and connect it to the platform
- Set the `PORT` environment variable if needed (defaults to 3000)

### Option 3: Port forwarding
Forward port 3000 on your router and share your public IP. -->

## How to Play

1. One player creates a room and shares the 5-letter **room code**
2. Other players join using the code (6 players total needed)
3. The host can swap players between teams in the lobby
4. Once all 6 players are in, the host starts the game

### Rules Summary
- 54 cards split into 9 **pits** of 6 cards each
- On your turn, ask any opponent for a specific card (you must hold another card from the same pit)
- If they have it, you get it and keep your turn. If not, the turn passes to them
- **Claim a pit** by correctly identifying which teammate holds each card in that pit
- The team that claims the most pits (out of 9) wins!

### Pits
| Pit | Cards |
|-----|-------|
| Low Hearts/Diamonds/Clubs/Spades | 2, 3, 4, 5, 6, 7 of that suit |
| High Hearts/Diamonds/Clubs/Spades | 9, 10, J, Q, K, A of that suit |
| Eights & Jokers | 8♥ 8♦ 8♣ 8♠ + Red Joker + Black Joker |

## Tech Stack
- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: Vanilla HTML/CSS/JS (single file, no build step)
