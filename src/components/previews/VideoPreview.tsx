import type { OdFileObject } from '../../types'

import { FC, useEffect, useRef, useState } from 'react'
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
}> = ({ videoName, videoUrl, width, height, thumbnail, subtitle, isFlv, mpegts, onEnded }) => {
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

  // Common plyr configs, including the video source and plyr options
  const plyrSource = {
    type: 'video',
    title: videoName,
    poster: thumbnail,
    tracks: [{ kind: 'captions', label: videoName, src: '', default: true }],
  }
  const plyrOptions = {
    autoplay: true,
    muted: false,
    ratio: `${width ?? 16}:${height ?? 9}`,
    fullscreen: { iosNative: true },
  }
  if (!isFlv) {
    // If the video is not in flv format, we can use the native plyr and add sources directly with the video URL
    plyrSource['sources'] = [{ src: videoUrl }]
  }
  return <Plyr id="plyr" source={plyrSource as any} options={plyrOptions as any}/>
}

const VideoPreview: FC<{ file: OdFileObject }> = ({ file }) => {
  const router = useRouter()
  const { asPath } = router
  const advancing = useRef(false)
  useEffect(() => { advancing.current = false }, [asPath])

  const playNext = async () => {
    if (advancing.current) return
    advancing.current = true
    try {
      const pathname = asPath.split('?')[0]
      const parent = pathname.substring(0, pathname.lastIndexOf('/')) || '/'
      const token = getStoredToken(parent) || getStoredToken(asPath)
      const headers = token ? { 'od-protected-token': token } : undefined
      const children: Array<{ name: string; file?: unknown; video?: unknown }> = []
      let next: string | undefined
      do {
        const response = await axios.get('/api', {
          params: { path: parent, ...(next ? { next } : {}) }, headers,
        })
        children.push(...(response.data.folder?.value || []))
        next = response.data.next
      } while (next)
      const videoExtensions = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|ts|mpeg|mpg)$/i
      const videos = children.filter(c => c.file && (c.video || videoExtensions.test(c.name)))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      const currentName = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1))
      const index = videos.findIndex(c => c.name === currentName)
      if (index >= 0 && index + 1 < videos.length) {
        await router.push(`${parent === '/' ? '' : parent}/${encodeURIComponent(videos[index + 1].name)}`)
      } else {
        advancing.current = false
      }
    } catch (error) {
      advancing.current = false
      console.error('Unable to play next video', error)
    }
  }
  const hashedToken = getStoredToken(asPath)
  const clipboard = useClipboard()

  const [menuOpen, setMenuOpen] = useState(false)

  // OneDrive generates thumbnails for its video files, we pick the thumbnail with the highest resolution
  const thumbnail = `/api/thumbnail?path=${asPath}&size=large${hashedToken ? `&odpt=${hashedToken}` : ''}`

  // We assume subtitle files are beside the video with the same name, only webvtt '.vtt' files are supported
  const vtt = `${asPath.substring(0, asPath.lastIndexOf('.'))}.vtt`
  const subtitle = `/api/raw?path=${vtt}${hashedToken ? `&odpt=${hashedToken}` : ''}`

  // We also format the raw video file for the in-browser player as well as all other players
  const videoUrl = `/api/raw?path=${asPath}${hashedToken ? `&odpt=${hashedToken}` : ''}`

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
      <CustomEmbedLinkMenu path={asPath} menuOpen={menuOpen} setMenuOpen={setMenuOpen} />
      <PreviewContainer>
        {error ? (
          <FourOhFour errorMsg={error.message} />
        ) : loading && isFlv ? (
          <Loading loadingText={'Loading FLV extension...'} />
        ) : (
          <VideoPlayer
            key={asPath}
            videoName={file.name}
            videoUrl={videoUrl}
            width={file.video?.width}
            height={file.video?.height}
            thumbnail={thumbnail}
            subtitle={subtitle}
            isFlv={isFlv}
            mpegts={mpegts}
            onEnded={playNext}
          />
        )}
      </PreviewContainer>

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
