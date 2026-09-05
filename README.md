# Mixer Dice Table v0.6.3 — True D10 / Percentile Dice

- Rebuilt D10 as a true pentagonal trapezohedron with 10 kite faces.
- D100 uses two true D10 bodies.
- Percentile die faces are labeled 10, 20, 30, 40, 50, 60, 70, 80, 90, 100.
- Ones die faces are labeled 0 through 9.
- 100 on the tens die functions as 00 for percentile math; 100 + 0 = 100.

# Mixer Dice Table v0.4 — Discord Activity

This build keeps the v0.3.2 physics/visual d20 and adds Discord Activity integration.

## Railway variables

Set these BEFORE deploying because `VITE_DISCORD_CLIENT_ID` is baked into the frontend build:

- `VITE_DISCORD_CLIENT_ID` = Mixer Dungeon Master Discord Application / Client ID
- `DISCORD_CLIENT_SECRET` = OAuth2 Client Secret from the same Discord application
- `BOT_API_URL` = public HTTPS URL of the Mixer Dungeon Master Railway service
- `DICE_BRIDGE_SECRET` = exact same private random string used on the bot service

Do not put the Client Secret or Bridge Secret in frontend code.

## Flow

1. DM requests a roll and stores the hidden DC.
2. Player clicks **Roll 1D20 in 3D**.
3. Discord launches this Activity.
4. Activity authorizes the Discord user with `identify`.
5. Activity backend validates the user and asks the bot for that user's exact pending roll.
6. The physical d20 lands.
7. Activity backend sends the landed face to the bot through the private bridge.
8. Bot applies the character modifier, resolves hidden DC, posts success/failure, and asks the AI DM to continue.

The Activity never receives the hidden DC.


## v0.4.1 Discord click hotfix

- WebGL scene no longer receives mouse/touch events.
- Roll controls are forced above the canvas with explicit z-index.
- Roll button handles pointer, click, touch, Space, and Enter.
- Duplicate input events cannot start a second roll.
- Discord Activity initialization is guarded against accidental duplicate setup.
- Dungeon Master bot does not need to be changed for this hotfix.


## v0.4.2 diagnostic startup fix

This build intentionally keeps the roll button locked until the full Discord
Activity bridge has successfully completed all five startup stages:

1. Activity SDK startup
2. Discord guild/channel context
3. Discord user authentication
4. Dungeon Master bridge lookup
5. Exact pending roll verification

If a stage fails, the Activity displays the exact returned error code instead
of collapsing everything into "NO PENDING ROLL."

Common diagnostics include:
- NO_PENDING_ROLL
- WRONG_CHANNEL
- UNAUTHORIZED
- BAD_USER_TOKEN
- NO_CHARACTER
- NO_PARTY
- MISSING_CONTEXT
- TOKEN_EXCHANGE_FAILED

A RETRY CONNECTION button is provided after failures.

No Dungeon Master bot changes are required for this diagnostic build.


## v0.5 input-proof build

The physical d20 is now deliberately independent from the Discord pending-roll
bridge. If a click/key reaches the app, the die rolls first. Discord submission
is attempted only after the die has landed.

Visible diagnostic stages:
- EVENT RECEIVED
- ROLL REQUEST
- PHYSICS STARTED
- PHYSICS FINISHED

Supported inputs:
- inline pointerdown
- capture pointerdown
- capture mousedown
- capture click
- touchstart
- Space
- Enter
- R

If Discord verification fails, the button becomes TEST LOCAL D20 so local input
and physics can still be tested.


## v0.5.1 bridge diagnostics

The local physical d20 is confirmed working.

This build adds detailed diagnostics for the Dice Activity -> Dungeon Master
Railway bridge.

New errors:
- BOT_API_URL_MISSING
- BOT_API_URL_INVALID
- BOT_UNREACHABLE
- BOT_TIMEOUT
- BOT_NON_JSON_<status>
- UNAUTHORIZED

BOT_API_URL is also normalized automatically. If Railway contains only:
`mixer-dungeon-master-production.up.railway.app`
the server automatically treats it as HTTPS.

