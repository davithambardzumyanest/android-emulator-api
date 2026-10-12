// Hosts an emulator reaches directly instead of through its proxy, to save
// proxy bandwidth (residential proxies bill per GB). Same neutral-CDN list as
// browser-api's config/proxyBypassHosts.js, host entries only: the emulator's
// traffic is TLS tunnels, so only the hostname (TLS SNI) is visible and
// browser-api's "/*.js"-style path rules cannot apply here.
//
// Every host here sees the server's real IP instead of the proxy IP, so the
// list is limited to static, cookieless CDNs. Deliberately excluded: anything
// Google owns (Google could tie the server IP to the proxy IP the device uses
// for Maps/Play), analytics/ad/tracking hosts, captcha/anti-bot endpoints,
// and shared CDNs that also serve APIs (*.cloudfront.net, *.akamaized.net).
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
    'images.pexels.com'
];

// Extra hosts from EMULATOR_PROXY_BYPASS_EXTRA (comma-separated, "*"
// wildcards), appended to the list above - e.g. image-only hosts that would
// otherwise stay on the proxy.
const getDefaultBypassHosts = () => [
    ...DEFAULT_PROXY_BYPASS_HOSTS,
    ...String(process.env.EMULATOR_PROXY_BYPASS_EXTRA || '').split(',').map(host => host.trim()).filter(Boolean)
];

module.exports = { DEFAULT_PROXY_BYPASS_HOSTS, getDefaultBypassHosts };
