/**
 * dsh-oceaneyes — a boot animation and a looping video wallpaper for the DSH
 * web GUI.
 *
 * Everything this plugin needs happens on the *host* side:
 *
 *  - `webserver/index-inject` puts a `<style>`, a head `<script>`, the video
 *    layer markup and its controller script straight into `index.html`, so the
 *    very first paint is the boot video instead of the React shell. Nothing
 *    depends on the client module loader, so there is no flash of UI.
 *  - a `prefix` route streams the two local video files with Range support.
 *    (The package-asset route only serves svg/png/webp/jpg/jpeg images.)
 *
 * Timeline: video A plays full-screen with no UI at all → after `splashMs` the
 * app fades in over it → when A ends, B crossfades in and loops forever as the
 * wallpaper.
 *
 * @module dsh-oceaneyes
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the package root — relative `mediaDir` values anchor here,
 * so the package is self-contained and portable across machines. */
const PKG_DIR = resolvePath(fileURLToPath(new URL('..', import.meta.url)))

/** Plugin name used by the loader. */
export const name = 'dsh-oceaneyes'

/** Services resolved before `apply` runs. */
export const inject = ['webServer']

/** Prefix of the video route served by this plugin. */
const ROUTE = '/wallpaper/media'

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
}

/** Default configuration; every key can be overridden from the patch file. */
export const DEFAULTS = {
  /** Master switch: `false` leaves the GUI completely untouched. */
  enabled: true,
  /** Directory holding the two video files. A relative path resolves against
   * the package root, so `media` (the default) ships inside the package;
   * an absolute path pins videos to any folder you like. */
  mediaDir: 'media',
  /** Boot animation, played once. */
  bootVideo: 'video1.mp4',
  /** Wallpaper, looped forever. */
  loopVideo: 'video2.mp4',
  /** How long video A is shown on its own before the app fades in (ms). */
  splashMs: 1500,
  /** Fade-in duration of the app shell (ms). */
  fadeMs: 450,
  /** Crossfade duration from video A to video B (ms). */
  crossfadeMs: 300,
  /** Full-screen tint between the wallpaper and the UI. `''` disables it. */
  scrim: 'rgba(8, 14, 28, 0.32)',
  /** `cover` fills the viewport, `contain` letterboxes. */
  objectFit: 'cover',
  /* ---- colour-tint tokens (blue-wallpaper harmony) ---- */
  /** Primary text colour — cool white with a faint blue cast. */
  textTint: '#e8f0fa',
  /** Secondary text — cool grey-blue. */
  textTintSecondary: '#b8c8dc',
  /** Tertiary / caption text — deeper cool grey-blue. */
  textTintTertiary: '#8a9ab5',
  /** Foreground text on solid brand surfaces (buttons, badges). */
  textForeground: '#0c1424',
  /** Border tint — faint blue glow. */
  borderTint: 'rgba(100, 140, 200, 0.12)',
  /** Brand / accent colour — taken from the crystal-earring blue. */
  brandColor: '#4a9ad4',
  /** Link colour — bright eye-blue. */
  linkColor: '#5ab0f0',
  /** Primary button fill — hair-blue (slightly brightened for visibility). */
  buttonPrimaryFill: '#3a6aaa',
  /** Primary button hover — slightly lighter hair-blue. */
  buttonPrimaryHover: '#4a8ad4',
  /** Opacity of the glass panels in the dark theme (0 = fully transparent UI, 1 = opaque). */
  panelAlpha: 0.62,
  /** Same, for the light theme: dark text needs a more solid white to stay readable. */
  panelAlphaLight: 0.82,
  /** Rewrite `--dsw-*` surface tokens to translucent glass. `off` disables. */
  surfaces: 'tokens',
  /** Pause the wallpaper while the tab is hidden. */
  pauseWhenHidden: true,
  /** Play the videos' own sound. Off by default: a wallpaper should stay quiet. */
  audio: false,
  /** 0..1, only used when `audio` is on. */
  volume: 0.6,
  /** `?<param>=1` in the URL skips the whole wallpaper. */
  nowallpaperParam: 'nowallpaper',
}