`/api/health` now safely reports:
- whether Discord Client ID is configured
- whether Discord Client Secret is configured
- whether BOT_API_URL is configured
- the BOT_API_URL host only (no secrets)
- whether DICE_BRIDGE_SECRET is configured
- whether the Dungeon Master `/health` endpoint is reachable

No secret values are returned.

## v0.5.2 multiplayer / voice-channel fix

The Activity channel no longer has to equal the adventure text channel.

The Activity now stores the bot's authoritative:
- unique pending roll ID
- campaign text channel ID

When the die lands, the unique pending roll ID is submitted. The Dungeon Master
finds that exact player's roll and posts the outcome back into the real campaign
text channel.

This is designed specifically for parties playing together in Discord voice chat.


## v0.5.3 — Advantage / Disadvantage
Normal checks physically roll once.

Advantage and Disadvantage physically roll the d20 twice. The Activity shows both
throws, then Advantage keeps the higher die and Disadvantage keeps the lower die.

Both raw throws are sent to the Dungeon Master, which independently recomputes
which die counts. The working v0.5.2 multiplayer/voice-channel fix is preserved.

## v0.5.4 — Admin Test Mode

- Adds a password-protected **ADMIN** button to the Dice Activity.
- Configure `DICE_ADMIN_PASSWORD` on the Mixer 3D Dice Railway service.
- Admin sessions are validated server-side, expire after 30 minutes, and are rate-limited after repeated bad passwords.
- Admin Test Mode bypasses `NO_PENDING_ROLL` and never submits local test results to the Dungeon Master campaign.
- Local test selectors: D4, D6, D8, D10, D12, D20, and D100.
- D20 preserves the current physical top-face result reader.
- Other test dice use the existing physical throw animation as a local test harness and generate an appropriately ranged test value; D100 additionally displays percentile tens + ones notation.
- Exit Test Mode returns to the normal Discord pending-roll connection flow.


## v0.6.0 — Full Physical Dice Set

Admin Test Mode now swaps the actual 3D geometry and Cannon physics body for D4, D6, D8, D10, D12, and D20. D100 rolls two physical D10 percentile dice simultaneously (tens + ones, with 00 + 0 = 100). Admin rolls remain local-only and never submit to the campaign. Normal Discord campaign rolls remain D20 and preserve v0.5.3 advantage/disadvantage behavior.


## v0.6.2 — Dice Render Hotfix

- Restored the missing Three.js halo object referenced by the render loop.
- Fixes the blank dice tray introduced in v0.6.0.
- Physical D4/D6/D8/D10/D12/D20/D100 selection remains unchanged.


## v0.6.2 — Percentile D10 shape update

- D10 geometry is stretched into a more recognizable classic pentagonal-trapezohedron RPG d10 silhouette.
- D100 uses two physical d10-shaped dice.
- The percentile tens die is visibly labeled **10, 20, 30, 40, 50, 60, 70, 80, 90, 100**.
- The ones die remains **0-9**.
- On the percentile die, the visible **100** face represents the traditional **00** face for combined D100 math; 100 + 0 resolves to 100.

## v0.6.4 — Containment + Arcane Backdrop

- Added four tall, invisible Cannon physics safety walls directly above the visible tray rim.
- Dice can bounce high but cannot leave the dice box.
- Safety walls are physics-only and never render over the table art.
- Added a dark arcane/cosmic full-page backdrop behind the 3D table and UI.
- Preserves v0.6.3 true D10 geometry and D100 percentile pair.


## v0.6.5 — Top-down D100 + supplied background
- Result camera moves to a true bird's-eye view centered over the entire tray so both percentile dice stay visible after settling.
- Top-down camera height is calculated from the tray size and current aspect ratio so the whole table fits on screen.
- D100 now uses traditional percentile faces: tens die `00,10,20,30,40,50,60,70,80,90` plus ones die `0-9`.
- `00 + 0` resolves to 100; all other combinations resolve normally (for example `70 + 8 = 78`).
- Uses the supplied purple/orange monster-hunt image as the full-page background.
- Existing tall invisible containment cage remains enabled around all four tray sides.
