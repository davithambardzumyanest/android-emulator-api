// Hosts an emulator reaches directly instead of through its proxy, to save
// proxy bandwidth (residential proxies bill per GB). Same neutral-CDN list as
// browser-api's config/proxyBypassHosts.js, host entries only: the emulator's
// traffic is TLS tunnels, so only the hostname (TLS SNI) is visible and
// browser-api's "/*.js"-style path rules cannot apply here.
//
// Every host here sees the server's real IP instead of the proxy IP, so the
// list is limited to hosts that only serve files (images, fonts, JS/CSS,
// media, downloads). API hosts stay on the proxy - www.google.com and
// *.googleapis.com carry Maps tiles and search mixed with API calls on the
// same connections - as do analytics/ad/tracking hosts, captcha/anti-bot
// endpoints, and shared CDNs that also serve APIs (*.cloudfront.net,
// *.akamaized.net).
//
// Override per device with the `proxyBypass` option of /devices/register
// (an array replaces this list, false sends everything through the proxy).
const DEFAULT_PROXY_BYPASS_HOSTS = [
    // Public JS/CSS library CDNs
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'fastly.jsdelivr.net',
    'unpkg.com',
    'code.jquery.com',
    'ajax.aspnetcdn.com',
    'cdn.skypack.dev',
    'esm.sh',
    'stackpath.bootstrapcdn.com',
    'maxcdn.bootstrapcdn.com',
    'cdn.tailwindcss.com',

    // Fonts and icons
    'use.fontawesome.com',
    'ka-f.fontawesome.com',
    'use.typekit.net',
    'fonts.bunny.net',

    // Site-builder static assets
    'cdn.shopify.com',
    'static.parastorage.com',
    'static.wixstatic.com',
    'static1.squarespace.com',
    'images.squarespace-cdn.com',
    'assets.squarespace.com',
    'i0.wp.com',
    'i1.wp.com',
    'i2.wp.com',
    's0.wp.com',
    'c0.wp.com',

    // Stock images
    'images.unsplash.com',
    'images.pexels.com',

    // Google file hosts: static JS/CSS/fonts/images, Maps place photos,
    // Street View, satellite tiles, Play/user images, YouTube thumbnails and
    // video, app/component/model downloads.
    '*.gstatic.com',
    'fonts.googleapis.com',
    '*.googleusercontent.com',
    '*.ggpht.com',
    'streetviewpixels-pa.googleapis.com',
    'khms*.google.com',
    '*.ytimg.com',
    '*.googlevideo.com',
    'dl.google.com',
    '*.gvt1.com'
];

module.exports = { DEFAULT_PROXY_BYPASS_HOSTS };
