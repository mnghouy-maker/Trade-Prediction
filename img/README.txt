Login screen photo
==================

The sign-in screen is a split panel: a photo/brand panel on the left and the
login form on the right. The left panel shows a photo loaded from this folder.

Expected file:
    img/login-bg.jpg

What to use:
- A crypto-wallet themed photo (hardware wallet, coins, a phone wallet app, etc.).
- Dark / moody works best so the white "CryptoPulse" logo and the bottom tagline
  stay readable. The panel is tall and narrow, so a portrait or square-ish image
  crops better than a wide one (it's shown with object-fit: cover).

Good free sources (download one, then add it here as login-bg.jpg):
- Unsplash  https://unsplash.com/s/photos/crypto-wallet
- Unsplash  https://unsplash.com/s/photos/hardware-wallet
- Pexels    https://www.pexels.com/search/crypto%20wallet/

How to set it:
1. Add your image to this folder named exactly  login-bg.jpg
   (a .jpg — if you have a .png, rename it or tell me and I'll point at the .png).
2. Commit it to the live branch (claude/charming-fermat-9ht677) and it auto-deploys.

Until login-bg.jpg exists, the left panel shows a dark gradient with a faint
wallet glyph, so it still looks intentional. The <img> tag in index.html removes
itself automatically when the file is missing.
