# Ho Ho Hold'em

Online Christmas poker tournament for about 15 remote players, with a reversed strip poker rule: fold the best hand to a bluff and you get a strike (one extra piece of clothing).

No dependencies. Needs Node.js 18 or newer.

## Try it on your own laptop first

```
node server.js
```

Open http://localhost:3000/?host=santa2026 , enter your name, open the Host panel, click "Add 5 practice bots" a few times and deal. The bots play randomly, so you will see bluffs, strikes, the Naughty List table and the final results within minutes.

## Put it on Hostinger

Needs a Business or Cloud plan (those have "Node.js web app"). On a VPS it also runs, with `node server.js` behind any process manager.

1. hPanel > Websites > Add Website > Node.js web app.
2. Upload the zip of this folder (or connect a GitHub repo containing it).
3. If Hostinger asks: framework "Other" or Express, no build command, start command `npm start`, entry file `server.js`, Node 20 or 22.
4. Add an environment variable `HOST_KEY` with your own secret word. Without it the host key is `santa2026`.
5. Deploy and open the site.

## On the night

- You (host) open `https://your-site/?host=YOUR_HOST_KEY`. That link gives you the Host panel. You also play as a normal player and cannot see anyone's cards.
- Everyone else opens `https://your-site/` and types a name.
- Fill in the prize pool in the Host panel (split 50/30/20), then click "Deal the first hand".
- Host panel during the game: pause, move blinds up or down, change level length or the decision clock, add or remove a strike by hand, remove a player, end the game now (ranks by chips), reset everything.
- Somebody's laptop dies? They open the site again and type the same name, or use the personal link shown under "How to play".
- Latecomers get a full stack during the first 3 blind levels. After that they start at the Naughty List table.

## Rules built in

- No-limit Texas Hold'em, 10,000 starting chips, blinds 25/50 with ante 10, new level every 5 minutes.
- 15 players start at two tables (8 and 7). Tables are rebalanced and merge into a final table at 9 players.
- 20 seconds per decision, then an automatic check or fold. Players who are offline fold after 3 seconds and keep paying blinds.
- Strike rule: after the flop, a player bets or raises, everyone folds, and the best hand that folded to that bet was better at that moment (as if it were a showdown) than the bettor's hand. Cards are revealed with confetti, the bluffer gets a point, the player who folded the best hand gets a strike.
- Naughty List table: knocked-out players get 10,000 chips, fixed blinds 100/200 (ante 25), automatic unlimited rebuys. Best profit (chips minus buy-ins) when the main event ends wins the consolation prize. The top 3 of the main event cannot win it.
- Cards are shuffled with Node's cryptographic random generator. Hole cards are only ever sent to their owner.

## Changing things

All numbers (blind schedule, stack, seats per table, Naughty List blinds, payouts) are in `CONFIG` at the top of `game.js`.

`npm test` plays full bot tournaments and checks that chips are never created or lost.

The game state is saved to `data/state.json` every few seconds, so a server restart does not lose the game. Delete that file (or use "Reset everything") to start fresh.
