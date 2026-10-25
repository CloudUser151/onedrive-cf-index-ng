import type { OdFileObject } from '../../types'

import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'

import axios from 'axios'
import toast from 'react-hot-toast'
import dynamic from 'next/dynamic'
import { useAsync } from 'react-async-hook'
import { useClipboard } from 'use-clipboard-copy'

import { getBaseUrl } from '../../utils/getBaseUrl'
import { getExtension } from '../../utils/getFileIcon'
import { getStoredToken } from '../../utils/protectedRouteHandler'

import { DownloadButton } from '../DownloadBtnGtoup'
import { DownloadBtnContainer, PreviewContainer } from './Containers'
import FourOhFour from '../FourOhFour'
import Loading from '../Loading'
import CustomEmbedLinkMenu from '../CustomEmbedLinkMenu'

import 'plyr-react/plyr.css'

// Dynamic import to avoid ESM issues in Cloudflare
const Plyr = dynamic(() => import('plyr-react').then(mod => mod.Plyr), {
  ssr: false,
  loading: () => <Loading loadingText="Loading video player..." />
})

const VideoPlayer: FC<{
  videoName: string
  videoUrl: string
  width?: number
  height?: number
  thumbnail: string
  subtitle: string
  isFlv: boolean
  mpegts: any
  onEnded?: () => void
  autoplayNext: boolean
}> = ({ videoName, videoUrl, width, height, thumbnail, subtitle, isFlv, mpegts, onEnded, autoplayNext }) => {
  useEffect(() => {
    // Really really hacky way to inject subtitles as file blobs into the video element
    axios
      .get(subtitle, { responseType: 'blob' })
      .then(resp => {
        const track = document.querySelector('track')
        track?.setAttribute('src', URL.createObjectURL(resp.data))
      })
      .catch(() => {
        console.log('Could not load subtitle.')
      })

    if (isFlv) {
      const loadFlv = () => {
        // Really hacky way to get the exposed video element from Plyr
        const video = document.getElementById('plyr')
        const flv = mpegts.createPlayer({ url: videoUrl, type: 'flv' })
        flv.attachMediaElement(video)
        flv.load()
      }
      loadFlv()
    }
  }, [videoUrl, isFlv, mpegts, subtitle])

  // plyr-react does not forward onEnded as a native video event.
  // Attach the listener to the actual media element created by Plyr.
  useEffect(() => {
    if (!onEnded) return
    let media: HTMLVideoElement | null = null
    let observer: MutationObserver | null = null
    const attach = () => {
      const candidate = document.querySelector<HTMLVideoElement>('video#plyr')
        || document.querySelector<HTMLVideoElement>('.plyr video')
      if (candidate && candidate !== media) {
        media?.removeEventListener('ended', onEnded)
        media = candidate
        media.addEventListener('ended', onEnded)
      }
    }
    attach()
    observer = new MutationObserver(attach)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer?.disconnect()
      media?.removeEventListener('ended', onEnded)
    }
  }, [onEnded, videoUrl])

  // Explicitly request playback when a new episode page opens. Browsers may
  // reject unmuted autoplay; leave the normal Play control available in that case.
  useEffect(() => {
    if (!autoplayNext) return
    let cancelled = false
    let media: HTMLVideoElement | null = null
    let observer: MutationObserver | null = null
    const tryPlay = () => {
      const candidate = document.querySelector<HTMLVideoElement>('video#plyr')
        || document.querySelector<HTMLVideoElement>('.plyr video')
      if (!candidate || candidate === media) return
      media = candidate
      candidate.muted = false
      const start = () => {
        if (cancelled || !candidate.paused) return
        candidate.play().catch(err => {
          console.info('Browser prevented autoplay with sound:', err)
        })
      }
      candidate.addEventListener('canplay', start, { once: true })
      if (candidate.readyState >= 3) start()
    }
    tryPlay()
    observer = new MutationObserver(tryPlay)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [videoUrl, autoplayNext])

  // Common plyr configs, including the video source and plyr options
  // Keep the Plyr configuration stable when the surrounding episode controls update.
  const plyrSource = useMemo(() => ({
    type: 'video',
    title: videoName,
    poster: thumbnail,
    tracks: [{ kind: 'captions', label: videoName, src: '', default: true }],
    ...(!isFlv ? { sources: [{ src: videoUrl }] } : {}),
  }), [videoName, thumbnail, isFlv, videoUrl])
  const plyrOptions = useMemo(() => ({
    autoplay: true,
    muted: false,
    ratio: `${width ?? 16}:${height ?? 9}`,
    fullscreen: { iosNative: true },
  }), [width, height])
  return <Plyr id="plyr" source={plyrSource as any} options={plyrOptions as any} />
}

