import { useEffect, useRef, useState } from 'react';
import type { PrinterRecord } from '@snorcal/shared';

interface Props {
  printer: PrinterRecord;
  expanded?: boolean;
}

export function CameraView({ printer, expanded }: Props) {
  const size = expanded
    ? 'w-full aspect-video'
    : 'w-60 aspect-video flex-shrink-0';

  const streamUrl = printer.cameraStreamUrl ?? null;
  const snapshotUrl = printer.cameraSnapshotUrl ?? null;
  const isWebRTC = !!streamUrl && /\/(webrtc|stream)(\?|$|\/)/.test(streamUrl);

  // Camera reachability is independent of the control-plane connection — always try.

  if (isWebRTC) {
    return <WebRTCPlayer printerId={printer.id} size={size} />;
  }
  if (streamUrl) {
    return (
      <img
        src={streamUrl}
        alt="camera"
        className={`${size} bg-black rounded object-cover`}
        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
      />
    );
  }
  if (snapshotUrl) {
    return <SnapshotPoll url={snapshotUrl} size={size} />;
  }

  // Fall back to backend-resolved per-protocol camera route
  return <BackendCameraRoute printer={printer} size={size} />;
}

function SnapshotPoll({ url, size }: { url: string; size: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const currentUrl = useRef<string | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`);
        if (!res.ok) return;
        const blob = await res.blob();
        const u = URL.createObjectURL(blob);
        const prev = currentUrl.current;
        currentUrl.current = u;
        setSrc(u);
        if (prev) URL.revokeObjectURL(prev);
      } catch {}
    };
    tick();
    timer.current = window.setInterval(tick, 3000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    };
  }, [url]);

  if (!src) {
    return (
      <div className={`${size} bg-gray-900 rounded flex items-center justify-center`}>
        <span className="text-xs text-gray-600">no signal</span>
      </div>
    );
  }
  return <img src={src} alt="camera" className={`${size} bg-black rounded object-cover`} />;
}

function BackendCameraRoute({ printer, size }: { printer: PrinterRecord; size: string }) {
  // Old default: moonraker → MJPEG via <img>; bambu/snapmaker → snapshot poll via backend
  if (printer.protocol === 'moonraker') {
    return (
      <img
        src={`/api/printers/${printer.id}/camera`}
        alt="camera"
        className={`${size} bg-black rounded object-cover`}
        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
      />
    );
  }
  return <SnapshotPoll url={`/api/printers/${printer.id}/camera`} size={size} />;
}

/**
 * go2rtc / WebRTC player. Uses backend route /api/printers/:id/webrtc as SDP
 * relay because printer endpoint has no CORS for direct browser POST.
 *
 * Flow is server-initiated (WHEP-like) — Snapmaker's go2rtc build doesn't
 * accept browser-side offers. We POST `{type:'request'}`, get back server's
 * offer, answer it, and POST the answer back along with each ICE candidate.
 */
function WebRTCPlayer({ printerId, size }: { printerId: string; size: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);

    const start = async () => {
      try {
        // 1. Request server-initiated offer
        const initRes = await fetch(`/api/printers/${printerId}/webrtc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'request' }),
        });
        if (!initRes.ok) {
          const txt = await initRes.text().catch(() => '');
          throw new Error(`Request failed: HTTP ${initRes.status}${txt ? `: ${txt.slice(0, 120)}` : ''}`);
        }
        const offer = await initRes.json();
        if (cancelled) return;
        const remoteId: string = offer.id;
        const offerSdp: string = offer.sdp;

        // 2. Build PeerConnection using iceServers from offer if present
        const pc = new RTCPeerConnection({
          iceServers: Array.isArray(offer.iceServers) ? offer.iceServers : [],
        });
        pcRef.current = pc;

        pc.ontrack = (e) => {
          if (cancelled) return;
          console.debug('[webrtc] ontrack', e.track.kind);
          const v = videoRef.current;
          if (v && e.streams[0] && v.srcObject !== e.streams[0]) {
            v.srcObject = e.streams[0];
            v.play().catch((err) => console.warn('[webrtc] play() failed', err));
          }
        };

        // Server may open a keepalive datachannel — respond to pings.
        pc.ondatachannel = (e) => {
          if (e.channel.label === 'keepalive') {
            e.channel.onmessage = () => { try { e.channel.send('pong'); } catch {} };
          }
        };

        // 3. Trickle ICE: forward each candidate to server (matches Snapmaker player)
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            fetch(`/api/printers/${printerId}/webrtc`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'remote_candidate', id: remoteId, candidates: [e.candidate] }),
            }).catch(() => {});
          }
        };

        pc.oniceconnectionstatechange = () => console.debug('[webrtc] ice', pc.iceConnectionState);
        pc.onconnectionstatechange = () => {
          console.debug('[webrtc] conn', pc.connectionState);
          if (pc.connectionState === 'connected') setLoading(false);
          if (pc.connectionState === 'failed') setError('Connection failed');
        };

        // 4. Apply server offer, build answer, POST immediately (no ICE wait — trickle handles it)
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.debug('[webrtc] posting answer, sdp len=', pc.localDescription!.sdp.length);

        const ansRes = await fetch(`/api/printers/${printerId}/webrtc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: pc.localDescription!.type, id: remoteId, sdp: pc.localDescription!.sdp }),
        });
        if (!ansRes.ok) {
          const txt = await ansRes.text().catch(() => '');
          throw new Error(`Answer POST failed: HTTP ${ansRes.status}${txt ? `: ${txt.slice(0, 120)}` : ''}`);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    };

    start();
    return () => {
      cancelled = true;
      const pc = pcRef.current;
      if (pc) {
        try { pc.close(); } catch {}
        pcRef.current = null;
      }
    };
  }, [printerId]);

  if (error) {
    return (
      <div className={`${size} bg-gray-900 rounded flex items-center justify-center`}>
        <span className="text-[10px] text-red-400 truncate px-2">{error}</span>
      </div>
    );
  }
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className={`${size} bg-black rounded object-cover ${loading ? 'opacity-30' : ''}`}
    />
  );
}
