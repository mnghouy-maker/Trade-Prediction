# Golden Spin — private casino (slot game)

A small members-only casino site. First game is a 3-reel slot machine.
Everything runs on virtual credits — there is no payment processing. You
(the admin) load and remove credits for each customer by hand.

Note: if you ever want to attach real money to this, you need a gambling
license in whatever country you operate in. Don't skip that.

## Run it

From the repo root:

    npm install     # only needed once (uses the same express as the dashboard)
    npm run casino

Then open:

- Game:  http://localhost:8090
- Admin: http://localhost:8090/admin

Port can be changed with the CASINO_PORT environment variable.

## First login

On the very first run the server creates the admin account and prints the
credentials to the console:

    username: admin
    password: ChangeMe123

Log in at the game page — admins get sent to the admin panel automatically.
Change the password right away (Admin panel > My account). You can also set
the initial password with the CASINO_ADMIN_PASSWORD environment variable
before the first run.

## How access works

- Customers cannot register themselves. You create every account in the
  admin panel (username + password + starting balance) and hand the
  credentials to the customer.
- Disable a customer to block them instantly — they get logged out
  everywhere on their next request.
- Deleting removes the account and its history for good; prefer Disable.

## Admin panel

- Stats: customer count, active count, total customer balance, total
  wagered, house profit, spin count.
- Per customer: edit balance (set exact amount, or add/remove credits),
  enable/disable, reset password, view spin history, delete.

## The slot game

3 reels, 1 payline, bets of 1 / 5 / 10 / 25 / 50 / 100 credits. Outcomes
are decided on the server with a crypto-grade RNG, so the browser can't be
tampered with to force wins.

Paytable (multiplier on the bet):

    3x Diamond   200      3x Star   20      2x Seven   4
    3x Seven      50      3x Cherry  5      2x Cherry  2
    3x Bell       10      3x Lemon   5      2x Bell    1
                                            2x Star    1

Return to player is about 92% (house keeps ~8% over the long run), and a
spin wins something roughly 36% of the time.

## Data

Everything is stored in `casino/data/db.json` (created on first run,
gitignored). Back that file up if the customer list matters — it holds all
accounts, balances and the spin log (last 5000 spins).