const VideoPreview: FC<{ file: OdFileObject }> = ({ file }) => {
  const router = useRouter()
  const { asPath } = router
  const advancing = useRef(false)
  const [activePath, setActivePath] = useState(asPath)
  const nextEpisodeRef = useRef<string | null>(null)
  const autoplayNextRef = useRef(true)

  useEffect(() => { nextEpisodeRef.current = nextEpisode }, [nextEpisode])
  useEffect(() => { autoplayNextRef.current = autoplayNext }, [autoplayNext])
  const [nextEpisode, setNextEpisode] = useState<string | null>(null)
  const [previousEpisode, setPreviousEpisode] = useState<string | null>(null)
  const [nextError, setNextError] = useState('')
  const [autoplayNext, setAutoplayNext] = useState(true)

  useEffect(() => {
    advancing.current = false
    nextEpisodeRef.current = null
    setNextEpisode(null)
    setPreviousEpisode(null)
    setNextError('')
    let active = true
    const loadNeighbors = async () => {
      try {
        const pathname = activePath.split('?')[0]
        const parent = pathname.substring(0, pathname.lastIndexOf('/')) || '/'
        // Next.js asPath is URL-encoded; the OneDrive API expects a decoded filesystem path.
        const decodedParent = decodeURIComponent(parent)
        const token = getStoredToken(parent) || getStoredToken(activePath)
        const headers = token ? { 'od-protected-token': token } : undefined
        const children: Array<{ name: string }> = []
        let cursor: string | undefined
        do {
          const response = await axios.get('/api', {
            params: { path: decodedParent, ...(cursor ? { next: cursor } : {}) }, headers,
          })
          children.push(...(response.data.folder?.value || []))
          cursor = response.data.next
        } while (cursor)
        const videoExtensions = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|ts|mpeg|mpg)$/i
        const videos = children.filter(c => videoExtensions.test(c.name))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        const currentName = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1))
        const index = videos.findIndex(c => c.name.normalize('NFC').toLowerCase() === currentName.normalize('NFC').toLowerCase())
        if (index < 0) throw new Error(`Current episode not found among ${videos.length} videos in folder`)
        const toPath = (name: string) => `${parent === '/' ? '' : parent}/${encodeURIComponent(name)}`
        if (active) {
          setPreviousEpisode(index > 0 ? toPath(videos[index - 1].name) : null)
          const next = index + 1 < videos.length ? toPath(videos[index + 1].name) : null
          nextEpisodeRef.current = next
          setNextEpisode(next)
        }
      } catch (error) {
        console.error('Unable to find neighboring episodes', error)
        if (active) setNextError(`Could not find adjacent episodes: ${axios.isAxiosError(error) ? `API ${error.response?.status || 'network error'}` : error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
    loadNeighbors()
    return () => { active = false }
  }, [activePath])

  const navigateEpisode = useCallback((destination: string | null) => {
    if (!destination || advancing.current) return
    advancing.current = true
    window.location.assign(destination)
  }, [])
  const playNext = useCallback(() => navigateEpisode(nextEpisode), [navigateEpisode, nextEpisode])
  // Swap the native video source instead of loading a new page. This preserves
  // the existing fullscreen player on browsers that permit source changes there.
  const onVideoEnded = useCallback(() => {
    if (!autoplayNextRef.current || advancing.current) return
    const destination = nextEpisodeRef.current
    if (!destination) return
    // FLV requires its own mpegts player; use the proven navigation fallback.
    if (/\.flv$/i.test(decodeURIComponent(destination.split('?')[0]))) {
      window.location.assign(destination)
      return
    }
    const media = document.querySelector<HTMLVideoElement>('video#plyr, .plyr video')
    if (!media) {
      window.location.assign(destination)
      return
    }
    advancing.current = true
    const parent = destination.substring(0, destination.lastIndexOf('/')) || '/'
    const token = getStoredToken(destination) || getStoredToken(parent)
    const url = `/api/raw?path=${destination}${token ? `&odpt=${encodeURIComponent(token)}` : ''}`
    // Do not change the Plyr component's source prop; change its actual media
    // element so React doesn't destroy the fullscreen player.
    media.src = url
    media.load()
    const start = () => {
      media.removeEventListener('canplay', start)
      media.muted = false
      void media.play().catch(error => console.info('Autoplay was blocked:', error))
    }
    media.addEventListener('canplay', start, { once: true })
    if (media.readyState >= 3) start()
    setActivePath(destination)
  }, [])
  const playPrevious = useCallback(() => navigateEpisode(previousEpisode), [navigateEpisode, previousEpisode])

  const hashedToken = getStoredToken(activePath)
  const clipboard = useClipboard()

  const [menuOpen, setMenuOpen] = useState(false)

  // We also format the raw video file for the in-browser player as well as all other players
  const videoUrl = `/api/raw?path=${activePath}${hashedToken ? `&odpt=${hashedToken}` : ''}`

  const isFlv = getExtension(file.name) === 'flv'
  const {
    loading,
    error,
    result: mpegts,
  } = useAsync(async () => {
    if (isFlv) {
      return (await import('mpegts.js')).default
    }
  }, [isFlv])

  return (
    <>
      <CustomEmbedLinkMenu path={activePath} menuOpen={menuOpen} setMenuOpen={setMenuOpen} />
      <PreviewContainer>
        {error ? (
          <FourOhFour errorMsg={error.message} />
        ) : loading && isFlv ? (
          <Loading loadingText={'Loading FLV extension...'} />
        ) : (
          <VideoPlayer
            videoName={file.name}
            videoUrl={`/api/raw?path=${asPath}${getStoredToken(asPath) ? `&odpt=${getStoredToken(asPath)}` : ''}`}
            width={file.video?.width}
            height={file.video?.height}
            thumbnail={`/api/thumbnail?path=${asPath}&size=large${getStoredToken(asPath) ? `&odpt=${getStoredToken(asPath)}` : ''}`}
            subtitle={`/api/raw?path=${asPath.substring(0, asPath.lastIndexOf('.'))}.vtt${getStoredToken(asPath) ? `&odpt=${getStoredToken(asPath)}` : ''}`}
            isFlv={isFlv}
            mpegts={mpegts}
            onEnded={onVideoEnded}
            autoplayNext={autoplayNext}
          />
        )}
      </PreviewContainer>

      <div className="flex flex-col items-center gap-2 my-3">
        <div className="flex flex-wrap justify-center gap-3">
          <button type="button" onClick={playPrevious} disabled={!previousEpisode}
            className="rounded bg-blue-600 px-5 py-3 text-white disabled:opacity-50">
            ← Previous Episode
          </button>
          <button type="button" onClick={() => setAutoplayNext(value => !value)}
            aria-pressed={autoplayNext}
            className={`rounded px-5 py-3 text-white ${autoplayNext ? 'bg-green-700' : 'bg-gray-600'}`}>
            Autoplay: {autoplayNext ? 'On' : 'Off'}
          </button>
          <button type="button" onClick={playNext} disabled={!nextEpisode}
            className="rounded bg-blue-600 px-5 py-3 text-white disabled:opacity-50">
            Next Episode →
          </button>
        </div>
        {nextError && <p role="alert" className="text-sm text-red-500">{nextError}</p>}
      </div>
      <DownloadBtnContainer>
        <div className="flex flex-wrap justify-center gap-2">
          <DownloadButton
            onClickCallback={() => window.open(videoUrl)}
            btnColor="blue"
            btnText={'Download'}
            btnIcon="file-download"
          />
          <DownloadButton
            onClickCallback={() => {
              clipboard.copy(`${getBaseUrl()}/api/raw?path=${asPath}${hashedToken ? `&odpt=${hashedToken}` : ''}`)
              toast.success('Copied direct link to clipboard.')
            }}
            btnColor="pink"
            btnText={'Copy direct link'}
            btnIcon="copy"
          />
          <DownloadButton
            onClickCallback={() => setMenuOpen(true)}
            btnColor="teal"
            btnText={'Customise link'}
            btnIcon="pen"
          />

          <DownloadButton
            onClickCallback={() => window.open(`iina://weblink?url=${getBaseUrl()}${videoUrl}`)}
            btnText="IINA"
            btnImage="/players/iina.png"
          />
          <DownloadButton
            onClickCallback={() => window.open(`vlc://${getBaseUrl()}${videoUrl}`)}
            btnText="VLC"
            btnImage="/players/vlc.png"
          />
          <DownloadButton
            onClickCallback={() => window.open(`potplayer://${getBaseUrl()}${videoUrl}`)}
            btnText="PotPlayer"
            btnImage="/players/potplayer.png"
          />
          <DownloadButton
            onClickCallback={() => window.open(`nplayer-http://${window?.location.hostname ?? ''}${videoUrl}`)}
            btnText="nPlayer"
            btnImage="/players/nplayer.png"
          />
          <DownloadButton
            onClickCallback={() => window.open(`intent://${getBaseUrl()}${videoUrl}#Intent;type=video/any;package=is.xyz.mpv;scheme=https;end;`)}
            btnText="mpv-android"
            btnImage="/players/mpv-android.png"
          />
        </div>
      </DownloadBtnContainer>
    </>
  )
}

export default VideoPreview
