export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface UploadResponse {
  id: string;
  name: string;
  faceCount: number;
  bounds: { x: number; y: number; z: number };
}

export interface SliceResponse {
  jobId: string;
}

export interface SSEEvent {
  type: 'job:progress' | 'job:completed' | 'job:failed';
  data: {
    jobId: string;
    progress?: number;
    currentStep?: string;
    exitCode?: number;
    error?: string;
  };
}
