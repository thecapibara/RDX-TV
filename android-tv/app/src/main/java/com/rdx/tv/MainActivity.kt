package com.rdx.tv

import android.annotation.SuppressLint
import android.graphics.Color
import android.media.AudioAttributes
import android.media.SoundPool
import android.media.audiofx.LoudnessEnhancer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.AudioAttributes as Media3AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.webkit.WebViewAssetLoader
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.dnsoverhttps.DnsOverHttps
import org.json.JSONObject
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * RDX-TV v2 Lightweight Android TV Shell (32-bit armeabi-v7a & 64-bit arm64-v8a).
 * - Hardware Media3/ExoPlayer SurfaceView underneath (16MB capped buffer, OkHttp DoH, AudioFocus)
 * - Transparent Preact WebView OSD/Catalog served via WebViewAssetLoader
 * - Native OkHttp + DoH (1.1.1.1) + CookieJar + SoundPool exposed via `window.RDXAndroid`
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val MAX_HTTP_BODY_BYTES = 4L * 1024L * 1024L // 4 MB OOM guard on 32-bit TV
        private const val PLAYER_TARGET_BUFFER_BYTES = 16 * 1024 * 1024 // 16 MB max video buffer
    }

    private lateinit var webView: WebView
    private lateinit var playerView: PlayerView
    private var exoPlayer: ExoPlayer? = null
    private var loudnessEnhancer: LoudnessEnhancer? = null
    private var currentMediaUrl: String = ""
    private var currentFallbackUrl: String = ""
    private var usedFallback: Boolean = false
    private var soundPool: SoundPool? = null
    private val soundIds = ConcurrentHashMap<String, Int>()

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newFixedThreadPool(4)

    private val cookieStore = ConcurrentHashMap<String, MutableList<Cookie>>()

    private val okHttpClient: OkHttpClient by lazy {
        val bootstrapClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .build()

        val dohDns = DnsOverHttps.Builder()
            .client(bootstrapClient)
            .url("https://1.1.1.1/dns-query".toHttpUrl())
            .bootstrapDnsHosts(
                InetAddress.getByName("1.1.1.1"),
                InetAddress.getByName("1.0.0.1"),
                InetAddress.getByName("8.8.8.8")
            )
            .build()

        bootstrapClient.newBuilder()
            .dns(dohDns)
            .cookieJar(object : CookieJar {
                override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                    val list = cookieStore.getOrPut(url.host) { mutableListOf() }
                    synchronized(list) {
                        for (c in cookies) {
                            list.removeAll { it.name == c.name }
                            list.add(c)
                        }
                    }
                }

                override fun loadForRequest(url: HttpUrl): List<Cookie> {
                    val list = cookieStore[url.host] ?: return emptyList()
                    synchronized(list) {
                        return list.filter { it.expiresAt >= System.currentTimeMillis() }
                    }
                }
            })
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }

    private val progressTicker = object : Runnable {
        override fun run() {
            val p = exoPlayer ?: return
            val curSec = p.currentPosition / 1000.0
            val durSec = if (p.duration > 0) p.duration / 1000.0 else 0.0
            val bufSec = p.bufferedPosition / 1000.0
            emitPlayerEvent(
                JSONObject()
                    .put("type", "time")
                    .put("currentSec", curSec)
                    .put("durationSec", durSec)
                    .put("bufferedSec", bufSec)
            )
            mainHandler.postDelayed(this, 500)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Forward hardware TV remote Back button to JS (`rdx-tv-back`) instead of killing the Activity
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('rdx-tv-back'));",
                    null
                )
            }
        })

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
        }

        // 1. Hardware video surface underneath WebView OSD
        playerView = PlayerView(this).apply {
            useController = false
            visibility = View.GONE
            setShutterBackgroundColor(Color.BLACK)
        }
        root.addView(
            playerView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        // 2. Lightweight WebView for Preact UI + OSD
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            addJavascriptInterface(RdxAndroidBridge(), "RDXAndroid")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }
            }
        }
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        setContentView(root)
        initSoundPool()
        webView.loadUrl("https://appassets.androidplatform.net/www/index.html")
    }

    private fun initSoundPool() {
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        soundPool = SoundPool.Builder()
            .setMaxStreams(4)
            .setAudioAttributes(attrs)
            .build()

        val files = mapOf(
            "startup" to "www/startup.mp3",
            "hover" to "www/hovercard.mp3",
            "modal_open" to "www/opencard.mp3",
            "button_click" to "www/buttonclick.mp3",
            "back" to "www/buttonclick.mp3"
        )
        for ((key, path) in files) {
            try {
                assets.openFd(path).use { afd ->
                    soundPool?.load(afd, 1)?.let { id -> soundIds[key] = id }
                }
            } catch (_: Exception) {
                // Asset optional until `npm run build:android-assets` is run
            }
        }
    }

    private fun emitPlayerEvent(json: JSONObject) {
        val quoted = JSONObject.quote(json.toString())
        mainHandler.post {
            webView.evaluateJavascript(
                "window.__rdxAndroidPlayerEvent && window.__rdxAndroidPlayerEvent($quoted);",
                null
            )
        }
    }

    @OptIn(UnstableApi::class)
    private fun openNativePlayer(payloadJson: String) {
        val payload = JSONObject(payloadJson)
        val url = payload.optString("url", "")
        if (url.isEmpty()) return
        val fallbackUrl = payload.optString("fallbackUrl", "")
        val startSec = payload.optDouble("startSec", 0.0)

        releaseNativePlayer()

        // Tight 1-2GB RAM TV buffer config: capped at 16 MB (prioritize size threshold over time)
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(15_000, 30_000, 1_500, 3_000)
            .setTargetBufferBytes(PLAYER_TARGET_BUFFER_BYTES)
            .setPrioritizeTimeOverSizeThresholds(false)
            .build()

        val dataSourceFactory = OkHttpDataSource.Factory(okHttpClient)
            .setUserAgent("Mozilla/5.0 (Linux; Android 11; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

        val mediaAudioAttrs = Media3AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
            .build()

        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .setLoadControl(loadControl)
            .setAudioAttributes(mediaAudioAttrs, true)
            .setHandleAudioBecomingNoisy(true)
            .build()

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_BUFFERING -> emitPlayerEvent(
                        JSONObject().put("type", "state").put("state", "buffering")
                    )
                    Player.STATE_READY -> {
                        val dur = if (player.duration > 0) player.duration / 1000.0 else 0.0
                        emitPlayerEvent(JSONObject().put("type", "ready").put("durationSec", dur))
                        emitPlayerEvent(
                            JSONObject().put("type", "state")
                                .put("state", if (player.isPlaying) "playing" else "paused")
                        )
                    }
                    Player.STATE_ENDED -> emitPlayerEvent(
                        JSONObject().put("type", "state").put("state", "ended")
                    )
                    else -> {}
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                // Only emit playing/paused when READY so we never overwrite buffering or ended states
                if (player.playbackState == Player.STATE_READY) {
                    emitPlayerEvent(
                        JSONObject().put("type", "state")
                            .put("state", if (isPlaying) "playing" else "paused")
                    )
                }
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (videoSize.width > 0 && videoSize.height > 0) {
                    emitPlayerEvent(
                        JSONObject()
                            .put("type", "resolution")
                            .put("width", videoSize.width)
                            .put("height", videoSize.height)
                    )
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (!usedFallback && currentFallbackUrl.isNotEmpty() && currentFallbackUrl != currentMediaUrl) {
                    usedFallback = true
                    currentMediaUrl = currentFallbackUrl
                    val pos = player.currentPosition.coerceAtLeast(0L)
                    player.setMediaItem(MediaItem.fromUri(Uri.parse(currentFallbackUrl)), pos)
                    player.prepare()
                    player.playWhenReady = true
                    return
                }
                emitPlayerEvent(
                    JSONObject()
                        .put("type", "error")
                        .put("message", error.message ?: "Помилка ExoPlayer")
                )
            }
        })

        exoPlayer = player
        currentMediaUrl = url
        currentFallbackUrl = fallbackUrl
        usedFallback = false
        playerView.player = player
        playerView.visibility = View.VISIBLE

        player.setMediaItem(MediaItem.fromUri(Uri.parse(url)))
        if (startSec > 2.0) {
            player.seekTo((startSec * 1000.0).toLong())
        }
        player.prepare()
        player.playWhenReady = true
        mainHandler.post(progressTicker)
    }

    @OptIn(UnstableApi::class)
    private fun applyAspectMode(mode: String) {
        playerView.resizeMode = when (mode) {
            "fill" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            "stretch" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
            else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
        }
    }

    @OptIn(UnstableApi::class)
    private fun applyAudioBoost(percent: Int) {
        val sessionId = exoPlayer?.audioSessionId ?: return
        if (sessionId == C.AUDIO_SESSION_ID_UNSET) return
        try {
            loudnessEnhancer?.release()
            loudnessEnhancer = null
            if (percent > 100) {
                val gainMb = ((percent - 100) * 12).coerceAtMost(1500)
                loudnessEnhancer = LoudnessEnhancer(sessionId).apply {
                    setTargetGain(gainMb)
                    enabled = true
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun applySubtitleUrl(subUrl: String) {
        val player = exoPlayer ?: return
        if (currentMediaUrl.isEmpty()) return
        val pos = player.currentPosition
        val wasPlaying = player.playWhenReady
        val builder = MediaItem.Builder().setUri(Uri.parse(currentMediaUrl))
        if (subUrl.isNotEmpty()) {
            val mime = if (subUrl.endsWith(".srt", ignoreCase = true)) {
                MimeTypes.APPLICATION_SUBRIP
            } else {
                MimeTypes.TEXT_VTT
            }
            val sub = MediaItem.SubtitleConfiguration.Builder(Uri.parse(subUrl))
                .setMimeType(mime)
                .setLanguage("uk")
                .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                .build()
            builder.setSubtitleConfigurations(listOf(sub))
        }
        player.setMediaItem(builder.build(), pos)
        player.prepare()
        player.playWhenReady = wasPlaying
    }

    private fun releaseNativePlayer() {
        mainHandler.removeCallbacks(progressTicker)
        try {
            loudnessEnhancer?.release()
        } catch (_: Exception) {}
        loudnessEnhancer = null
        exoPlayer?.release()
        exoPlayer = null
        playerView.player = null
        playerView.visibility = View.GONE
    }

    override fun onPause() {
        super.onPause()
        exoPlayer?.pause()
        webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        releaseNativePlayer()
        soundPool?.release()
        ioExecutor.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    inner class RdxAndroidBridge {

        @JavascriptInterface
        fun httpRequestAsync(requestId: String, payloadJson: String) {
            ioExecutor.execute {
                val out = JSONObject()
                try {
                    val reqObj = JSONObject(payloadJson)
                    val url = reqObj.getString("url")
                    val method = reqObj.optString("method", "GET")
                    val timeoutMs = reqObj.optLong("timeoutMs", 12_000L).coerceIn(2_000L, 30_000L)
                    val bodyStr = if (reqObj.isNull("body")) null else reqObj.optString("body")
                    val headersObj = reqObj.optJSONObject("headers")

                    val builder = Request.Builder()
                        .url(url)
                        .header(
                            "User-Agent",
                            "Mozilla/5.0 (Linux; Android 11; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                        )

                    var contentType = "application/x-www-form-urlencoded; charset=UTF-8"
                    if (headersObj != null) {
                        val keys = headersObj.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            val v = headersObj.optString(k, "")
                            if (v.isNotEmpty()) {
                                builder.header(k, v)
                                if (k.equals("Content-Type", ignoreCase = true)) contentType = v
                            }
                        }
                    }

                    if (method.equals("POST", ignoreCase = true)) {
                        val body = (bodyStr ?: "").toRequestBody(contentType.toMediaTypeOrNull())
                        builder.post(body)
                    } else {
                        builder.get()
                    }

                    val callClient = okHttpClient.newBuilder()
                        .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                        .build()

                    callClient.newCall(builder.build()).execute().use { res ->
                        out.put("status", res.code)
                        out.put("ok", res.isSuccessful)
                        // Bounded 4MB read prevents 32-bit OOM on unexpected huge responses
                        val text = res.peekBody(MAX_HTTP_BODY_BYTES).string()
                        out.put("text", text)
                        out.put("finalUrl", res.request.url.toString())
                        out.put("dohBypass", true)
                    }
                } catch (e: Exception) {
                    out.put("error", e.message ?: "Network error")
                }

                val reqIdQuoted = JSONObject.quote(requestId)
                val outQuoted = JSONObject.quote(out.toString())
                mainHandler.post {
                    webView.evaluateJavascript(
                        "window.__rdxAndroidHttpCallback && window.__rdxAndroidHttpCallback($reqIdQuoted, $outQuoted);",
                        null
                    )
                }
            }
        }

        @JavascriptInterface
        fun playSound(key: String) {
            val id = soundIds[key] ?: return
            soundPool?.play(id, 0.5f, 0.5f, 1, 0, 1.0f)
        }

        @JavascriptInterface
        fun playerOpen(payloadJson: String) {
            mainHandler.post { openNativePlayer(payloadJson) }
        }

        @JavascriptInterface
        fun playerPlay() {
            mainHandler.post { exoPlayer?.play() }
        }

        @JavascriptInterface
        fun playerPause() {
            mainHandler.post { exoPlayer?.pause() }
        }

        @JavascriptInterface
        fun playerSeek(seconds: Double) {
            mainHandler.post { exoPlayer?.seekTo((seconds * 1000.0).toLong().coerceAtLeast(0L)) }
        }

        @JavascriptInterface
        fun playerSetSpeed(rate: Double) {
            mainHandler.post { exoPlayer?.playbackParameters = PlaybackParameters(rate.toFloat()) }
        }

        @JavascriptInterface
        fun playerSetAspectMode(mode: String) {
            mainHandler.post { applyAspectMode(mode) }
        }

        @JavascriptInterface
        fun playerSetAudioBoost(percent: Int) {
            mainHandler.post { applyAudioBoost(percent) }
        }

        @JavascriptInterface
        fun playerSetSubtitle(url: String) {
            mainHandler.post { applySubtitleUrl(url) }
        }

        @JavascriptInterface
        fun playerClose() {
            mainHandler.post { releaseNativePlayer() }
        }

        @JavascriptInterface
        fun exitApp() {
            mainHandler.post { finish() }
        }
    }
}