/**
 * Register the wallpaper with the host.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  if (!cfg.enabled) return

  for (const file of [cfg.bootVideo, cfg.loopVideo]) {
    if (!existsSync(join(cfg.mediaDir, file))) {
      ctx.logger?.warn?.(
        `dsh-oceaneyes: missing media file ${join(cfg.mediaDir, file)}`,
      )
    }
  }

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: createMediaHandler(cfg),
      })
    } catch (error) {
      // Another plugin already owns the prefix: keep the boot animation working
      // (the videos then fall back to whatever that route serves) instead of
      // taking the whole plugin row down.
      ctx.logger?.warn?.(`dsh-oceaneyes: cannot serve ${ROUTE}: ${String(error)}`)
      return () => {}
    }
  })

  ctx.on(
    'webserver/index-inject',
    (table) => {
      table.push(
        { kind: 'style', text: buildStyle(cfg) },
        { kind: 'script', placement: 'head', text: buildHeadScript(cfg) },
        { kind: 'html', placement: 'body', html: buildMarkup(cfg) },
        { kind: 'script', placement: 'body', text: buildBodyScript(cfg) },
      )
    },
    { prepend: true },
  )
}

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...input }

  cfg.enabled = cfg.enabled !== false
  cfg.mediaDir = resolvePath(PKG_DIR, String(cfg.mediaDir || DEFAULTS.mediaDir))
  cfg.bootVideo = String(cfg.bootVideo || DEFAULTS.bootVideo)
  cfg.loopVideo = String(cfg.loopVideo || DEFAULTS.loopVideo)
  cfg.splashMs = clamp(cfg.splashMs, 0, 60_000, DEFAULTS.splashMs)
  cfg.fadeMs = clamp(cfg.fadeMs, 0, 10_000, DEFAULTS.fadeMs)
  cfg.crossfadeMs = clamp(cfg.crossfadeMs, 0, 10_000, DEFAULTS.crossfadeMs)
  cfg.panelAlpha = clampFloat(cfg.panelAlpha, 0, 1, DEFAULTS.panelAlpha)
  cfg.panelAlphaLight = clampFloat(cfg.panelAlphaLight, 0, 1, DEFAULTS.panelAlphaLight)
  cfg.objectFit = cfg.objectFit === 'contain' ? 'contain' : 'cover'
  cfg.surfaces = cfg.surfaces === 'off' || cfg.surfaces === false ? 'off' : 'tokens'
  cfg.scrim = typeof cfg.scrim === 'string' ? cfg.scrim.trim() : DEFAULTS.scrim
  cfg.pauseWhenHidden = cfg.pauseWhenHidden !== false
  cfg.audio = cfg.audio === true
  cfg.volume = clampFloat(cfg.volume, 0, 1, DEFAULTS.volume)
  cfg.nowallpaperParam = String(cfg.nowallpaperParam || DEFAULTS.nowallpaperParam)

  /* colour-tint fields: accept any non-empty string, otherwise fall back. */
  const tintKeys = /** @type {const} */ ([
    'textTint', 'textTintSecondary', 'textTintTertiary', 'textForeground',
    'borderTint', 'brandColor', 'linkColor',
    'buttonPrimaryFill', 'buttonPrimaryHover',
  ])
  for (const k of tintKeys) {
    const v = cfg[k]
    cfg[k] = (typeof v === 'string' && v.trim().length > 0) ? v.trim() : DEFAULTS[k]
  }

  return cfg
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Same as {@link clamp}, but keeps fractional values (opacity and friends). */
function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/* -------------------------------------------------------------------------- */
/* media route                                                                */
/* -------------------------------------------------------------------------- */

