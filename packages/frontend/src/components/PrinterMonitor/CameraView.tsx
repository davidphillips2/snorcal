import { useEffect, useRef, useState } from 'react';

interface Props {
  printerId: string;
  protocol: 'moonraker' | 'bambu';
  connection: string;
  expanded?: boolean;
}

export function CameraView({ printerId, protocol, connection, expanded }: Props) {
  const size = expanded
    ? 'w-full aspect-video'
    : 'w-60 aspect-video flex-shrink-0';

  if (connection !== 'connected') {
    return (
      <div className={`${size} bg-gray-900 rounded flex items-center justify-center`}>
        <span className="text-xs text-gray-600">offline</span>
      </div>
    );
  }

  if (protocol === 'moonraker') {
    // MJPEG stream — browser handles natively
    return (
      <img
        src={`/api/printers/${printerId}/camera`}
        alt="camera"
        className={`${size} bg-black rounded object-cover`}
        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
      />
    );
  }

  // Bambu: snapshot poll every 3s
  return <BambuSnapshots printerId={printerId} size={size} />;
}

function BambuSnapshots({ printerId, size }: { printerId: string; size: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(`/api/printers/${printerId}/camera?t=${Date.now()}`);
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setSrc(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      } catch {}
    };
    tick();
    timer.current = window.setInterval(tick, 3000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      if (src) URL.revokeObjectURL(src);
    };
  }, [printerId]);

  if (!src) {
    return (
      <div className={`${size} bg-gray-900 rounded flex items-center justify-center`}>
        <span className="text-xs text-gray-600">no signal</span>
      </div>
    );
  }
  return <img src={src} alt="camera" className={`${size} bg-black rounded object-cover`} />;
}
