Login screen background image
=============================

The login gate (the sign-in screen before the dashboard) uses a full-screen
background photo loaded from this folder.

Expected file:
    img/login-bg.jpg

To set or change it:
1. Add your photo to this folder named exactly  login-bg.jpg
   (a .jpg — if you have a .png, either rename it to login-bg.jpg or tell me and
   I'll point the CSS at the .png instead).
2. For a crisp result on large/4K monitors, use a high-resolution source
   (ideally ~3840x2160 or larger). The CSS scales it to cover the screen, so a
   small image will look soft when stretched.

The image is referenced in css/styles.css under the "LOGIN GATE" section:
    background-image: ... url("../img/login-bg.jpg");

Until login-bg.jpg is present, the login screen falls back to a solid dark
background so it still looks intentional.