function createMediaHandler(cfg) {
  const allowed = new Set([cfg.bootVideo, cfg.loopVideo])

  return function mediaHandler(req, res) {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }

    const rel = (pathname.startsWith(ROUTE) ? pathname.slice(ROUTE.length) : pathname)
      .replace(/^\/+/, '')

    if (!rel || rel.includes('/') || rel.includes('\\') || rel.includes('..') || !allowed.has(rel)) {
      res.writeHead(404)
      res.end()
      return
    }

    const file = join(cfg.mediaDir, rel)
    let stat
    try {
      stat = statSync(file)
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end()
      return
    }

    const size = stat.size
    const headers = {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store, no-transform',
      etag: `"${size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
      'last-modified': stat.mtime.toUTCString(),
    }

    const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)

    if (match !== null && (match[1] !== '' || match[2] !== '')) {
      let start
      let end
      if (match[1] === '') {
        const suffix = Number(match[2])
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
          res.end()
          return
        }
        start = Math.max(0, size - suffix)
        end = size - 1
      } else {
        start = Number(match[1])
        end = match[2] === '' ? size - 1 : Number(match[2])
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
          res.end()
          return
        }
        end = Math.min(end, size - 1)
      }

      res.writeHead(206, {
        ...headers,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
      })
      if (method === 'HEAD') {
        res.end()
        return
      }
      stream(res, file, { start, end })
      return
    }

    res.writeHead(200, { ...headers, 'content-length': size })
    if (method === 'HEAD') {
      res.end()
      return
    }
    stream(res, file, {})
  }
}

function stream(res, file, options) {
  const source = createReadStream(file, options)
  source.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.destroy()
  })
  res.on('close', () => source.destroy())
  source.pipe(res)
}

/* -------------------------------------------------------------------------- */
/* injected markup                                                            */
/* -------------------------------------------------------------------------- */

function buildStyle(cfg) {
  const fade = `${cfg.fadeMs}ms`
  const crossfade = `${cfg.crossfadeMs}ms`
  const scrim = cfg.scrim === '' ? 'transparent' : cfg.scrim
  const tints = {
    textTint: cfg.textTint,
    textTintSecondary: cfg.textTintSecondary,
    textTintTertiary: cfg.textTintTertiary,
    textForeground: cfg.textForeground,
    borderTint: cfg.borderTint,
    brandColor: cfg.brandColor,
    linkColor: cfg.linkColor,
    buttonPrimaryFill: cfg.buttonPrimaryFill,
    buttonPrimaryHover: cfg.buttonPrimaryHover,
  }
  const glass = glassTokens(cfg.panelAlpha, cfg.panelAlphaLight, tints)
  const surfaces = cfg.surfaces === 'off' ? '' : glass

  return `
:root{--dsh-wp-fade:${fade};--dsh-wp-xfade:${crossfade}}
html[data-dsh-wp="boot"]{background-color:#000!important}
html[data-dsh-wp="boot"] body,html[data-dsh-wp="on"] body{background-color:transparent!important;background-image:none!important}
html[data-dsh-wp]{--dsh-wp-xfade:${crossfade}}

#dsh-wp{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background-color:#000;isolation:isolate}
html[data-dsh-wp="off"] #dsh-wp{display:none!important}
#dsh-wp>video{position:absolute;inset:0;width:100%;height:100%;object-fit:${cfg.objectFit};opacity:0;background-color:#000;transition:opacity var(--dsh-wp-xfade) linear}
#dsh-wp>video.is-active{opacity:1}
#dsh-wp-scrim{position:absolute;inset:0;background:${scrim};opacity:0;transition:opacity var(--dsh-wp-fade) ease}
html[data-dsh-wp="on"] #dsh-wp-scrim{opacity:1}

html[data-dsh-wp] #root{transition:opacity var(--dsh-wp-fade) ease}
html[data-dsh-wp="boot"] #root{visibility:hidden!important;opacity:0!important}
html[data-dsh-wp="on"] #root{position:relative;z-index:1;visibility:visible;opacity:1}
html[data-dsh-wp="off"] #root{visibility:visible;opacity:1}

/* stop the React shell from painting its own background over the wallpaper */
html[data-dsh-wp="on"] body{color-scheme:inherit}

/*
 * Maximised right panel. The panel has no background of its own (it used to be
 * covered by the shell's opaque base), so with glass tokens the centre column
 * keeps painting its text underneath and both overlap. The panel is an overlay,
 * so the centre column is simply not shown while it is maximised — the closed
 * column is the previous sibling of the right column, which :has(+ ...) can
 * target without depending on any hashed class name.
 */
html[data-dsh-wp="on"] [data-rightbar-fullscreen] > div:has(+ [data-rightbar-col]){visibility:hidden!important}

${surfaces}
`.trim()
}

/**
 * Translucent replacements for the surface-side `--dsw-*` tokens, plus
 * colour-tint overrides that harmonise text / border / brand tokens with a
 * blue-toned wallpaper.
 *
 * The light theme needs a higher alpha than the dark one: dark text on
 * translucent white over a busy video washes out long before light text on
 * translucent black does.
 *
 * @param {number} alpha dark-theme panel opacity
 * @param {number} lightAlpha light-theme panel opacity
 * @param {object} tints colour-tint overrides (text / border / brand / …)
 */
function glassTokens(alpha, lightAlpha = alpha, tints) {
  const a = (factor) => Math.min(1, Math.max(0, alpha * factor)).toFixed(3)

  /* Derive border-l2/l3/l4 as progressively lighter versions of borderTint. */
  const borderBase = tints.borderTint
  const borderL2 = borderBase.replace(/[\d.]+\)$/, m => {
    const n = parseFloat(m)
    return (Math.min(1, n * 1.4)).toFixed(2) + ')'
  })
  const borderL3 = borderBase.replace(/[\d.]+\)$/, m => {
    const n = parseFloat(m)
    return (Math.min(1, n * 2.0)).toFixed(2) + ')'
  })
  const borderL4 = borderBase.replace(/[\d.]+\)$/, m => {
    const n = parseFloat(m)
    return (Math.min(1, n * 2.8)).toFixed(2) + ')'
  })

  return `
html[data-dsh-wp="on"] body[data-ds-dark-theme]{
  /* ---- surfaces (blue-tinted glass) ---- */
  --dsw-alias-bg-base:transparent;
  --dsw-specific-sidebar-fill:rgba(12,18,32,${a(0.92)});
  --dsw-alias-bg-layer-1:rgba(16,24,40,${a(0.9)});
  --dsw-alias-bg-layer-2:rgba(22,32,52,${a(1)});
  --dsw-alias-bg-layer-3:rgba(30,42,64,${a(1.08)});
  --dsw-specific-input-major:rgba(22,32,52,${a(1)});
  --dsw-specific-bubble:rgba(26,37,60,${a(0.85)});
  --dsw-alias-bg-module-platform:rgba(34,48,72,${a(1.05)});
  --dsw-menu-surface-fill:rgba(20,30,50,${Math.min(0.95, alpha * 1.2).toFixed(3)});
  --dsw-alias-menu-group-header-fill:rgba(24,36,56,${Math.min(0.98, alpha * 1.3).toFixed(3)});
  /* ---- text ---- */
  --dsw-alias-label-primary:${tints.textTint};
  --dsw-alias-label-secondary:${tints.textTintSecondary};
  --dsw-alias-label-tertiary:${tints.textTintTertiary};
  --dsw-alias-label-primary-foreground:${tints.textForeground};
  --dsw-alias-label-caption:${tints.textTintSecondary};
  --dsw-alias-label-dimmed:${tints.textTintTertiary};
  --dsw-alias-label-shimmer:linear-gradient(90deg,${tints.textTintTertiary},${tints.textTint},${tints.textTintTertiary});
  /* ---- borders ---- */
  --dsw-alias-border-l1:${borderBase};
  --dsw-alias-border-l2:${borderL2};
  --dsw-alias-border-l2-darkmode-thin:${borderBase.replace(/[\d.]+\)$/, m => (parseFloat(m) * 0.7).toFixed(2) + ')')};
  --dsw-alias-border-l3:${borderL3};
  --dsw-alias-border-l4:${borderL4};
  /* ---- brand & links ---- */
  --dsw-alias-brand-primary:${tints.brandColor};
  --dsw-alias-link:${tints.linkColor};
  /* ---- buttons ---- */
  --dsw-alias-button-primary-fill:${tints.buttonPrimaryFill};
  --dsw-alias-button-primary-hover:${tints.buttonPrimaryHover};
  /* ---- interactive ---- */
  --dsw-alias-interactive-bg-hover:rgba(74,154,212,0.12);
  --dsw-alias-interactive-bg-active:rgba(74,154,212,0.20);
  --dsw-alias-interactive-bg-hover-danger:rgba(212,90,106,0.12);
  /* ---- scrollbar ---- */
  --dsw-alias-scrollbar-bg-l2:rgba(20,30,50,0.5);
  --dsw-alias-scrollbar-hover-l2:rgba(40,70,110,0.7);
  /* ---- focus ring ---- */
  --dsw-focus-ring-color:${tints.brandColor};
  /* ---- tooltip / hovercard ---- */
  --dsw-alias-tooltip-bg:rgba(10,18,32,0.94);
  --dsw-alias-tooltip-key-bg:rgba(20,35,60,0.9);
  --dsw-hovercard-bg:rgba(14,22,38,0.94);
  /* ---- menu ---- */
  --dsw-specific-menu:rgba(14,22,38,0.92);
  --dsw-alias-menu-icon:${tints.textTintSecondary};
  /* ---- markdown code ---- */
  --dsw-alias-markdown-code-block:rgba(10,16,28,0.85);
  --dsw-alias-markdown-code-block-banner:rgba(16,26,44,0.9);
  --dsw-alias-markdown-inline-code:rgba(20,32,52,0.7);
  --dsw-alias-markdown-tag:rgba(30,50,80,0.6);
  /* ---- toast ---- */
  --dsw-alias-toast-bg:rgba(12,20,36,0.94);
  --dsw-alias-toast-label:${tints.textTint};
  /* ---- state colours (desaturated, blue-shifted) ---- */
  --dsw-alias-state-success-primary:#3aaa7a;
  --dsw-alias-state-success-tertiary:rgba(58,170,122,0.15);
  --dsw-alias-state-warn-primary:#d4a04a;
  --dsw-alias-state-warn-label:#e0b868;
  --dsw-alias-state-warn-tertiary:rgba(212,160,74,0.15);
  --dsw-alias-state-error-primary:#d45a6a;
  --dsw-alias-state-business-primary:${tints.brandColor};
  --dsw-alias-state-idle-primary:${tints.textTintTertiary};
  /* ---- button ghost / outline ---- */
  --dsw-alias-button-ghost-active-fill:rgba(74,154,212,0.10);
  --dsw-alias-button-ghost-active-border:rgba(74,154,212,0.25);
  --dsw-alias-button-tool-bar-fill:rgba(20,30,50,0.6);
  --dsw-alias-button-tool-bar-hover:rgba(30,50,80,0.7);
  /* ---- elevation ---- */
  --dsw-elevation-stroke-color:${borderL2};
}
html[data-dsh-wp="on"] body:not([data-ds-dark-theme]){
  /* Pre-theme state (before the ui-theme presenter writes the attribute):
     the profile is configured dark, so an early paint must already be dark
     glass — reusing the dark surfaces here prevents a light/white panel
     flash between the UI reveal and the theme landing. */
  color-scheme:dark;
  --dsw-alias-bg-base:transparent;
  --dsw-specific-sidebar-fill:rgba(12,18,32,${a(0.92)});
  --dsw-alias-bg-layer-1:rgba(16,24,40,${a(0.9)});
  --dsw-alias-bg-layer-2:rgba(22,32,52,${a(1)});
  --dsw-alias-bg-layer-3:rgba(30,42,64,${a(1.08)});
  --dsw-specific-input-major:rgba(22,32,52,${a(1)});
  --dsw-specific-bubble:rgba(26,37,60,${a(0.85)});
  --dsw-menu-surface-fill:rgba(20,30,50,${Math.min(0.95, alpha * 1.2).toFixed(3)});
  --dsw-alias-menu-group-header-fill:rgba(24,36,56,${Math.min(0.98, alpha * 1.3).toFixed(3)});
}
`.trim()
}

function buildMarkup(cfg) {
  const src = (file) => escapeAttr(`${ROUTE}/${encodeURIComponent(file)}`)
  // `muted` is what lets a browser autoplay at all; when the user opts into
  // audio the attribute is dropped and the script falls back to muted if
  // playback is refused anyway.
  const audio = cfg.audio ? ` data-audio="1" data-volume="${cfg.volume}"` : ''
  const silent = cfg.audio ? '' : ' muted'
  return [
    '<div id="dsh-wp" role="presentation" aria-hidden="true">',
    `<video id="dsh-wp-a" class="is-active"${silent} playsinline preload="auto" disablepictureinpicture${audio} data-src="${src(cfg.bootVideo)}"></video>`,
    `<video id="dsh-wp-b"${silent} playsinline preload="auto" loop disablepictureinpicture${audio} data-src="${src(cfg.loopVideo)}"></video>`,
    '<div id="dsh-wp-scrim"></div>',
    '</div>',
  ].join('')
}

/**
 * Runs in `<head>`, before the shell exists: decides whether the wallpaper is
 * active at all and installs the watchdog that guarantees the UI is never left
 * hidden.
 */
function buildHeadScript(cfg) {
  return `(function(){try{
var h=document.documentElement
var skip=false
try{
  var q=new URLSearchParams(location.search)
  skip=q.get(${js(cfg.nowallpaperParam)})==='1'||q.get('wallpaper')==='off'
  skip=skip||localStorage.getItem('dsh-oceaneyes')==='off'
}catch(e){}
if(skip){h.setAttribute('data-dsh-wp','off');return}
h.setAttribute('data-dsh-wp','boot')
setTimeout(function(){if(h.getAttribute('data-dsh-wp')==='boot'){h.setAttribute('data-dsh-wp','on');h.setAttribute('data-dsh-wp-reason','watchdog')}},${cfg.splashMs + 8000})
}catch(e){try{document.documentElement.setAttribute('data-dsh-wp','off')}catch(_){}}})()`
}

/**
 * Runs right after the video layer markup: drives the boot → wallpaper
 * timeline. Kept dependency-free and defensive — any failure reveals the UI.
 */
function buildBodyScript(cfg) {
  const client = {
    splashMs: cfg.splashMs,
    crossfadeMs: cfg.crossfadeMs,
    pauseWhenHidden: cfg.pauseWhenHidden,
  }

  return `(function(){
var CFG=${js(client)}
var h=document.documentElement
if(h.getAttribute('data-dsh-wp')!=='boot')return
var a=document.getElementById('dsh-wp-a')
var b=document.getElementById('dsh-wp-b')
if(!a||!b){h.setAttribute('data-dsh-wp','off');return}
var revealed=false,started=false,swapped=false

function play(v){
  try{
    var loud=v.getAttribute('data-audio')==='1'
    v.muted=!loud
    if(loud){var vol=parseFloat(v.getAttribute('data-volume'));if(!isFinite(vol))vol=0.6;v.volume=Math.max(0,Math.min(1,vol))}
    var p=v.play()
    if(p&&p.catch)p.catch(function(){
      /* the browser refused audible autoplay: keep the picture, drop the sound */
      try{v.muted=true;v.play()}catch(e){}
    })
  }catch(e){}
}
function reveal(reason){if(revealed)return;revealed=true;h.setAttribute('data-dsh-wp','on');h.setAttribute('data-dsh-wp-reason',reason)}
function begin(){if(started)return;started=true;setTimeout(function(){reveal('splash')},CFG.splashMs)}
function swap(){if(swapped)return;swapped=true;b.classList.add('is-active');play(b);setTimeout(function(){a.classList.remove('is-active');try{a.pause()}catch(e){}},CFG.crossfadeMs+120)}
function warn(m){try{console.warn('[dsh-oceaneyes] '+m)}catch(e){}}
/* A codec the browser cannot decode (HEVC, for instance) fires no 'error':
   the element settles on readyState>=2 with videoWidth 0 and paints black. */
function dead(v){try{return v.readyState>=2&&v.videoWidth===0}catch(e){return false}}
function bootData(){
  if(dead(a)){warn('cannot decode '+a.currentSrc+' — showing the UI instead of a black splash');reveal('undecodable');swap();return}
  setTimeout(begin,250)
}

a.addEventListener('playing',function(){if(!dead(a))begin()},{once:true})
a.addEventListener('loadeddata',bootData,{once:true})
a.addEventListener('ended',swap,{once:true})
a.addEventListener('error',function(){warn('boot video failed to load: '+a.currentSrc);reveal('boot-error');swap()},{once:true})
b.addEventListener('playing',function(){
  if(dead(b)){warn('cannot decode '+b.currentSrc+' — wallpaper disabled');h.setAttribute('data-dsh-wp','off')}
},{once:true})
b.addEventListener('error',function(){warn('wallpaper video failed to load: '+b.currentSrc)},{once:true})
setTimeout(begin,CFG.splashMs+1200)

try{a.src=a.getAttribute('data-src');b.src=b.getAttribute('data-src')}catch(e){reveal('no-media');return}
play(a)

if(CFG.pauseWhenHidden){
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){try{a.pause()}catch(e){};try{b.pause()}catch(e){};return}
    play(b.classList.contains('is-active')?b:a)
  })
}
})()`
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function js(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
